import { Prisma, type Db } from '@dosly/db';
import { syncStageFromOrders } from './crm.js';
import {
  buildConfirmationTemplate, confirmAnswer, confirmFromText, fitsConfirmation, LOST_STATUSES, moneyText, parseEasyOrders, parseShopify, phoneToWaId,
  SOLD_STATUSES, statusRank, type OrderStatusName, type ParsedOrder, type StoreEvent, type Tracking
} from '@dosly/shared';
import type { Publisher } from './events.js';
import { previewText } from './media.js';

/**
 * Store orders: the webhook payload becomes a StoreOrder; a new cash-on-delivery order gets a
 * WhatsApp confirmation with two buttons; the customer's press confirms or cancels it; orders
 * nobody confirmed are flagged for a moderator to call. Every step is safe to run twice.
 */

export type OrderDeps = {
  db: Db;
  pub: Publisher;
  /** Queues a WhatsApp message for the worker to send (the confirmation, or the thank-you after a press). */
  onSend?: (messageId: string) => Promise<void>;
};

/** What the webhook route stores in WebhookEvent.payload for the worker. */
export type StoreWebhookPayload = { storeId: string; topic?: string; body: unknown };

/** Orders older than this are recorded but never sent a confirmation (a store re-sending its history). */
export const CONFIRM_MAX_AGE_MS = 48 * 3600_000;
/** A Click-to-WhatsApp chat counts for an order placed up to 7 days later (Meta's default click window). */
export const AD_CLICK_WINDOW_MS = 7 * 86400_000;

const json = (v: unknown) => v as Prisma.InputJsonValue;

// ---------- attribution ----------

/** The campaign an order came from: its utm_campaign (campaign id, then exact name), else the customer's Click-to-WhatsApp ad. */
export async function attributeOrder(db: Db, clientId: string, o: { utmCampaign: string | null; placedAt: Date }, contact: { adId: string | null; adReferredAt: Date | null } | null) {
  if (o.utmCampaign) {
    const byId = await db.adCampaign.findFirst({ where: { externalId: o.utmCampaign, adAccount: { clientId } }, select: { id: true } });
    const c = byId ?? await db.adCampaign.findFirst({ where: { name: { equals: o.utmCampaign, mode: 'insensitive' }, adAccount: { clientId } }, select: { id: true }, orderBy: { createdAt: 'desc' } });
    if (c) return { campaignId: c.id, attribution: 'utm' };
  }
  if (contact?.adId && contact.adReferredAt) {
    const gap = o.placedAt.getTime() - contact.adReferredAt.getTime();
    if (gap >= -3600_000 && gap <= AD_CLICK_WINDOW_MS) {
      const ad = await db.adAd.findFirst({ where: { externalId: contact.adId, adAccount: { clientId } }, select: { campaignId: true } });
      if (ad) return { campaignId: ad.campaignId, attribution: 'whatsapp_ad' };
    }
  }
  return { campaignId: null, attribution: null };
}

/** After an ads sync: orders that arrived before their campaign was known get matched now (last 90 days). */
export async function reattributeOrders(db: Db, clientId: string, now = new Date()) {
  const rows = await db.storeOrder.findMany({
    where: { clientId, campaignId: null, placedAt: { gte: new Date(now.getTime() - 90 * 86400_000) }, OR: [{ utmCampaign: { not: null } }, { contact: { adId: { not: null } } }] },
    select: { id: true, utmCampaign: true, placedAt: true, contact: { select: { adId: true, adReferredAt: true } } }, orderBy: { placedAt: 'desc' }, take: 2000
  });
  let matched = 0;
  for (const r of rows) {
    const a = await attributeOrder(db, clientId, r, r.contact);
    if (a.campaignId) { await db.storeOrder.update({ where: { id: r.id }, data: a }); matched++; }
  }
  return matched;
}

// ---------- ingest ----------

/** The customer's WhatsApp contact for this client: the one on a WhatsApp number, newest first. */
async function contactFor(db: Db, clientId: string, waId: string | null) {
  if (!waId) return null;
  return db.contact.findFirst({ where: { clientId, waId, waNumberId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, adId: true, adReferredAt: true } });
}

const orderData = (o: ParsedOrder, currency: string) => ({
  number: o.number.slice(0, 60), status: o.status, rawStatus: o.rawStatus?.slice(0, 60) ?? null, cod: o.cod, paymentMethod: o.paymentMethod?.slice(0, 120) ?? null,
  currency: o.currency ?? currency, totalMinor: BigInt(o.totalMinor), shippingMinor: BigInt(o.shippingMinor),
  customerName: o.customerName, phone: o.phone, waId: phoneToWaId(o.phone), city: o.city, address: o.address, items: json(o.items),
  utmSource: o.utmSource, utmCampaign: o.utmCampaign, fbclid: o.fbclid,
  ...(o.tracking ? trackingData(o.tracking) : {}),
  sourceUpdatedAt: o.updatedAt
});
const trackingData = (t: Tracking) => ({ trackingNumber: t.number?.slice(0, 120) ?? null, trackingCompany: t.company?.slice(0, 120) ?? null, trackingUrl: t.url?.slice(0, 500) ?? null, shipmentStatus: t.shipmentStatus?.slice(0, 60) ?? null });

type StoreRow = { id: string; agencyId: string; clientId: string; currency: string; autoConfirm: boolean };

/**
 * When the store itself moves an order on, the WhatsApp confirmation is settled: a store that
 * confirmed or shipped it has confirmed it; a cancelled order needs no more calls.
 */
function settleByStore(prev: { confirm: string; followUpDoneAt: Date | null }, status: OrderStatusName, now: Date) {
  const open = prev.confirm === 'SENT' || prev.confirm === 'NO_ANSWER' || prev.confirm === 'NOT_SENT';
  if (open && (SOLD_STATUSES as readonly string[]).includes(status)) return { confirm: 'CONFIRMED' as const, confirmedAt: now, confirmedBy: 'store' };
  if ((LOST_STATUSES as readonly string[]).includes(status) && prev.confirm !== 'NONE' && prev.confirm !== 'CONFIRMED' && !prev.followUpDoneAt) return { followUpDoneAt: now };
  return {};
}

const isLost = (s: string) => (LOST_STATUSES as readonly string[]).includes(s);
/** Whether a status may replace the current one: later in the order's life, or lost. A lost order stays lost. */
const forward = (from: OrderStatusName, to: OrderStatusName) => to !== from && !isLost(from) && (isLost(to) || statusRank(to) > statusRank(from));

function wantsConfirmation(store: StoreRow, order: { confirm: string; placedAt: Date }, cod: boolean, status: OrderStatusName, now: Date) {
  return store.autoConfirm && cod && status === 'PENDING' && order.confirm === 'NONE' && now.getTime() - order.placedAt.getTime() < CONFIRM_MAX_AGE_MS;
}

/**
 * Claims the order's confirmation so two deliveries at once send it once. If sending fails
 * midway the claim is given back and the error rethrown, so the job's retry sends it.
 */
async function autoConfirm(deps: OrderDeps, orderId: string, now: Date) {
  const claim = await deps.db.storeOrder.updateMany({ where: { id: orderId, confirm: 'NONE' }, data: { confirm: 'SENT', confirmSentAt: now } });
  if (!claim.count) return;
  try { await requestConfirmation(deps, orderId, now); }
  catch (e) {
    // A message saved but never handed to the sender is dropped, so the retry sends exactly one.
    const o = await deps.db.storeOrder.findUnique({ where: { id: orderId }, select: { confirm: true, confirmMessageId: true } }).catch(() => null);
    if (o?.confirm === 'SENT') {
      await deps.db.storeOrder.update({ where: { id: orderId }, data: { confirm: 'NONE', confirmSentAt: null, confirmMessageId: null } }).catch(() => {});
      if (o.confirmMessageId) await deps.db.message.deleteMany({ where: { id: o.confirmMessageId, status: 'QUEUED', waMessageId: null } }).catch(() => {});
    }
    throw e;
  }
}

/** Applies one parsed store event. Returns what happened, for logs and tests. */
export async function applyStoreEvent(deps: OrderDeps, store: StoreRow, ev: StoreEvent, now = new Date()): Promise<{ result: string; orderId?: string }> {
  const { db, pub } = deps;
  if (ev.kind === 'ignored') return { result: `ignored: ${ev.reason}` };

  if (ev.kind === 'order') {
    const o = ev.order;
    const existing = await db.storeOrder.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: o.externalId } } });
    if (existing) {
      // Deliveries repeat and arrive out of order: an older copy never overwrites a newer one.
      // The check sits in the write itself so two deliveries at once can't both pass it.
      const data = orderData(o, store.currency);
      // A copy with no timestamp never moves the status back (a re-sent "new order" after "shipped").
      const keep = !o.updatedAt && !forward(existing.status, o.status);
      const r = await db.storeOrder.updateMany({
        where: { id: existing.id, ...(o.updatedAt ? { OR: [{ sourceUpdatedAt: null }, { sourceUpdatedAt: { lt: o.updatedAt } }] } : {}) },
        data: { ...data, ...(keep ? { status: existing.status, rawStatus: existing.rawStatus } : settleByStore(existing, o.status, now)) }
      });
      if (!r.count) return { result: 'stale', orderId: existing.id };
      await syncStageFromOrders(db, existing.contactId);
      await pub.publish(store.agencyId, { type: 'order.updated', orderId: existing.id, clientId: store.clientId });
      // The first delivery may have failed after saving the order but before the confirmation went out.
      if (wantsConfirmation(store, existing, o.cod, keep ? existing.status : o.status, now)) await autoConfirm(deps, existing.id, now);
      return { result: 'updated', orderId: existing.id };
    }
    const data = orderData(o, store.currency);
    const contact = await contactFor(db, store.clientId, data.waId);
    const attribution = await attributeOrder(db, store.clientId, o, contact);
    let order;
    try {
      order = await db.storeOrder.create({ data: { ...data, ...attribution, agencyId: store.agencyId, clientId: store.clientId, storeId: store.id, externalId: o.externalId, placedAt: o.placedAt, contactId: contact?.id ?? null } });
    } catch (e) {
      // Two deliveries of the same new order at once: the other one created it, so this one updates it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return applyStoreEvent(deps, store, ev, now);
      throw e;
    }
    await db.storeConnection.update({ where: { id: store.id }, data: { lastOrderAt: now, lastError: null } });
    await syncStageFromOrders(db, order.contactId);
    await pub.publish(store.agencyId, { type: 'order.new', orderId: order.id, clientId: store.clientId });
    if (wantsConfirmation(store, order, o.cod, o.status, now)) await autoConfirm(deps, order.id, now);
    return { result: 'created', orderId: order.id };
  }

  const existing = await db.storeOrder.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: ev.externalId } } });
  if (!existing) return { result: 'unknown order' }; // placed before the store was connected
  if (ev.kind === 'status') {
    // Status events carry no time, so they only move an order forward (a late "shipped" never undoes "delivered").
    const move = forward(existing.status, ev.status);
    const data = { ...(move ? { rawStatus: ev.rawStatus.slice(0, 60), status: ev.status, ...settleByStore(existing, ev.status, now) } : {}), ...(ev.paid ? { cod: false } : {}) };
    if (!Object.keys(data).length) return { result: 'stale', orderId: existing.id };
    await db.storeOrder.update({ where: { id: existing.id }, data });
    await syncStageFromOrders(db, existing.contactId);
  } else {
    // A shipment update only moves an order forward (a late "in transit" never undoes "delivered").
    const move = !!ev.status && forward(existing.status, ev.status);
    await db.storeOrder.update({ where: { id: existing.id }, data: { ...trackingData(ev.tracking), ...(move ? { status: ev.status!, ...settleByStore(existing, ev.status!, now) } : {}) } });
    await syncStageFromOrders(db, existing.contactId);
  }
  await pub.publish(store.agencyId, { type: 'order.updated', orderId: existing.id, clientId: store.clientId });
  return { result: 'updated', orderId: existing.id };
}

/** Worker entry: one stored store webhook. */
export async function processStoreWebhook(deps: OrderDeps, payload: StoreWebhookPayload, now = new Date()) {
  const store = await deps.db.storeConnection.findUnique({ where: { id: payload.storeId } });
  if (!store) return { result: 'store gone' };
  const ev = store.kind === 'SHOPIFY' ? parseShopify(payload.topic, payload.body) : parseEasyOrders(payload.body);
  return applyStoreEvent(deps, store, ev, now);
}

// ---------- WhatsApp confirmation ----------

const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || 'حضرتك';

/** Picks the template that confirms orders on a number: the store's choice if it fits, else the first approved one that fits. */
export async function confirmationTemplate(db: Db, waNumberId: string, preferred: string | null) {
  const rows = await db.waTemplate.findMany({ where: { waNumberId, status: 'APPROVED' }, orderBy: { name: 'asc' } });
  const fits = rows.filter(fitsConfirmation);
  return (preferred ? fits.find(t => t.name === preferred) : undefined)
    ?? fits.find(t => /confirm|تأكيد/i.test(t.name)) ?? (preferred ? undefined : fits[0]) ?? null;
}

async function notSent(deps: OrderDeps, orderId: string, agencyId: string, clientId: string, reason: string) {
  await deps.db.storeOrder.update({ where: { id: orderId }, data: { confirm: 'NOT_SENT', confirmError: reason, followUpDoneAt: null } });
  await deps.pub.publish(agencyId, { type: 'order.updated', orderId, clientId });
  return { sent: false as const, reason };
}

/**
 * Sends the order's WhatsApp confirmation: an approved template with "confirm" and "cancel"
 * buttons whose payloads name the order. Anything missing (number, template, phone) flags the
 * order for a moderator instead.
 */
export async function requestConfirmation(deps: OrderDeps, orderId: string, now = new Date()): Promise<{ sent: true; messageId: string } | { sent: false; reason: string }> {
  const { db, pub } = deps;
  const order = await db.storeOrder.findUnique({ where: { id: orderId }, include: { store: true } });
  if (!order) return { sent: false, reason: 'gone' };
  const fail = (reason: string) => notSent(deps, order.id, order.agencyId, order.clientId, reason);
  if (!order.waId) return fail('رقم موبايل العميل مش مظبوط، لازم مكالمة');
  const number = order.store.waNumberId
    ? await db.whatsAppNumber.findFirst({ where: { id: order.store.waNumberId, clientId: order.clientId, status: 'CONNECTED' } })
    : await db.whatsAppNumber.findFirst({ where: { clientId: order.clientId, status: 'CONNECTED' }, orderBy: { createdAt: 'asc' } });
  if (!number) return fail('مفيش رقم واتساب شغال للعميل ده');
  const t = await confirmationTemplate(db, number.id, order.store.confirmTemplate);
  if (!t) return fail('مفيش قالب تأكيد طلب متوافق عليه من ميتا على الرقم ده');

  const built = buildConfirmationTemplate(t, order.id, { customer_name: firstName(order.customerName), order_number: order.number, total: moneyText(Number(order.totalMinor), order.currency) });
  const contact = await db.contact.upsert({
    where: { waNumberId_waId: { waNumberId: number.id, waId: order.waId } },
    create: { agencyId: order.agencyId, clientId: order.clientId, waNumberId: number.id, waId: order.waId, name: order.customerName },
    update: {}
  });
  const conv = await db.conversation.upsert({
    where: { waNumberId_contactId: { waNumberId: number.id, contactId: contact.id } },
    create: { agencyId: order.agencyId, clientId: order.clientId, waNumberId: number.id, contactId: contact.id, status: 'PENDING', lastMessageAt: now, lastPreview: previewText('template', built.rendered) },
    update: { lastMessageAt: now, lastPreview: previewText('template', built.rendered) }
  });
  const msg = await db.message.create({ data: {
    agencyId: order.agencyId, conversationId: conv.id, direction: 'OUT', type: 'template', body: built.rendered, status: 'QUEUED', createdAt: now,
    payload: json({ kind: 'template', template: built.template, rendered: { buttons: built.buttons }, orderId: order.id })
  } });
  await db.storeOrder.update({ where: { id: order.id }, data: { confirm: 'SENT', confirmMessageId: msg.id, confirmSentAt: now, confirmError: null, confirmedAt: null, confirmedBy: null, contactId: contact.id, followUpDoneAt: null } });
  await syncStageFromOrders(db, contact.id);
  await pub.publish(order.agencyId, { type: 'message.new', conversationId: conv.id, clientId: order.clientId, messageId: msg.id, direction: 'OUT' });
  await pub.publish(order.agencyId, { type: 'order.updated', orderId: order.id, clientId: order.clientId });
  await deps.onSend?.(msg.id);
  return { sent: true, messageId: msg.id };
}

export type InboundReply = { agencyId: string; clientId: string; conversationId: string; contactId: string; buttonPayload?: string; contextId?: string; body?: string; at: Date };

/**
 * A customer's answer to a confirmation: a button press (payload names the order), or a press on
 * an older template whose payload is lost (matched by the message it answers and the button words).
 * Only the customer the confirmation went to can answer it.
 */
export async function applyConfirmReply(deps: OrderDeps, r: InboundReply): Promise<'confirmed' | 'declined' | null> {
  const { db, pub } = deps;
  let order = null;
  let yes: boolean | null = null;
  const ans = confirmAnswer(r.buttonPayload);
  if (ans) {
    order = await db.storeOrder.findFirst({ where: { id: ans.orderId, clientId: r.clientId } });
    yes = ans.yes;
  } else if (r.contextId) {
    const original = await db.message.findUnique({ where: { waMessageId: r.contextId }, select: { id: true } });
    if (original) order = await db.storeOrder.findFirst({ where: { confirmMessageId: original.id, clientId: r.clientId } });
    if (order) yes = confirmFromText(r.body);
  }
  if (!order || yes === null || order.contactId !== r.contactId) return null;
  if ((LOST_STATUSES as readonly string[]).includes(order.status)) return null;
  // A press on an old message never overrides what a moderator settled on the phone, or an order already on its way.
  if (order.confirmedBy === 'agent' || !['PENDING', 'CONFIRMED'].includes(order.status)) return null;
  const want = yes ? 'CONFIRMED' : 'DECLINED';
  // A second press of the same button (even one processed at the same moment) changes nothing and thanks no one twice.
  const done = await db.storeOrder.updateMany({
    where: { id: order.id, NOT: { confirm: want, confirmedBy: 'customer' }, OR: [{ confirmedBy: null }, { confirmedBy: { not: 'agent' } }] },
    data: { confirm: want, confirmedAt: r.at, confirmedBy: 'customer', followUpDoneAt: null }
  });
  if (!done.count) return null;
  await syncStageFromOrders(db, r.contactId);
  await pub.publish(r.agencyId, { type: 'order.updated', orderId: order.id, clientId: r.clientId });

  // The customer just wrote, so a plain reply is allowed: thank them in words they expect.
  const text = yes
    ? `تمام يا ${firstName(order.customerName)} ✅ طلبك رقم ${order.number} اتأكد وهيتجهز للشحن. لو محتاج أي حاجة ابعتلنا هنا.`
    : `تمام، لغينا طلبك رقم ${order.number}. لو حابب تطلب تاني أو عندك أي سؤال ابعتلنا هنا 🙏`;
  const msg = await db.message.create({ data: { agencyId: r.agencyId, conversationId: r.conversationId, direction: 'OUT', type: 'text', body: text, status: 'QUEUED', payload: json({ kind: 'text', orderId: order.id }) } });
  await db.conversation.update({ where: { id: r.conversationId }, data: { lastMessageAt: new Date(), lastPreview: text.slice(0, 140), ...(yes ? { status: 'CLOSED', unreadCount: 0 } : {}) } });
  await pub.publish(r.agencyId, { type: 'message.new', conversationId: r.conversationId, clientId: r.clientId, messageId: msg.id, direction: 'OUT' });
  await deps.onSend?.(msg.id);
  return yes ? 'confirmed' : 'declined';
}

/**
 * Every minute: confirmations with no answer after the store's wait become NO_ANSWER, and ones
 * Meta refused become NOT_SENT. Both show up for moderators to call.
 */
export async function sweepConfirmations(db: Db, pub: Publisher, now = new Date()) {
  const waiting = await db.storeOrder.findMany({
    where: { confirm: 'SENT', confirmSentAt: { lt: new Date(now.getTime() - 60_000) } },
    select: { id: true, agencyId: true, clientId: true, confirmSentAt: true, confirmMessageId: true, store: { select: { confirmWaitMin: true } } },
    take: 1000, orderBy: { confirmSentAt: 'asc' }
  });
  const ids = waiting.map(w => w.confirmMessageId).filter((x): x is string => !!x);
  const msgs = new Map((await db.message.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, error: true } })).map(m => [m.id, m]));
  let noAnswer = 0, failed = 0;
  for (const w of waiting) {
    const m = w.confirmMessageId ? msgs.get(w.confirmMessageId) : undefined;
    let data: Prisma.StoreOrderUpdateManyMutationInput | null = null;
    if (!m || m.status === 'FAILED') { data = { confirm: 'NOT_SENT', confirmError: m?.error ? `واتساب رفض الرسالة: ${m.error}`.slice(0, 300) : 'رسالة التأكيد اتمسحت' }; failed++; }
    else if (w.confirmSentAt!.getTime() <= now.getTime() - w.store.confirmWaitMin * 60_000) { data = { confirm: 'NO_ANSWER' }; noAnswer++; }
    if (!data) continue;
    // Only if still waiting: a press that arrived a moment ago wins.
    const r = await db.storeOrder.updateMany({ where: { id: w.id, confirm: 'SENT' }, data });
    if (r.count) await pub.publish(w.agencyId, { type: 'order.updated', orderId: w.id, clientId: w.clientId });
  }
  return { noAnswer, failed };
}

/** Orders a moderator should call about: no answer, cancelled on WhatsApp, or the confirmation could not go out. */
export const FOLLOW_UP_WHERE = { confirm: { in: ['NO_ANSWER', 'NOT_SENT', 'DECLINED'] }, followUpDoneAt: null, status: { notIn: ['CANCELLED', 'RETURNED', 'FAILED'] } } satisfies Prisma.StoreOrderWhereInput;

// ---------- sales ----------

export type SalesBlock = {
  currency: string;
  orders: number; valueMinor: number;
  sold: number; soldValueMinor: number;       // confirmed, preparing, shipped or delivered
  delivered: number; deliveredValueMinor: number;
  waiting: number; waitingValueMinor: number; // not confirmed yet
  lost: number; lostValueMinor: number;       // cancelled, returned, failed, or cancelled on WhatsApp
};
export type CampaignSales = { orders: number; sold: number; soldValueMinor: number; currency: string };
export type StoreSales = { currencies: SalesBlock[]; byCampaign: Record<string, CampaignSales>; stores: number };

/**
 * Orders placed in [from, to) for some clients, per currency: everything, what really sold, what
 * is still waiting and what was lost. byCampaign has the sold part per ad campaign.
 */
export async function storeSales(db: Db, o: { agencyId: string; clientIds: string[] | 'all'; from: Date; to: Date }): Promise<StoreSales> {
  const clientFilter = o.clientIds === 'all' ? Prisma.empty : o.clientIds.length ? Prisma.sql`AND "clientId" IN (${Prisma.join(o.clientIds)})` : Prisma.sql`AND false`;
  const rows = await db.$queryRaw<{ currency: string; campaignId: string | null; bucket: string; delivered: boolean; n: number; v: bigint }[]>`
    SELECT currency, "campaignId",
      CASE WHEN status IN ('CANCELLED','RETURNED','FAILED') OR (status = 'PENDING' AND confirm = 'DECLINED') THEN 'lost'
           WHEN status IN ('CONFIRMED','PROCESSING','SHIPPED','DELIVERED') OR confirm = 'CONFIRMED' THEN 'sold'
           ELSE 'waiting' END AS bucket,
      status = 'DELIVERED' AS delivered,
      count(*)::int AS n, coalesce(sum("totalMinor"), 0)::bigint AS v
    FROM "StoreOrder"
    WHERE "agencyId" = ${o.agencyId} ${clientFilter} AND "placedAt" >= ${o.from} AND "placedAt" < ${o.to}
    GROUP BY 1, 2, 3, 4`;
  const blocks = new Map<string, SalesBlock>();
  const byCampaign: Record<string, CampaignSales> = {};
  for (const r of rows) {
    let b = blocks.get(r.currency);
    if (!b) blocks.set(r.currency, (b = { currency: r.currency, orders: 0, valueMinor: 0, sold: 0, soldValueMinor: 0, delivered: 0, deliveredValueMinor: 0, waiting: 0, waitingValueMinor: 0, lost: 0, lostValueMinor: 0 }));
    const v = Number(r.v);
    b.orders += r.n; b.valueMinor += v;
    if (r.bucket === 'sold') { b.sold += r.n; b.soldValueMinor += v; }
    else if (r.bucket === 'lost') { b.lost += r.n; b.lostValueMinor += v; }
    else { b.waiting += r.n; b.waitingValueMinor += v; }
    if (r.delivered) { b.delivered += r.n; b.deliveredValueMinor += v; }
    if (r.campaignId) {
      const c = (byCampaign[r.campaignId] ??= { orders: 0, sold: 0, soldValueMinor: 0, currency: r.currency });
      c.orders += r.n;
      if (r.bucket === 'sold') { c.sold += r.n; c.soldValueMinor += v; }
    }
  }
  const stores = await db.storeConnection.count({ where: { agencyId: o.agencyId, ...(o.clientIds === 'all' ? {} : { clientId: { in: o.clientIds } }) } });
  return { currencies: [...blocks.values()].sort((a, b) => b.valueMinor - a.valueMinor), byCampaign, stores };
}

/** Real return on ad spend: sold value per unit spent, only when both are in the same currency. Null when nothing was spent. */
export const roas = (soldValueMinor: number, spendMinor: number) => (spendMinor > 0 ? Math.round((soldValueMinor / spendMinor) * 100) / 100 : null);

/** Midnight of a calendar day in a time zone, as an instant (for turning report days into order times). */
export function dayStart(day: string, timeZone = 'Africa/Cairo'): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offset = (at: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
}

/**
 * Store sales next to ad spend: each currency's spend gets that currency's sold value and the real
 * ROAS, and each campaign gets the sales matched to it. Sales in a currency nobody spent in stay in `sales`.
 */
export function withSales<O extends { currencies: { currency: string; totals: { spendMinor: number } }[]; campaigns: { id: string; spendMinor: number; currency: string }[] }>(overview: O, sales: StoreSales) {
  return {
    ...overview,
    currencies: overview.currencies.map(c => {
      const s = sales.currencies.find(x => x.currency === c.currency) ?? null;
      return { ...c, sales: s, roas: s ? roas(s.soldValueMinor, c.totals.spendMinor) : null };
    }),
    campaigns: overview.campaigns.map(c => {
      const s = sales.byCampaign[c.id];
      return { ...c, store: s ? { ...s, roas: s.currency === c.currency ? roas(s.soldValueMinor, c.spendMinor) : null } : null };
    }),
    sales
  };
}
