import type { FastifyPluginAsync } from 'fastify';
import { can, dayIn, addDays } from '@dosly/shared';
import { FOLLOW_UP_WHERE, PUBLISHABLE_REVIEW } from '@dosly/core';
import { requireAuth, visibleClientIds } from '../auth.js';

const TZ = 'Africa/Cairo';
/** Cairo midnight of a local day, as a UTC instant. Egypt has summer time, so the offset is read twice:
 * once near the guess and again at the corrected instant (on the spring-forward day they differ). */
const HOUR = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function offsetMs(at: Date) {
  const p = Object.fromEntries(HOUR.formatToParts(at).map(x => [x.type, x.value]));
  const local = (+p.hour! % 24) * 60 + +p.minute!, utc = at.getUTCHours() * 60 + at.getUTCMinutes();
  return ((local - utc + 1440 + 720) % 1440 - 720) * 60_000;
}
function cairoMidnight(day: string) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const t1 = guess - offsetMs(new Date(guess));
  return new Date(guess - offsetMs(new Date(t1)));
}

/**
 * Everything that needs someone today, counted for the person asking: one screen that answers
 * "what do I do now?" Each count is only sent to roles that can act on it.
 */
export const todayRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;

  app.get('/today', async req => {
    const auth = requireAuth(req);
    const visible = await visibleClientIds(db, auth);
    const scope = { agencyId: auth.agencyId, ...(visible === 'all' ? {} : { clientId: { in: visible } }) };
    const today = dayIn(TZ);
    const start = cairoMidnight(today), end = cairoMidnight(addDays(today, 1));
    const reply = can(auth.role, 'inbox:reply'), approve = can(auth.role, 'posts:approve'), write = can(auth.role, 'posts:write');

    // A conversation waits when the customer wrote last and nobody has opened it since.
    const waiting = { ...scope, status: { not: 'CLOSED' as const }, unreadCount: { gt: 0 } };
    const [waitingCount, mineCount, oldestWaiting, comments, drafts, changes, changesCount, failed, toClient, publishingToday, adAlerts, ordersToCall] = await Promise.all([
      reply ? db.conversation.count({ where: waiting }) : null,
      reply ? db.conversation.count({ where: { ...waiting, assigneeId: auth.userId } }) : null,
      reply ? db.conversation.findFirst({ where: waiting, orderBy: { lastInboundAt: 'asc' }, select: { lastInboundAt: true } }) : null,
      reply ? db.socialComment.count({ where: { ...scope, parentExternalId: null, fromPage: false, deletedAt: null, status: 'OPEN' } }) : null,
      approve ? db.post.count({ where: { ...scope, status: 'DRAFT', scheduledAt: { not: null }, approvedById: null } }) : null,
      write ? db.post.findMany({
        where: { ...scope, status: 'SCHEDULED', clientReview: 'CHANGES_REQUESTED' }, orderBy: { scheduledAt: 'asc' }, take: 5,
        select: { id: true, scheduledAt: true, clientNote: true, client: { select: { name: true } } }
      }) : [],
      write ? db.post.count({ where: { ...scope, status: 'SCHEDULED', clientReview: 'CHANGES_REQUESTED' } }) : null,
      // Every failed post still needs someone; retrying is a manager's button.
      approve ? db.post.count({ where: { ...scope, status: { in: ['FAILED', 'PARTIAL'] } } }) : null,
      write ? db.post.count({ where: { ...scope, status: 'SCHEDULED', clientReview: 'PENDING' } }) : null,
      // Only what will really go out: a post waiting on the client, or sent back by them, does not publish.
      db.post.count({ where: { ...scope, status: 'SCHEDULED', clientReview: { in: [...PUBLISHABLE_REVIEW] }, scheduledAt: { gte: start, lt: end } } }),
      can(auth.role, 'ads:view') ? db.adAlert.count({ where: { ...scope, resolvedAt: null } }) : null,
      // Cash-on-delivery orders nobody confirmed on WhatsApp: a moderator calls the customer.
      can(auth.role, 'orders:view') ? db.storeOrder.count({ where: { ...scope, ...FOLLOW_UP_WHERE } }) : null
    ]);
    return {
      inbox: reply ? { waiting: waitingCount!, mine: mineCount!, oldestWaitingAt: oldestWaiting?.lastInboundAt ?? null } : null,
      comments,
      posts: {
        draftsToApprove: drafts,
        changesRequested: changesCount,
        changes: changes.map(p => ({ id: p.id, scheduledAt: p.scheduledAt, note: p.clientNote, client: p.client.name })),
        failed,
        waitingForClient: toClient,
        publishingToday
      },
      adAlerts,
      ordersToCall
    };
  });
};
