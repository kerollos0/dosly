import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { accountFields, adsOverview } from '@dosly/core';
import { AD_ACCOUNT_FIELDS, adsGraph, AdsGraphError, addDays, connectAdAccountSchema, dayIn, encrypt, normalizeAdAccountId, type GraphAdAccount } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requirePermission, visibleClientIds } from '../auth.js';

const TZ = 'Africa/Cairo';
const big = (v: bigint | null) => (v === null ? null : Number(v));

export const adsRoutes: FastifyPluginAsync = async app => {
  const { db, key, queues } = app.deps;
  const f = app.deps.fetch;

  const scope = async (auth: Parameters<typeof visibleClientIds>[1], clientId?: string) => {
    if (clientId) { await assertClientAccess(db, auth, clientId); return [clientId]; }
    return visibleClientIds(db, auth);
  };

  app.get('/ads/accounts', async req => {
    const auth = requirePermission(req, 'ads:view');
    const ids = await visibleClientIds(db, auth);
    const rows = await db.adAccount.findMany({
      where: { agencyId: auth.agencyId, ...(ids === 'all' ? {} : { clientId: { in: ids } }) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, clientId: true, externalId: true, name: true, currency: true, timezoneName: true, accountStatus: true, disableReason: true, spendCapMinor: true, amountSpentMinor: true, status: true, lastError: true, lastSyncAt: true, throttledUntil: true }
    });
    return rows.map(r => ({ ...r, spendCapMinor: big(r.spendCapMinor), amountSpentMinor: big(r.amountSpentMinor) }));
  });

  // The token is proved by reading the account: ad accounts are private, so a token that can read one has access to it.
  app.post('/ads/accounts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'channels:manage');
    const input = connectAdAccountSchema.parse(req.body);
    await assertClientAccess(db, auth, input.clientId);
    const externalId = normalizeAdAccountId(input.adAccountId);
    if (!externalId) throw new HttpError(400, 'رقم الحساب الإعلاني مش صح', 'bad_id');
    let info: GraphAdAccount;
    try {
      info = (await adsGraph<GraphAdAccount>(`act_${externalId}?fields=${AD_ACCOUNT_FIELDS}`, input.accessToken, f)).data;
    } catch (e) {
      const msg = e instanceof AdsGraphError && e.auth ? 'التوكن ده مش شايف الحساب الإعلاني ده. لازم يكون فيه صلاحية ads_read على الحساب.' : `Meta رفضت البيانات: ${(e as Error).message}`;
      throw new HttpError(400, msg, 'meta_rejected');
    }
    const existing = await db.adAccount.findUnique({ where: { agencyId_externalId: { agencyId: auth.agencyId, externalId } }, select: { clientId: true } });
    if (existing && existing.clientId !== input.clientId) throw new HttpError(409, 'الحساب ده مربوط بعميل تاني. افصله من هناك الأول.', 'account_taken');
    const data = { clientId: input.clientId, ...accountFields({ ...info, id: externalId }), accessTokenEnc: encrypt(input.accessToken, key), status: 'CONNECTED' as const, lastError: null, throttledUntil: null };
    const acc = await db.adAccount.upsert({
      where: { agencyId_externalId: { agencyId: auth.agencyId, externalId } },
      create: { ...data, agencyId: auth.agencyId, externalId },
      update: data
    });
    // A reconnect clears the old token alert; the sync re-opens anything still wrong.
    await db.adAlert.deleteMany({ where: { adAccountId: acc.id, kind: 'ACCOUNT_PROBLEM', objectKey: 'token' } });
    await queues.syncAds(acc.id);
    await audit(db, auth, 'ads.account.connect', 'AdAccount', acc.id, { name: acc.name, externalId });
    return reply.status(201).send({ id: acc.id, name: acc.name, currency: acc.currency });
  });

  app.delete<{ Params: { id: string } }>('/ads/accounts/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'channels:manage');
    const acc = await db.adAccount.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!acc) throw new HttpError(404, 'الحساب مش موجود', 'not_found');
    await assertClientAccess(db, auth, acc.clientId);
    await db.adAccount.delete({ where: { id: acc.id } }); // campaigns, numbers and alerts go with it
    await audit(db, auth, 'ads.account.disconnect', 'AdAccount', acc.id, { name: acc.name });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/ads/accounts/:id/sync', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'ads:view');
    const acc = await db.adAccount.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!acc) throw new HttpError(404, 'الحساب مش موجود', 'not_found');
    await assertClientAccess(db, auth, acc.clientId);
    if (acc.status === 'ERROR') throw new HttpError(409, 'التوكن بتاع الحساب ده مبقاش شغال. اربطه تاني بتوكن جديد.', 'token_error');
    if (acc.throttledUntil && acc.throttledUntil > new Date()) throw new HttpError(429, 'ميتا طالبة نهدّي الطلبات على الحساب ده. هيتحدث لوحده أول ما ينفع.', 'throttled');
    await queues.syncAds(acc.id);
    return { queued: true };
  });

  const rangeQuery = z.object({
    clientId: z.string().min(1).optional(),
    days: z.coerce.number().int().refine(n => [7, 14, 30, 90].includes(n)).default(30),
    from: z.iso.date().optional(),
    to: z.iso.date().optional()
  }).refine(q => !q.from === !q.to && (!q.from || (q.from <= q.to! && Date.parse(q.to!) - Date.parse(q.from) <= 400 * 86400_000)), 'الفترة مش صح');

  app.get('/ads/overview', async req => {
    const auth = requirePermission(req, 'ads:view');
    const q = rangeQuery.parse(req.query);
    const clientIds = await scope(auth, q.clientId);
    const accounts = await db.adAccount.findMany({ where: { agencyId: auth.agencyId, ...(clientIds === 'all' ? {} : { clientId: { in: clientIds } }) }, select: { id: true, lastSyncAt: true, status: true, timezoneName: true } });
    // "Today" is the latest local day among the accounts, so one east of Cairo is not cut off before Cairo's midnight.
    const to = q.to ?? accounts.reduce((max, a) => { const d = dayIn(a.timezoneName); return d > max ? d : max; }, dayIn(TZ));
    const from = q.from ?? addDays(to, -(q.days - 1));
    const overview = await adsOverview(db, { agencyId: auth.agencyId, clientIds, from, to });
    const synced = accounts.map(a => a.lastSyncAt?.getTime() ?? 0).filter(Boolean);
    return { ...overview, accounts: accounts.length, accountsWithErrors: accounts.filter(a => a.status === 'ERROR').length, syncedAt: synced.length ? new Date(Math.min(...synced)).toISOString() : null };
  });

  app.get('/ads/alerts', async req => {
    const auth = requirePermission(req, 'ads:view');
    const { clientId } = z.object({ clientId: z.string().min(1).optional() }).parse(req.query);
    const clientIds = await scope(auth, clientId);
    const items = await db.adAlert.findMany({
      where: { agencyId: auth.agencyId, resolvedAt: null, ...(clientIds === 'all' ? {} : { clientId: { in: clientIds } }) },
      orderBy: { openedAt: 'desc' }, take: 100,
      select: { id: true, kind: true, detail: true, openedAt: true, clientId: true, campaignId: true, adAccount: { select: { id: true, name: true, currency: true, accountStatus: true, status: true } } }
    });
    return { items, count: items.length };
  });

  /** Hides an alert until its problem clears and comes back (a "stopped" alert until the campaign runs again). */
  app.post<{ Params: { id: string } }>('/ads/alerts/:id/dismiss', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'ads:view');
    const alert = await db.adAlert.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!alert) throw new HttpError(404, 'التنبيه مش موجود', 'not_found');
    await assertClientAccess(db, auth, alert.clientId);
    await db.adAlert.update({ where: { id: alert.id }, data: { resolvedAt: new Date() } });
    await audit(db, auth, 'ads.alert.dismiss', 'AdAlert', alert.id, { kind: alert.kind });
    return { ok: true };
  });
};
