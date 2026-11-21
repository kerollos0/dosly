import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@dosly/db';
import { can } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds, type AuthContext } from '../auth.js';

const STAGES = ['NEW', 'INTERESTED', 'ORDERED', 'WON', 'LOST'] as const;
const LOST_ORDERS = ['CANCELLED', 'RETURNED', 'FAILED'];
const tag = z.string().trim().min(1).max(30, 'العلامة طويلة، خليها أقل من 30 حرف');

const listQuery = z.object({
  clientId: z.string().optional(),
  stage: z.enum(STAGES).optional(),
  /** ad | comment | direct | campaign:<id> | adid:<meta ad id> */
  source: z.string().max(120).optional(),
  tag: z.string().max(30).optional(),
  q: z.string().trim().max(60).optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40)
});
const patchBody = z.object({
  stage: z.enum(STAGES).optional(),
  tags: z.array(tag).max(10, 'بحد أقصى 10 علامات').optional(),
  note: z.string().trim().max(2000, 'الملاحظة طويلة').nullable().optional()
});

/**
 * Customers of the agency's clients (الزباين): where each one is in a light pipeline, where they came from
 * (which ad, a comment, or they wrote on their own), tags and a note. The summary answers "which ad brings buyers?".
 */
export const customerRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;

  async function scope(auth: AuthContext, clientId?: string) {
    const visible = await visibleClientIds(db, auth);
    if (clientId) { await assertClientAccess(db, auth, clientId); return [clientId]; }
    if (visible !== 'all') return visible;
    return (await db.client.findMany({ where: { agencyId: auth.agencyId, archivedAt: null }, select: { id: true } })).map(c => c.id);
  }

  /** Meta ad id → its campaign, for the clients in view (ads synced from the ad accounts). */
  async function campaignsFor(clientIds: string[], adIds: string[]) {
    if (!adIds.length) return new Map<string, { id: string; name: string }>();
    const ads = await db.adAd.findMany({ where: { externalId: { in: adIds }, adAccount: { clientId: { in: clientIds } } }, select: { externalId: true, campaign: { select: { id: true, name: true } } } });
    return new Map(ads.map(a => [a.externalId, a.campaign]));
  }

  async function sourceWhere(clientIds: string[], source?: string): Promise<Prisma.ContactWhereInput> {
    if (!source) return {};
    if (source === 'ad' || source === 'comment' || source === 'direct') return { source };
    if (source.startsWith('adid:')) return { adId: source.slice(5) };
    if (source.startsWith('campaign:')) {
      const ads = await db.adAd.findMany({ where: { campaignId: source.slice(9), adAccount: { clientId: { in: clientIds } } }, select: { externalId: true } });
      return { adId: { in: ads.map(a => a.externalId) } };
    }
    throw new HttpError(400, 'المصدر مش مفهوم', 'bad_source');
  }

  const searchWhere = (q?: string): Prisma.ContactWhereInput => q
    ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { username: { contains: q, mode: 'insensitive' } }, { waId: { contains: q.replace(/\D/g, '') || q } }] }
    : {};
  /**
   * The people who count: they wrote to the client at least once (a confirmation template or a private reply
   * nobody answered is not a customer talking), and arrived in the period: first message, or came back through an ad.
   */
  const peopleWhere = (auth: AuthContext, clientIds: string[], since?: Date): Prisma.ContactWhereInput => ({
    agencyId: auth.agencyId, clientId: { in: clientIds }, conversations: { some: { lastInboundAt: { not: null } } },
    ...(since && { AND: [{ OR: [{ createdAt: { gte: since } }, { adReferredAt: { gte: since } }] }] })
  });
  const sinceOf = (days?: number) => (days ? new Date(Date.now() - days * 86400_000) : undefined);

  app.get('/customers', async req => {
    const auth = requireAuth(req);
    const q = listQuery.parse(req.query);
    const clientIds = await scope(auth, q.clientId);
    const where: Prisma.ContactWhereInput = {
      ...peopleWhere(auth, clientIds, sinceOf(q.days)),
      ...(q.stage && { stage: q.stage }),
      ...(q.tag && { tags: { has: q.tag } }),
      ...searchWhere(q.q),
      ...(await sourceWhere(clientIds, q.source))
    };
    const rows = await db.contact.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: {
        id: true, name: true, username: true, waId: true, stage: true, stageAt: true, tags: true, note: true, source: true, adId: true, adTitle: true, createdAt: true,
        client: { select: { id: true, name: true } },
        conversations: { orderBy: { lastMessageAt: 'desc' }, take: 1, select: { id: true, channel: true, lastMessageAt: true, lastPreview: true } }
      }
    });
    const page = rows.slice(0, q.limit);
    const ids = page.map(r => r.id);
    // Sales and campaign names follow the same permissions as the orders and ads pages.
    const seeOrders = can(auth.role, 'orders:view'), seeAds = can(auth.role, 'ads:view');
    const [sales, campaigns] = await Promise.all([
      ids.length && seeOrders ? db.storeOrder.groupBy({ by: ['contactId', 'currency'], where: { contactId: { in: ids }, status: { notIn: LOST_ORDERS as never } }, _count: true, _sum: { totalMinor: true } }) : [],
      campaignsFor(clientIds, [...new Set(page.map(r => r.adId).filter((x): x is string => !!x))])
    ]);
    const items = page.map(({ conversations, adId, ...r }) => ({
      ...r, conversation: conversations[0] ?? null,
      ...(!seeAds && { adTitle: null }),
      ad: adId ? { id: adId, campaign: seeAds ? campaigns.get(adId) ?? null : null } : null,
      orders: sales.filter(s => s.contactId === r.id).map(s => ({ currency: s.currency, count: s._count, minor: Number(s._sum.totalMinor ?? 0) }))
    }));
    return { items, nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
  });

  /** Counts per stage, and per source: how many people each ad (campaign) brought, how many ordered (or bought) and how many bought. */
  app.get('/customers/summary', async req => {
    const auth = requireAuth(req);
    const q = listQuery.pick({ clientId: true, days: true, source: true, tag: true, q: true }).parse(req.query);
    const clientIds = await scope(auth, q.clientId);
    if (!clientIds.length) return { stages: {}, sources: [], tags: [] };
    const since = sinceOf(q.days) ?? new Date(0);
    const ids = Prisma.join(clientIds);
    const seeOrders = can(auth.role, 'orders:view'), seeAds = can(auth.role, 'ads:view');
    const [stages, bySource, sales, tags] = await Promise.all([
      // Stage counts follow the chosen source, tag and search, so the tabs match the list under them.
      db.contact.groupBy({ by: ['stage'], where: {
        ...peopleWhere(auth, clientIds, sinceOf(q.days)),
        ...(q.tag && { tags: { has: q.tag } }), ...searchWhere(q.q), ...(await sourceWhere(clientIds, q.source))
      }, _count: true }),
      db.$queryRaw<{ source: string; adId: string | null; adTitle: string | null; people: number; ordered: number; buyers: number }[]>`
        SELECT c.source, c."adId", max(c."adTitle") AS "adTitle", count(*)::int AS people,
          count(*) FILTER (WHERE c.stage IN ('ORDERED', 'WON'))::int AS ordered, count(*) FILTER (WHERE c.stage = 'WON')::int AS buyers
        FROM "Contact" c WHERE c."agencyId" = ${auth.agencyId} AND c."clientId" IN (${ids}) AND greatest(c."createdAt", c."adReferredAt") >= ${since}
          AND EXISTS (SELECT 1 FROM "Conversation" v WHERE v."contactId" = c.id AND v."lastInboundAt" IS NOT NULL)
        GROUP BY c.source, c."adId"`,
      // Orders placed in the period, from the same people, credited to where the person came from.
      seeOrders ? db.$queryRaw<{ source: string; adId: string | null; currency: string; minor: bigint }[]>`
        SELECT c.source, c."adId", o.currency, sum(o."totalMinor")::bigint AS minor
        FROM "StoreOrder" o JOIN "Contact" c ON c.id = o."contactId"
        WHERE c."agencyId" = ${auth.agencyId} AND c."clientId" IN (${ids}) AND o."placedAt" >= ${since}
          AND o.status NOT IN ('CANCELLED', 'RETURNED', 'FAILED') AND o.confirm <> 'DECLINED'
        GROUP BY c.source, c."adId", o.currency` : [],
      db.$queryRaw<{ tag: string; n: number }[]>`
        SELECT t AS tag, count(*)::int AS n FROM "Contact" c, unnest(c.tags) t
        WHERE c."agencyId" = ${auth.agencyId} AND c."clientId" IN (${ids}) GROUP BY t ORDER BY n DESC LIMIT 30`
    ]);
    const campaigns = await campaignsFor(clientIds, [...new Set(bySource.map(r => r.adId).filter((x): x is string => !!x))]);
    // One row per campaign (several ads add up), per unknown ad, and for comments and people who wrote on their own.
    type Row = { key: string; kind: 'campaign' | 'ad' | 'comment' | 'direct'; label: string | null; people: number; ordered: number; buyers: number; sales: Record<string, number> };
    const rows = new Map<string, Row>();
    const keyOf = (source: string, adId: string | null) => {
      if (adId) { const c = campaigns.get(adId); return c ? { key: `campaign:${c.id}`, kind: 'campaign' as const, label: c.name } : { key: `adid:${adId}`, kind: 'ad' as const, label: null }; }
      return source === 'comment' ? { key: 'comment', kind: 'comment' as const, label: null } : { key: 'direct', kind: 'direct' as const, label: null };
    };
    for (const r of bySource) {
      const k = keyOf(r.source, r.adId);
      const row = rows.get(k.key) ?? { ...k, label: seeAds ? k.label ?? (k.kind === 'ad' ? r.adTitle : null) : null, people: 0, ordered: 0, buyers: 0, sales: {} };
      row.people += r.people; row.ordered += r.ordered; row.buyers += r.buyers;
      rows.set(k.key, row);
    }
    for (const s of sales) {
      const row = rows.get(keyOf(s.source, s.adId).key);
      if (row) row.sales[s.currency] = (row.sales[s.currency] ?? 0) + Number(s.minor);
    }
    const order = { campaign: 0, ad: 1, comment: 2, direct: 3 };
    return {
      stages: Object.fromEntries(stages.map(s => [s.stage, s._count])),
      sources: [...rows.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.people - a.people).map(r => ({ ...r, sales: Object.entries(r.sales).map(([currency, minor]) => ({ currency, minor })) })),
      tags: tags.map(t => t.tag)
    };
  });

  app.get<{ Params: { id: string } }>('/customers/:id', async req => {
    const auth = requireAuth(req);
    const c = await db.contact.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { id: true, clientId: true, name: true, stage: true, stageAt: true, tags: true, note: true, source: true, sourceRef: true, adId: true, adTitle: true, createdAt: true } });
    if (!c) throw new HttpError(404, 'الزبون مش موجود', 'not_found');
    await assertClientAccess(db, auth, c.clientId);
    const campaign = c.adId ? (await campaignsFor([c.clientId], [c.adId])).get(c.adId) ?? null : null;
    const tags = await db.$queryRaw<{ tag: string }[]>`SELECT DISTINCT unnest(tags) AS tag FROM "Contact" WHERE "clientId" = ${c.clientId} LIMIT 50`;
    return { ...c, campaign, clientTags: tags.map(t => t.tag) };
  });

  // Moderators move people along while they chat with them.
  app.patch<{ Params: { id: string } }>('/customers/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const body = patchBody.parse(req.body);
    const c = await db.contact.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { id: true, clientId: true, stage: true } });
    if (!c) throw new HttpError(404, 'الزبون مش موجود', 'not_found');
    await assertClientAccess(db, auth, c.clientId);
    const stageChanged = body.stage && body.stage !== c.stage;
    // Only from the stage we just read: if the store moved them in between, nothing is overwritten.
    const done = await db.contact.updateMany({ where: { id: c.id, stage: c.stage }, data: {
      ...(stageChanged && { stage: body.stage, stageAt: new Date() }),
      ...(body.tags && { tags: [...new Set(body.tags)] }),
      ...(body.note !== undefined && { note: body.note || null })
    } });
    if (!done.count) throw new HttpError(409, 'مرحلة الزبون اتغيّرت دلوقتي، حدّث الصفحة وجرّب تاني', 'stage_changed');
    if (stageChanged) await audit(db, auth, 'customer.stage', 'Contact', c.id, { from: c.stage, to: body.stage });
    return { ok: true };
  });
};
