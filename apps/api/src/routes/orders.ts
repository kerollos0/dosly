import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@dosly/db';
import { confirmationTemplate, FOLLOW_UP_WHERE, requestConfirmation } from '@dosly/core';
import { encrypt, fitsConfirmation, randomToken } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requirePermission, visibleClientIds, type AuthContext } from '../auth.js';

const n = (v: bigint | null) => (v === null ? null : Number(v));

const storeInput = z.object({
  clientId: z.string().min(1),
  kind: z.enum(['EASYORDERS', 'SHOPIFY']),
  name: z.string().trim().min(1).max(120),
  secret: z.string().trim().min(8).max(300).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('EGP')
});
const storeSettings = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  secret: z.string().trim().min(8).max(300).optional(),
  autoConfirm: z.boolean().optional(),
  waNumberId: z.string().min(1).nullable().optional(),
  confirmTemplate: z.string().min(1).max(512).nullable().optional(),
  confirmWaitMin: z.number().int().min(15).max(24 * 60).optional()
});

const ORDER_SELECT = {
  id: true, clientId: true, storeId: true, externalId: true, number: true, status: true, rawStatus: true, cod: true, paymentMethod: true, currency: true,
  totalMinor: true, shippingMinor: true, customerName: true, phone: true, city: true, address: true, items: true,
  trackingNumber: true, trackingCompany: true, trackingUrl: true, shipmentStatus: true, attribution: true,
  confirm: true, confirmSentAt: true, confirmedAt: true, confirmedBy: true, confirmError: true, followUpDoneAt: true, placedAt: true, updatedAt: true,
  campaign: { select: { id: true, name: true } }, store: { select: { name: true, kind: true } }, client: { select: { name: true } },
  contact: { select: { id: true, conversations: { select: { id: true }, take: 1, orderBy: { lastMessageAt: 'desc' } } } }
} satisfies Prisma.StoreOrderSelect;
type OrderRow = Prisma.StoreOrderGetPayload<{ select: typeof ORDER_SELECT }>;
export const publicOrder = ({ contact, totalMinor, shippingMinor, ...o }: OrderRow) => ({
  ...o, totalMinor: n(totalMinor)!, shippingMinor: n(shippingMinor)!, conversationId: contact?.conversations[0]?.id ?? null
});

export const orderRoutes: FastifyPluginAsync = async app => {
  const { db, key, env, queues, realtime } = app.deps;
  const demo = env.DEMO_MODE === 'true';
  const webhookUrl = (hookId: string) => `${env.PUBLIC_URL.replace(/\/$/, '')}/webhooks/store/${hookId}`;
  const scope = async (auth: AuthContext, clientId?: string) => {
    if (clientId) { await assertClientAccess(db, auth, clientId); return [clientId]; }
    return visibleClientIds(db, auth);
  };
  const clientWhere = (ids: string[] | 'all') => (ids === 'all' ? {} : { clientId: { in: ids } });

  // ---------- stores ----------

  /** The client's numbers and, per number, the approved templates that can confirm orders. */
  async function confirmOptions(clientId: string) {
    const numbers = await db.whatsAppNumber.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' }, select: { id: true, displayPhone: true, status: true, templates: { where: { status: 'APPROVED' }, orderBy: { name: 'asc' } } } });
    return numbers.map(num => ({ id: num.id, displayPhone: num.displayPhone, status: num.status, templates: num.templates.filter(fitsConfirmation).map(t => t.name) }));
  }

  async function storeView(id: string) {
    const s = await db.storeConnection.findUniqueOrThrow({ where: { id }, include: { client: { select: { name: true } }, _count: { select: { orders: true } } } });
    const numbers = await confirmOptions(s.clientId);
    const number = s.waNumberId ? numbers.find(x => x.id === s.waNumberId) : numbers.find(x => x.status === 'CONNECTED');
    const chosen = number ? await confirmationTemplate(db, number.id, s.confirmTemplate) : null;
    return {
      id: s.id, clientId: s.clientId, clientName: s.client.name, kind: s.kind, name: s.name, currency: s.currency, status: s.status,
      webhookUrl: webhookUrl(s.hookId), hasSecret: !!s.secretEnc, lastOrderAt: s.lastOrderAt, lastError: s.lastError, orders: s._count.orders,
      autoConfirm: s.autoConfirm, waNumberId: s.waNumberId, confirmTemplate: s.confirmTemplate, confirmWaitMin: s.confirmWaitMin,
      numbers, usingTemplate: chosen?.name ?? null, createdAt: s.createdAt
    };
  }

  app.get('/stores', async req => {
    const auth = requirePermission(req, 'channels:manage');
    const ids = await visibleClientIds(db, auth);
    const rows = await db.storeConnection.findMany({ where: { agencyId: auth.agencyId, ...clientWhere(ids) }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    return Promise.all(rows.map(r => storeView(r.id)));
  });

  app.post('/stores', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'channels:manage');
    const input = storeInput.parse(req.body);
    await assertClientAccess(db, auth, input.clientId);
    // The demo has no real store to copy a secret from, so it gets one and the simulated store uses it.
    const secret = input.secret ?? (demo ? `demo-${randomToken()}` : undefined);
    const s = await db.storeConnection.create({ data: {
      agencyId: auth.agencyId, clientId: input.clientId, kind: input.kind, name: input.name, currency: input.currency,
      hookId: randomToken().replace(/[^A-Za-z0-9]/g, '').slice(0, 32), secretEnc: secret ? encrypt(secret, key) : null
    } });
    await audit(db, auth, 'store.connect', 'StoreConnection', s.id, { kind: s.kind, name: s.name });
    return reply.status(201).send(await storeView(s.id));
  });

  const ownStore = async (auth: AuthContext, id: string) => {
    const s = await db.storeConnection.findFirst({ where: { id, agencyId: auth.agencyId } });
    if (!s) throw new HttpError(404, 'المتجر مش موجود', 'not_found');
    await assertClientAccess(db, auth, s.clientId);
    return s;
  };

  app.patch<{ Params: { id: string } }>('/stores/:id', async req => {
    const auth = requirePermission(req, 'channels:manage');
    const s = await ownStore(auth, req.params.id);
    const input = storeSettings.parse(req.body);
    if (input.waNumberId) {
      const num = await db.whatsAppNumber.findFirst({ where: { id: input.waNumberId, clientId: s.clientId } });
      if (!num) throw new HttpError(400, 'الرقم ده مش بتاع نفس العميل', 'bad_number');
    }
    await db.storeConnection.update({ where: { id: s.id }, data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.secret !== undefined && { secretEnc: encrypt(input.secret, key), lastError: null }),
      ...(input.autoConfirm !== undefined && { autoConfirm: input.autoConfirm }),
      ...(input.waNumberId !== undefined && { waNumberId: input.waNumberId }),
      ...(input.confirmTemplate !== undefined && { confirmTemplate: input.confirmTemplate }),
      ...(input.confirmWaitMin !== undefined && { confirmWaitMin: input.confirmWaitMin })
    } });
    await audit(db, auth, 'store.update', 'StoreConnection', s.id, { ...input, secret: input.secret ? 'changed' : undefined });
    return storeView(s.id);
  });

  app.delete<{ Params: { id: string } }>('/stores/:id', async req => {
    const auth = requirePermission(req, 'channels:manage');
    const s = await ownStore(auth, req.params.id);
    await db.storeConnection.delete({ where: { id: s.id } }); // its orders go with it
    await audit(db, auth, 'store.disconnect', 'StoreConnection', s.id, { name: s.name });
    return { ok: true };
  });

  // ---------- orders ----------

  const listQuery = z.object({
    clientId: z.string().min(1).optional(),
    view: z.enum(['followup', 'waiting', 'all']).default('followup'),
    q: z.string().trim().max(60).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40)
  });

  app.get('/orders', async req => {
    const auth = requirePermission(req, 'orders:view');
    const q = listQuery.parse(req.query);
    const ids = await scope(auth, q.clientId);
    const search = q.q ? q.q.replace(/[^\p{L}\p{N}#+ ]/gu, '') : '';
    const digits = search.replace(/\D/g, '');
    const where: Prisma.StoreOrderWhereInput = {
      agencyId: auth.agencyId, ...clientWhere(ids),
      ...(q.view === 'followup' ? FOLLOW_UP_WHERE : q.view === 'waiting' ? { confirm: 'SENT' } : {}),
      ...(search ? { OR: [
        { number: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-9) } }, { waId: { contains: digits.slice(-9) } }] : [])
      ] } : {})
    };
    const rows = await db.storeOrder.findMany({
      where, select: ORDER_SELECT, take: q.limit + 1,
      // Follow-ups: the oldest problem first, so nobody waits longest. Everything else: newest first.
      orderBy: q.view === 'followup' ? [{ placedAt: 'asc' }, { id: 'asc' }] : [{ placedAt: 'desc' }, { id: 'desc' }],
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {})
    });
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(publicOrder);
    return { items, nextCursor: more ? items[items.length - 1]!.id : null };
  });

  app.get('/orders/counts', async req => {
    const auth = requirePermission(req, 'orders:view');
    const { clientId } = z.object({ clientId: z.string().min(1).optional() }).parse(req.query);
    const ids = await scope(auth, clientId);
    const base = { agencyId: auth.agencyId, ...clientWhere(ids) };
    const [followUp, waiting, stores] = await Promise.all([
      db.storeOrder.count({ where: { ...base, ...FOLLOW_UP_WHERE } }),
      db.storeOrder.count({ where: { ...base, confirm: 'SENT' } }),
      db.storeConnection.count({ where: base })
    ]);
    return { followUp, waiting, stores };
  });

  const action = z.object({ action: z.enum(['confirm', 'cancel', 'resend', 'done']) });

  /** A moderator's follow-up: confirmed or cancelled on the phone, send the WhatsApp confirmation again, or just mark it dealt with. */
  app.post<{ Params: { id: string } }>('/orders/:id/action', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'orders:view');
    const { action: a } = action.parse(req.body);
    const order = await db.storeOrder.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!order) throw new HttpError(404, 'الطلب مش موجود', 'not_found');
    await assertClientAccess(db, auth, order.clientId);
    const now = new Date();
    if (a === 'resend') {
      if (order.status !== 'PENDING') throw new HttpError(409, 'الطلب ده مبقاش جديد، مش محتاج تأكيد', 'not_pending');
      if (order.confirm === 'SENT') throw new HttpError(409, 'رسالة التأكيد لسه مستنية رد العميل', 'already_waiting');
      const r = await requestConfirmation({ db, pub: realtime, onSend: id => queues.sendMessage(id) }, order.id, now);
      await audit(db, auth, 'order.confirm.resend', 'StoreOrder', order.id, { sent: r.sent });
      if (!r.sent) throw new HttpError(409, r.reason, 'not_sent');
    } else {
      const data: Prisma.StoreOrderUpdateInput = a === 'confirm' ? { confirm: 'CONFIRMED', confirmedAt: now, confirmedBy: 'agent', followUpDoneAt: now, followUpBy: { connect: { id: auth.userId } } }
        : a === 'cancel' ? { confirm: 'DECLINED', confirmedAt: now, confirmedBy: 'agent', followUpDoneAt: now, followUpBy: { connect: { id: auth.userId } } }
        : { followUpDoneAt: now, followUpBy: { connect: { id: auth.userId } } };
      await db.storeOrder.update({ where: { id: order.id }, data });
      await audit(db, auth, `order.${a}`, 'StoreOrder', order.id, { number: order.number });
    }
    await realtime.publish(auth.agencyId, { type: 'order.updated', orderId: order.id, clientId: order.clientId });
    const row = await db.storeOrder.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_SELECT });
    return publicOrder(row);
  });

  /** The customer's orders beside the chat: matched by the contact, or by the same phone at the same client. */
  app.get<{ Params: { id: string } }>('/conversations/:id/orders', async req => {
    const auth = requirePermission(req, 'orders:view');
    const conv = await db.conversation.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { clientId: true, contactId: true, contact: { select: { waId: true } } } });
    if (!conv) throw new HttpError(404, 'المحادثة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, conv.clientId);
    const hasStore = await db.storeConnection.count({ where: { clientId: conv.clientId } });
    const rows = await db.storeOrder.findMany({
      where: { clientId: conv.clientId, OR: [{ contactId: conv.contactId }, ...(conv.contact.waId ? [{ waId: conv.contact.waId }] : [])] },
      select: ORDER_SELECT, orderBy: { placedAt: 'desc' }, take: 10
    });
    return { hasStore: hasStore > 0, items: rows.map(publicOrder) };
  });
};
