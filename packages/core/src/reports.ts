import type { Db } from '@dosly/db';

export type ClientReport = {
  from: string;
  to: string;
  posts: { published: number; failed: number; upcoming: number; awaitingYou: number; byPlatform: { FACEBOOK_PAGE: number; INSTAGRAM: number } };
  inbox: { newConversations: number; inbound: number; outbound: number; customerTurns: number; answered: number; medianFirstResponseSec: number | null; open: number };
  daily: { day: string; inbound: number }[];
};

/**
 * The numbers a business owner cares about for one period: what got posted, how many customers
 * wrote, and how fast the agency answered. "Response time" is measured per customer turn: every
 * time a customer writes after the agency (or for the first time), until the agency's next reply.
 */
export async function clientReport(db: Db, clientId: string, from: Date, to: Date, now = new Date()): Promise<ClientReport> {
  const [published, failed, upcoming, awaitingYou, targets, newConversations, inbound, outbound, open, turns, daily] = await Promise.all([
    db.post.count({ where: { clientId, status: { in: ['PUBLISHED', 'PARTIAL'] }, scheduledAt: { gte: from, lt: to } } }),
    db.post.count({ where: { clientId, status: 'FAILED', scheduledAt: { gte: from, lt: to } } }),
    db.post.count({ where: { clientId, status: { in: ['SCHEDULED', 'DRAFT'] }, scheduledAt: { gte: now } } }),
    db.post.count({ where: { clientId, clientReview: 'PENDING', status: { in: ['SCHEDULED', 'DRAFT'] } } }),
    db.postTarget.groupBy({ by: ['socialAccountId'], where: { status: 'PUBLISHED', publishedAt: { gte: from, lt: to }, post: { clientId } }, _count: true }),
    db.conversation.count({ where: { clientId, createdAt: { gte: from, lt: to } } }),
    db.message.count({ where: { direction: 'IN', createdAt: { gte: from, lt: to }, conversation: { clientId } } }),
    db.message.count({ where: { direction: 'OUT', createdAt: { gte: from, lt: to }, conversation: { clientId } } }),
    db.conversation.count({ where: { clientId, status: { in: ['OPEN', 'PENDING'] } } }),
    db.$queryRaw<{ turns: number; answered: number; median: number | null }[]>`
      WITH m AS (
        SELECT m."conversationId", m.direction::text AS dir, m."createdAt",
               lag(m.direction::text) OVER (PARTITION BY m."conversationId" ORDER BY m."createdAt") AS prev
        FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE c."clientId" = ${clientId} AND m."createdAt" >= ${from} AND m."createdAt" < ${to}
      ), t AS (
        SELECT i."createdAt",
               (SELECT min(o."createdAt") FROM m o WHERE o."conversationId" = i."conversationId" AND o.dir = 'OUT' AND o."createdAt" > i."createdAt") AS answered_at
        FROM m i WHERE i.dir = 'IN' AND (i.prev IS NULL OR i.prev = 'OUT')
      )
      SELECT count(*)::int AS turns, count(answered_at)::int AS answered,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - "createdAt")) FILTER (WHERE answered_at IS NOT NULL))::float AS median
      FROM t`,
    db.$queryRaw<{ day: Date; inbound: number }[]>`
      SELECT date_trunc('day', m."createdAt") AS day, count(*)::int AS inbound
      FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE c."clientId" = ${clientId} AND m.direction = 'IN' AND m."createdAt" >= ${from} AND m."createdAt" < ${to}
      GROUP BY 1 ORDER BY 1`
  ]);

  const accounts = await db.socialAccount.findMany({ where: { id: { in: targets.map(t => t.socialAccountId) } }, select: { id: true, platform: true } });
  const byPlatform = { FACEBOOK_PAGE: 0, INSTAGRAM: 0 };
  for (const t of targets) {
    const platform = accounts.find(a => a.id === t.socialAccountId)?.platform;
    if (platform) byPlatform[platform] += t._count;
  }
  const r = turns[0] ?? { turns: 0, answered: 0, median: null };
  return {
    from: from.toISOString(), to: to.toISOString(),
    posts: { published, failed, upcoming, awaitingYou, byPlatform },
    inbox: { newConversations, inbound, outbound, customerTurns: r.turns, answered: r.answered, medianFirstResponseSec: r.median === null ? null : Math.round(r.median), open },
    daily: daily.map(d => ({ day: d.day.toISOString().slice(0, 10), inbound: d.inbound }))
  };
}

/** Calendar month (1-12) in Cairo time, as [from, to). */
export function monthRange(year: number, month: number): [Date, Date] {
  // Egypt is UTC+2 (UTC+3 in summer time); month edges at Cairo midnight are close enough at UTC-2h.
  const from = new Date(Date.UTC(year, month - 1, 1, -2));
  const to = new Date(Date.UTC(year, month, 1, -2));
  return [from, to];
}
