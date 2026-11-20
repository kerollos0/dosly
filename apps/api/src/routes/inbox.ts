import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { conversationUpdateSchema, decrypt, GraphError, isWindowOpen, quickReplySchema, sendMessageSchema, sendWhatsAppText } from '@dosly/shared';
import type { AuthContext } from '../auth.js';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';

const listQuery = z.object({
  clientId: z.string().optional(),
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
  mine: z.coerce.boolean().optional(),
  cursor: z.string().optional(), // id of the last conversation from the previous page
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const inboxRoutes: FastifyPluginAsync = async app => {
  const { db, key, realtime } = app.deps;

  async function loadConversation(auth: AuthContext, id: string) {
    const conv = await db.conversation.findFirst({ where: { id, agencyId: auth.agencyId }, include: { waNumber: true, contact: true } });
    if (!conv) throw new HttpError(404, 'المحادثة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, conv.clientId);
    return conv;
  }

  app.get('/conversations', async req => {
    const auth = requireAuth(req);
    const q = listQuery.parse(req.query);
    const visible = await visibleClientIds(db, auth);
    if (q.clientId && visible !== 'all' && !visible.includes(q.clientId)) throw new HttpError(403, 'العميل ده مش متعين لك', 'forbidden');
    const items = await db.conversation.findMany({
      where: {
        agencyId: auth.agencyId,
        ...(q.clientId ? { clientId: q.clientId } : visible === 'all' ? {} : { clientId: { in: visible } }),
        ...(q.status ? { status: q.status } : {}),
        ...(q.mine ? { assigneeId: auth.userId } : {})
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { contact: { select: { name: true, waId: true } }, client: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } } }
    });
    const hasMore = items.length > q.limit;
    const page = items.slice(0, q.limit).map(c => ({ ...c, windowOpen: isWindowOpen(c.lastInboundAt) }));
    return { items: page, nextCursor: hasMore ? page.at(-1)!.id : null };
  });

  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async req => {
    const auth = requireAuth(req);
    await loadConversation(auth, req.params.id);
    const q = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const items = await db.message.findMany({
      where: { conversationId: req.params.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.before ? { cursor: { id: q.before }, skip: 1 } : {}),
      include: { sentBy: { select: { id: true, name: true } } }
    });
    const hasMore = items.length > q.limit;
    const page = items.slice(0, q.limit);
    return { items: page.reverse(), nextCursor: hasMore ? page[0]!.id : null };
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/read', async req => {
    const auth = requireAuth(req);
    await loadConversation(auth, req.params.id);
    await db.conversation.update({ where: { id: req.params.id }, data: { unreadCount: 0 } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/messages', async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await loadConversation(auth, req.params.id);
    const { body } = sendMessageSchema.parse(req.body);
    if (!isWindowOpen(conv.lastInboundAt)) throw new HttpError(409, 'عدّى أكتر من 24 ساعة على آخر رسالة من العميل. واتساب بيسمح بس برسايل Template دلوقتي.', 'window_closed');
    const msg = await db.message.create({ data: { agencyId: auth.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body, status: 'QUEUED', sentById: auth.userId } });
    try {
      const waMessageId = await sendWhatsAppText({ phoneNumberId: conv.waNumber.phoneNumberId, token: decrypt(conv.waNumber.accessTokenEnc, key), to: conv.contact.waId, body }, app.deps.fetch);
      const sent = await db.message.update({ where: { id: msg.id }, data: { waMessageId, status: 'SENT' } });
      await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: sent.createdAt, lastPreview: body.slice(0, 140), unreadCount: 0, assigneeId: conv.assigneeId ?? auth.userId } });
      await realtime.publish(auth.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: sent.id });
      await app.deps.queues.demoAfterSend?.(sent.id);
      return reply.status(201).send(sent);
    } catch (e) {
      const error = e instanceof GraphError ? e.message : 'تعذر الاتصال بواتساب';
      await db.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error } });
      throw new HttpError(502, `الرسالة متبعتتش: ${error}`, 'send_failed');
    }
  });

  app.patch<{ Params: { id: string } }>('/conversations/:id', async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await loadConversation(auth, req.params.id);
    const input = conversationUpdateSchema.parse(req.body);
    if (input.assigneeId) {
      const m = await db.membership.findUnique({ where: { agencyId_userId: { agencyId: auth.agencyId, userId: input.assigneeId } } });
      if (!m) throw new HttpError(400, 'العضو مش تابع للوكالة', 'bad_member');
    }
    const updated = await db.conversation.update({ where: { id: conv.id }, data: input });
    await audit(db, auth, 'conversation.update', 'Conversation', conv.id, input);
    await realtime.publish(auth.agencyId, { type: 'conversation.updated', conversationId: conv.id, clientId: conv.clientId });
    return updated;
  });

  app.get('/quick-replies', async req => {
    const auth = requireAuth(req);
    return db.quickReply.findMany({ where: { agencyId: auth.agencyId }, orderBy: { shortcut: 'asc' } });
  });

  app.post('/quick-replies', async (req, reply) => {
    const auth = requirePermission(req, 'clients:manage');
    const input = quickReplySchema.parse(req.body);
    const qr = await db.quickReply.upsert({ where: { agencyId_shortcut: { agencyId: auth.agencyId, shortcut: input.shortcut } }, create: { ...input, agencyId: auth.agencyId }, update: { body: input.body } });
    return reply.status(201).send(qr);
  });

  app.delete<{ Params: { id: string } }>('/quick-replies/:id', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await db.quickReply.deleteMany({ where: { id: req.params.id, agencyId: auth.agencyId } });
    return { ok: true };
  });
};
