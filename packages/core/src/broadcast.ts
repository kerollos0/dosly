import { readFile } from 'node:fs/promises';
import { Prisma, type Db } from '@dosly/db';
import {
  BROADCAST_MAX_RECIPIENTS, broadcastAudienceSchema, broadcastErrorAr, buildTemplateMessage, decrypt, errorCodeOf, fillName, isStopRequest, paramProblem,
  renderTemplate, templateShape, THROTTLE_WA_ERRORS, GraphError, uploadMedia, type BroadcastAudience, type TemplateLike
} from '@dosly/shared';
import type { Publisher } from './events.js';
import { PermanentMediaError, previewText, sendQueuedMessage, type MediaDeps, type OutboundPayload } from './media.js';

/**
 * WhatsApp broadcasts: an approved template to a chosen audience of one client's customers.
 * The audience is picked when sending starts (so people who opt out meanwhile are left out), then
 * each person gets their own message in their own chat, so replies land in the inbox as usual.
 */

const DAY = 86_400_000;
/** A reply within this long after the broadcast counts as an answer to it; an order within ORDER_WINDOW as a sale from it. */
export const REPLY_WINDOW_MS = 3 * DAY;
export const ORDER_WINDOW_MS = 7 * DAY;
const MAX_ATTEMPTS = 4;
const LOCK_MS = 2 * 60_000;
/** Errors about the template, the number or its token: stop the whole broadcast instead of failing everyone one by one. */
const STOP_ALL = new Set([132000, 132001, 132005, 132007, 132015, 132016, 131048, 131031, 368, 190, 10, 200]);
const LOST = ['CANCELLED', 'RETURNED', 'FAILED'] as const;

type Target = { clientId: string; waNumberId: string; category: string };

/** Who an audience means, on one number. Always only people who wrote to the business or bought from it, never opted out. */
export function audienceWhere(t: Target, audience: BroadcastAudience, now = new Date()): Prisma.ContactWhereInput {
  const wrote: Prisma.ContactWhereInput = { conversations: { some: { waNumberId: t.waNumberId, lastInboundAt: { not: null } } } };
  const bought: Prisma.ContactWhereInput = { orders: { some: { status: { notIn: [...LOST] } } } };
  const base: Prisma.ContactWhereInput = { clientId: t.clientId, waNumberId: t.waNumberId, waId: { not: null }, marketingOptOutAt: null };
  const kind: Prisma.ContactWhereInput =
    audience.kind === 'recent' ? { conversations: { some: { waNumberId: t.waNumberId, lastInboundAt: { gte: new Date(now.getTime() - (audience.days ?? 30) * DAY) } } } }
    : audience.kind === 'from_ad' ? { adId: { not: null } }
    : audience.kind === 'buyers' ? bought
    : audience.kind === 'no_order' ? { ...wrote, orders: { none: {} } }
    : { OR: [wrote, bought] };
  // Offers: nobody gets two in a day from the same number (Meta also caps marketing per person).
  const rested: Prisma.ContactWhereInput = t.category === 'MARKETING'
    ? { broadcasts: { none: { OR: [
        { sentAt: { gte: new Date(now.getTime() - DAY) }, broadcast: { waNumberId: t.waNumberId } },
        { state: 'PENDING', broadcast: { waNumberId: t.waNumberId, status: 'SENDING' } } // another offer is on its way to them
      ] } } }
    : {};
  return { AND: [base, kind, rested] };
}

/** How many people an audience reaches now, and how many were left out (stopped offers, or got one today). */
export async function countAudience(db: Db, t: Target, audience: BroadcastAudience, now = new Date()) {
  const where = audienceWhere(t, audience, now);
  const loose = audienceWhere({ ...t, category: 'UTILITY' }, audience, now);
  const [people, withoutRest, optedOut] = await Promise.all([
    db.contact.count({ where }),
    t.category === 'MARKETING' ? db.contact.count({ where: loose }) : Promise.resolve(0),
    db.contact.count({ where: { clientId: t.clientId, waNumberId: t.waNumberId, marketingOptOutAt: { not: null } } })
  ]);
  return { people, gotOneToday: t.category === 'MARKETING' ? withoutRest - people : 0, optedOut };
}

type Snapshot = TemplateLike & { name: string; language: string };
const snapshotOf = (b: { templateName: string; language: string; template: Prisma.JsonValue }): Snapshot => {
  const t = b.template as { parameterFormat?: string; components?: unknown };
  return { name: b.templateName, language: b.language, parameterFormat: t.parameterFormat ?? 'POSITIONAL', components: t.components ?? [] };
};

/** The template as one customer gets it: "[الاسم]" filled with their first name. Null if a field would be invalid for WhatsApp. */
export function messageFor(b: { templateName: string; language: string; template: Prisma.JsonValue; values: Prisma.JsonValue }, name: string | null) {
  const t = snapshotOf(b);
  const raw = (b.values ?? {}) as Record<string, string>;
  const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, fillName(v, name)]));
  const shape = templateShape(t);
  if (shape.fields.some(f => paramProblem(values[f.id]))) return null;
  const built = buildTemplateMessage(t, values, shape.headerMedia ? { id: 'pending' } : undefined).template;
  const rendered = renderTemplate(t, values);
  return { built, rendered, headerMedia: shape.headerMedia };
}

/**
 * Starts a broadcast whose time came: claims it (only one worker wins), then picks its audience.
 * Returns the number of people, or null when it was not due / already started.
 */
export async function startBroadcast(db: Db, pub: Publisher, id: string, now = new Date()) {
  const claimed = await db.broadcast.updateMany({ where: { id, status: 'SCHEDULED', scheduledAt: { lte: now } }, data: { status: 'SENDING', startedAt: now } });
  // A run that died while picking the audience: pick again (rows already in are kept, none doubled).
  const resume = claimed.count ? 0 : await db.broadcast.count({ where: { id, status: 'SENDING', audienceAt: null } });
  if (!claimed.count && !resume) return null;
  const b = await db.broadcast.findUniqueOrThrow({ where: { id } });
  const audience = broadcastAudienceSchema.parse(b.audience);
  const where = audienceWhere(b, audience, now);
  // On a resumed pick, people already picked are excluded by the audience rule itself, so count them in.
  let total = await db.broadcastRecipient.count({ where: { broadcastId: id } });
  let cursor: string | undefined;
  while (total < BROADCAST_MAX_RECIPIENTS) {
    const page = await db.contact.findMany({ where: { AND: [where, { broadcasts: { none: { broadcastId: id } } }] }, select: { id: true }, orderBy: { id: 'asc' }, take: Math.min(2000, BROADCAST_MAX_RECIPIENTS - total), ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
    if (!page.length) break;
    const r = await db.broadcastRecipient.createMany({ data: page.map(c => ({ broadcastId: id, contactId: c.id })), skipDuplicates: true });
    total += r.count;
    cursor = page.at(-1)!.id;
  }
  await db.broadcast.update({ where: { id }, data: { total, audienceAt: new Date(), ...(total === 0 && { status: 'DONE', finishedAt: now }) } });
  await pub.publish(b.agencyId, { type: 'broadcast.updated', broadcastId: id });
  return total;
}

/** Uploads the header image to Meta once per broadcast (Meta keeps uploads 30 days; renewed after 25). */
async function headerMediaId(deps: MediaDeps, b: { id: string; headerKey: string | null; headerMediaId: string | null; headerUploadedAt: Date | null }, num: { phoneNumberId: string }, token: string) {
  if (!b.headerKey) throw new PermanentMediaError('الصورة اللي في أول الرسالة مش موجودة');
  if (b.headerMediaId && b.headerUploadedAt && Date.now() - b.headerUploadedAt.getTime() < 25 * DAY) return b.headerMediaId;
  const bytes = await readFile(deps.store.localPath(b.headerKey));
  const mime = b.headerKey.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const mediaId = await uploadMedia({ phoneNumberId: num.phoneNumberId, token, bytes, mime, fileName: b.headerKey.split('/').pop()! }, deps.fetch);
  await deps.db.broadcast.update({ where: { id: b.id }, data: { headerMediaId: mediaId, headerUploadedAt: new Date() } });
  return mediaId;
}

export type BatchResult = { sent: number; failed: number; skipped: number; remaining: number; done: boolean; slowDown: boolean };

/**
 * Sends the next batch of a running broadcast. Each person: one message in their chat, sent right
 * away through the same pipeline as the inbox. A throttling error from Meta stops the batch so the
 * worker waits before the next one; a permanent one fails that person only.
 */
export async function sendBroadcastBatch(deps: MediaDeps & { onSent?: (messageId: string, broadcastId: string) => Promise<void> }, id: string, o: { batch?: number; concurrency?: number; pauseMs?: number } = {}): Promise<BatchResult> {
  const { db, pub } = deps;
  const res: BatchResult = { sent: 0, failed: 0, skipped: 0, remaining: 0, done: false, slowDown: false };
  const b = await db.broadcast.findUnique({ where: { id }, include: { waNumber: true } });
  if (!b || b.status !== 'SENDING') return { ...res, done: true };
  const num = b.waNumber;
  const finishAll = async (error: string) => {
    const fin = await db.broadcast.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'DONE', finishedAt: new Date() } });
    if (fin.count) {
      await abandonQueued(db, id, error);
      await db.broadcastRecipient.updateMany({ where: { broadcastId: id, state: 'PENDING' }, data: { state: 'FAILED', error } });
      await pub.publish(b.agencyId, { type: 'broadcast.updated', broadcastId: id });
    }
    return { ...res, done: true };
  };
  if (num.status !== 'CONNECTED') return finishAll('رقم الواتساب اتفصل قبل ما الرسالة تتبعت');

  const token = decrypt(num.accessTokenEnc, deps.key);
  const sample = messageFor(b, null);
  let header: string | undefined;
  try { if (sample?.headerMedia) header = await headerMediaId(deps, b, num, token); }
  catch (e) {
    if (e instanceof PermanentMediaError || (e instanceof GraphError && !THROTTLE_WA_ERRORS.has(e.code ?? 0) && e.status < 500)) return finishAll(`الصورة متبعتتش لواتساب: ${(e as Error).message}`.slice(0, 300));
    throw e; // network or Meta down: the worker retries the batch
  }

  let abort: { code?: number; message: string } | null = null;
  const todo = await db.broadcastRecipient.findMany({
    where: { broadcastId: id, state: 'PENDING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, take: o.batch ?? 40, orderBy: { id: 'asc' },
    include: { contact: { select: { id: true, name: true, waId: true, marketingOptOutAt: true } } }
  });

  const one = async (r: (typeof todo)[number]) => {
    if (res.slowDown || abort) return;
    // Hold the row while sending it: a second run of this broadcast (a stalled job run again) skips it.
    const now0 = new Date();
    const held = await db.broadcastRecipient.updateMany({
      where: { id: r.id, state: 'PENDING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now0 } }] },
      data: { lockedUntil: new Date(now0.getTime() + LOCK_MS) }
    });
    if (!held.count) return;
    try { await sendOne(r); } finally { await db.broadcastRecipient.updateMany({ where: { id: r.id }, data: { lockedUntil: null } }); }
  };
  const sendOne = async (r: (typeof todo)[number]) => {
    if (r.contact.marketingOptOutAt || !r.contact.waId) {
      await db.broadcastRecipient.update({ where: { id: r.id }, data: { state: 'SKIPPED' } });
      res.skipped++;
      return;
    }
    let messageId = r.messageId;
    if (!messageId) {
      const m = messageFor(b, r.contact.name);
      if (!m) { await db.broadcastRecipient.update({ where: { id: r.id }, data: { state: 'FAILED', error: 'خانات القالب مش مظبوطة للشخص ده' } }); res.failed++; return; }
      const preview = previewText('template', m.rendered.body);
      const now = new Date();
      // A new chat starts closed, so a broadcast never floods the inbox; the customer's reply opens it.
      const conv = await db.conversation.upsert({
        where: { waNumberId_contactId: { waNumberId: num.id, contactId: r.contact.id } },
        create: { agencyId: b.agencyId, clientId: b.clientId, waNumberId: num.id, contactId: r.contact.id, status: 'CLOSED', lastMessageAt: now, lastPreview: preview },
        update: {} // an existing chat keeps its place in the inbox: a broadcast is not news to the team
      });
      const payload: OutboundPayload & { broadcastId: string } = {
        kind: 'template', broadcastId: b.id,
        template: { ...m.built, components: (m.built.components as Record<string, unknown>[] | undefined)?.filter(x => !(header && x.type === 'header')) },
        ...(header && { headerKind: 'image' as const, metaMediaId: header }),
        rendered: { header: m.rendered.header, footer: m.rendered.footer, buttons: m.rendered.buttons }
      };
      // The message and its link to the person are written together: a crash between them can't leave a message to send twice.
      const msg = await db.$transaction(async tx => {
        const row = await tx.message.create({ data: { agencyId: b.agencyId, conversationId: conv.id, direction: 'OUT', type: 'template', body: m.rendered.body, status: 'QUEUED', sentById: b.createdById, payload: payload as Prisma.InputJsonValue, createdAt: now } });
        await tx.broadcastRecipient.update({ where: { id: r.id }, data: { messageId: row.id } });
        return row;
      });
      await pub.publish(b.agencyId, { type: 'message.new', conversationId: conv.id, clientId: b.clientId, messageId: msg.id, direction: 'OUT' });
      messageId = msg.id;
    }
    try {
      await sendQueuedMessage(deps, messageId);
      // "skipped" means another path already sent it (the stuck-message sweep): its status says what happened.
      const st = await db.message.findUnique({ where: { id: messageId }, select: { status: true, error: true } });
      if (st?.status === 'FAILED') {
        await db.broadcastRecipient.update({ where: { id: r.id }, data: { state: 'FAILED', error: st.error, errorCode: errorCodeOf(st.error) } });
        res.failed++;
      } else {
        // Only from PENDING: a "failed" receipt from WhatsApp may already have arrived for this message.
        await db.broadcastRecipient.updateMany({ where: { id: r.id, state: 'PENDING' }, data: { state: 'SENT', sentAt: new Date(), attempts: { increment: 1 } } });
        res.sent++;
        await deps.onSent?.(messageId, b.id);
      }
    } catch (e) {
      const code = e instanceof PermanentMediaError || e instanceof GraphError ? e.code : undefined;
      // The template, the number or its token is the problem: every next person would fail the same way.
      if ((code !== undefined && STOP_ALL.has(code)) || (e instanceof GraphError && e.status === 401)) { abort = { code, message: (e as Error).message }; return; }
      // Throttling is Meta asking us to wait, not a failed try. 131056 limits one person only: try them later.
      if (code !== undefined && THROTTLE_WA_ERRORS.has(code)) { if (code !== 131056) res.slowDown = true; return; }
      const attempts = r.attempts + 1;
      if (e instanceof PermanentMediaError || attempts >= MAX_ATTEMPTS) {
        const error = (e as Error).message.slice(0, 500);
        await db.message.update({ where: { id: messageId }, data: { status: 'FAILED', error: code ? `${code}: ${error}` : error } });
        await pub.publish(b.agencyId, { type: 'message.status', conversationId: (await db.message.findUniqueOrThrow({ where: { id: messageId }, select: { conversationId: true } })).conversationId, messageId, status: 'FAILED' });
        await db.broadcastRecipient.update({ where: { id: r.id }, data: { state: 'FAILED', error, errorCode: code ?? null, attempts } });
        if (code === 131050) await db.contact.update({ where: { id: r.contact.id }, data: { marketingOptOutAt: new Date() } });
        res.failed++;
      } else {
        await db.broadcastRecipient.update({ where: { id: r.id }, data: { attempts } });
        deps.log?.warn({ broadcastId: id, recipientId: r.id, err: (e as Error).message }, 'Broadcast send will retry');
      }
    }
  };

  // A few at a time: well under WhatsApp's 80 messages a second per number.
  const width = o.concurrency ?? 8;
  for (let i = 0; i < todo.length; i += width) {
    if (res.slowDown || abort) break;
    const cur = await db.broadcast.findUnique({ where: { id }, select: { status: true } });
    if (cur?.status !== 'SENDING') break; // cancelled midway
    await Promise.all(todo.slice(i, i + width).map(one));
    if (o.pauseMs) await new Promise(r => setTimeout(r, o.pauseMs));
  }

  if (abort) {
    const a = abort as { code?: number; message: string };
    deps.log?.warn({ broadcastId: id, code: a.code, err: a.message }, 'Broadcast stopped: the template or number cannot send');
    return finishAll(broadcastErrorAr(a.code ?? (a.message.includes('token') ? 190 : null), a.message));
  }
  res.remaining = await db.broadcastRecipient.count({ where: { broadcastId: id, state: 'PENDING' } });
  if (!res.remaining) {
    const fin = await db.broadcast.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'DONE', finishedAt: new Date() } });
    res.done = true;
    if (fin.count) await pub.publish(b.agencyId, { type: 'broadcast.updated', broadcastId: id });
  }
  if (res.sent || res.failed || res.skipped) await pub.publish(b.agencyId, { type: 'broadcast.updated', broadcastId: id });
  return res;
}

/**
 * Messages of a stopped broadcast that were written but not sent yet: marked failed, so no other
 * path (the stuck-message sweep) sends them after the stop, and their people stay "not sent".
 */
async function abandonQueued(db: Db, broadcastId: string, error: string) {
  const rows = await db.broadcastRecipient.findMany({ where: { broadcastId, state: 'PENDING', messageId: { not: null } }, select: { id: true, messageId: true } });
  if (!rows.length) return;
  await db.message.updateMany({ where: { id: { in: rows.map(r => r.messageId!) }, status: 'QUEUED' }, data: { status: 'FAILED', error } });
  await db.broadcastRecipient.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { messageId: null } });
}

/** Stops a broadcast that has not finished. People not reached yet stay "not sent". */
export async function cancelBroadcast(db: Db, pub: Publisher, agencyId: string, id: string) {
  const r = await db.broadcast.updateMany({ where: { id, agencyId, status: { in: ['SCHEDULED', 'SENDING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  if (r.count) {
    await abandonQueued(db, id, 'الحملة اتوقفت قبل ما الرسالة دي تتبعت');
    await pub.publish(agencyId, { type: 'broadcast.updated', broadcastId: id });
  }
  return r.count > 0;
}

/**
 * A customer wrote: an answer to a recent broadcast counts as a reply, and "إيقاف" (or the stop
 * button) stops offers for good. Returns true when it just stopped offers.
 */
export async function noteBroadcastInbound(db: Db, contactId: string, text: string | null | undefined, at: Date) {
  // A minute of slack: WhatsApp timestamps are whole seconds and come from Meta's clock.
  const recent = await db.broadcastRecipient.findFirst({
    where: { contactId, state: 'SENT', sentAt: { gte: new Date(at.getTime() - REPLY_WINDOW_MS), lte: new Date(at.getTime() + 60_000) } },
    orderBy: { sentAt: 'desc' }, select: { id: true, repliedAt: true }
  });
  const stop = isStopRequest(text);
  // "stop" or "وقف" alone could mean an order; it means "no more offers" only right after an offer.
  if (stop === 'clear' || (stop === 'short' && recent)) {
    const r = await db.contact.updateMany({ where: { id: contactId, marketingOptOutAt: null }, data: { marketingOptOutAt: at } });
    return r.count > 0;
  }
  // The reply counts for the latest offer only.
  if (recent && !recent.repliedAt) await db.broadcastRecipient.update({ where: { id: recent.id }, data: { repliedAt: at } });
  return false;
}

export type BroadcastStats = {
  total: number; pending: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number;
  orders: number; sales: { currency: string; minor: number }[];
};
const EMPTY: BroadcastStats = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, orders: 0, sales: [] };

/** Counts per broadcast, from each person's message status, replies, and store orders placed within a week. */
export async function broadcastStats(db: Db, ids: string[]): Promise<Map<string, BroadcastStats>> {
  const out = new Map<string, BroadcastStats>(ids.map(i => [i, { ...EMPTY, sales: [] }]));
  if (!ids.length) return out;
  const rows = await db.$queryRaw<{ id: string; total: number; pending: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number }[]>`
    SELECT r."broadcastId" AS id,
      count(*)::int AS total,
      count(*) FILTER (WHERE r.state = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE r.state = 'SENT')::int AS sent,
      count(*) FILTER (WHERE m.status IN ('DELIVERED', 'READ'))::int AS delivered,
      count(*) FILTER (WHERE m.status = 'READ')::int AS read,
      count(*) FILTER (WHERE r."repliedAt" IS NOT NULL)::int AS replied,
      count(*) FILTER (WHERE r.state = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE r.state = 'SKIPPED')::int AS skipped
    FROM "BroadcastRecipient" r LEFT JOIN "Message" m ON m.id = r."messageId"
    WHERE r."broadcastId" IN (${Prisma.join(ids)})
    GROUP BY r."broadcastId"`;
  for (const { id, ...r } of rows) Object.assign(out.get(id)!, r);
  // Each order counts once, for the latest offer the person got in the week before it (last touch).
  const sales = await db.$queryRaw<{ id: string; currency: string; n: number; v: bigint }[]>`
    SELECT x.bid AS id, x.currency, count(*)::int AS n, coalesce(sum(x.v), 0)::bigint AS v FROM (
      SELECT DISTINCT ON (o.id) o.id, o.currency, o."totalMinor" AS v, r."broadcastId" AS bid
      FROM "StoreOrder" o
      JOIN "BroadcastRecipient" r ON r."contactId" = o."contactId" AND r.state = 'SENT' AND r."sentAt" IS NOT NULL
        AND o."placedAt" >= r."sentAt" AND o."placedAt" < r."sentAt" + ${`${ORDER_WINDOW_MS / 1000} seconds`}::interval
      WHERE o."contactId" IN (SELECT "contactId" FROM "BroadcastRecipient" WHERE "broadcastId" IN (${Prisma.join(ids)}))
        AND o.status NOT IN ('CANCELLED', 'RETURNED', 'FAILED')
      ORDER BY o.id, r."sentAt" DESC
    ) x WHERE x.bid IN (${Prisma.join(ids)})
    GROUP BY x.bid, x.currency`;
  for (const s of sales) {
    const st = out.get(s.id)!;
    st.orders += s.n;
    st.sales.push({ currency: s.currency, minor: Number(s.v) });
  }
  return out;
}

/** Broadcasts whose time came but no job started them (lost job, worker restart), and running ones with nothing in flight. */
export function broadcastsDue(db: Db, now = new Date()) {
  return db.broadcast.findMany({ where: { OR: [{ status: 'SCHEDULED', scheduledAt: { lte: now } }, { status: 'SENDING' }] }, select: { id: true, status: true }, take: 200, orderBy: { scheduledAt: 'asc' } });
}
