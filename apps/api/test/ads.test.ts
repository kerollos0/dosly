import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { syncAdAccount, syncFrom, type Publisher, type RealtimeEvent } from '@dosly/core';
import { demoAdsGraph } from '@dosly/shared';
import { db, key, makeApp, owner, reset } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const PERFUME = '5550001'; // demo account kind 1: spend cap near, a low lifetime budget, a campaign with issues
const ACADEMY = '5550003'; // kind 3: USD, unpaid bill

/** The demo Marketing API, with switches to fail like Meta does. */
function graph() {
  const state = { fail: null as null | { code: number; sub?: number; headers?: Record<string, string> }, tooBigOnce: false, calls: [] as string[] };
  const fn = (url: string) => {
    const u = new URL(url);
    state.calls.push(u.pathname.replace(/^\/v[\d.]+\//, '') + u.search);
    if (state.tooBigOnce && u.pathname.endsWith('/insights')) {
      state.tooBigOnce = false;
      return new Response(JSON.stringify({ error: { message: 'Please reduce the amount of data', code: 100, error_subcode: 1504018 } }), { status: 400 });
    }
    if (state.fail) return new Response(JSON.stringify({ error: { message: 'meta says no', code: state.fail.code, error_subcode: state.fail.sub } }), { status: 400, headers: state.fail.headers });
    return demoAdsGraph(u) ?? { id: 'x' };
  };
  return Object.assign(fn, { state });
}

async function setup() {
  const g = graph();
  const { app, calls, fetch } = await makeApp(g);
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
  const events: RealtimeEvent[] = [];
  const pub: Publisher = { publish: (_a, e) => { events.push(e); } };
  const sync = (id: string, now?: Date, force = true) => syncAdAccount({ db, key, pub, fetch }, id, now, force);
  return { app, calls, g, as, client, sync, events };
}

describe('ads', () => {
  it('connects an ad account after Meta confirms the token can read it, then queues a sync', async () => {
    const { as, client, calls, g } = await setup();
    const res = await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: `act_${PERFUME}`, accessToken: 'EAAG-system-user-token-123' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Lamsa Perfumes', currency: 'EGP' });
    expect(calls.adSyncs).toEqual([res.json().id]);
    const row = await db.adAccount.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(row.accessTokenEnc).not.toContain('EAAG');
    expect(row.spendCapMinor).toBe(15_000_000n);
    // the token never comes back
    expect((await as('GET', '/api/ads/accounts')).body).not.toContain('accessToken');

    g.state.fail = { code: 190 };
    const bad = await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: '5550002', accessToken: 'EAAG-system-user-token-123' });
    expect(bad.statusCode).toBe(400);
    expect(await db.adAccount.count()).toBe(1);
    expect((await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: 'act_12x', accessToken: 'EAAG-system-user-token-123' })).statusCode).toBe(400);
  });

  it('syncs campaigns and daily numbers, opens alerts, and keeps money in minor units', async () => {
    const { as, client, sync, events } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    const r = await sync(id);
    expect(r).toMatchObject({ status: 'synced', campaigns: 3 });
    const camps = await db.adCampaign.findMany({ where: { adAccountId: id } });
    expect(camps.find(c => c.name.includes('عود'))?.dailyBudgetMinor).toBe(120_000n);
    const days = await db.adInsightDaily.count();
    expect(days).toBeGreaterThan(150);
    const kinds = (await db.adAlert.findMany()).map(a => a.kind).sort();
    expect(kinds).toEqual(['BUDGET_LOW', 'CAMPAIGN_ISSUES', 'SPEND_CAP_NEAR']);
    expect(events.filter(e => e.type === 'ads.alert')).toHaveLength(3);

    // A second sync is idempotent: same rows, no duplicate alerts or events.
    events.length = 0;
    await db.adAccount.update({ where: { id }, data: { throttledUntil: null } });
    await sync(id);
    expect(await db.adInsightDaily.count()).toBe(days);
    expect(await db.adAlert.count()).toBe(3);
    expect(events.filter(e => e.type === 'ads.alert')).toHaveLength(0);

    const o = (await as('GET', `/api/ads/overview?days=30&clientId=${client.id}`)).json();
    expect(o.currencies).toHaveLength(1);
    expect(o.currencies[0].currency).toBe('EGP');
    expect(o.currencies[0].daily).toHaveLength(30);
    const sum = o.campaigns.reduce((s: number, c: { spendMinor: number }) => s + c.spendMinor, 0);
    expect(o.currencies[0].totals.spendMinor).toBe(sum);
    const sales = o.campaigns.find((c: { name: string }) => c.name.includes('عود'));
    expect(sales.result).toBe('purchases');
    expect(sales.costPerResultMinor).toBe(Math.round(sales.spendMinor / sales.purchases));
  });

  it('flags a campaign that stopped since the last sync, and clears it when it runs again', async () => {
    const { as, client, sync } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: '5550002', accessToken: 'EAAG-system-user-token-123' })).json().id; // clinic
    await sync(id);
    expect(await db.adAlert.count()).toBe(0); // first look: nothing to compare with
    const paused = await db.adCampaign.findFirstOrThrow({ where: { effectiveStatus: 'PAUSED' } });
    await db.adCampaign.update({ where: { id: paused.id }, data: { checkedStatus: 'DELIVERING' } }); // as if it was running last time
    await sync(id);
    const a = await db.adAlert.findFirstOrThrow();
    expect(a).toMatchObject({ kind: 'CAMPAIGN_STOPPED', campaignId: paused.id });
    // Dismissed: stays hidden on the next sync while the campaign is still paused.
    expect((await as('POST', `/api/ads/alerts/${a.id}/dismiss`)).statusCode).toBe(200);
    await sync(id);
    expect((await as('GET', '/api/ads/alerts')).json().count).toBe(0);
  });

  it('keeps currencies apart and flags an unpaid account', async () => {
    const { as, client, sync } = await setup();
    const a = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    const b = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: ACADEMY, accessToken: 'EAAG-system-user-token-123' })).json().id;
    await sync(a); await sync(b);
    const o = (await as('GET', '/api/ads/overview?days=7')).json();
    expect(o.currencies.map((c: { currency: string }) => c.currency).sort()).toEqual(['EGP', 'USD']);
    expect((await db.adAlert.findMany({ where: { adAccountId: b } })).map(x => x.kind)).toEqual(['ACCOUNT_PROBLEM']);
  });

  it('stops on a dead token, backs off when Meta throttles, and splits a query that is too big', async () => {
    const { as, client, sync, g } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;

    g.state.fail = { code: 80004, headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ call_count: 100, estimated_time_to_regain_access: 30 }] }) } };
    expect((await sync(id)).status).toBe('throttled');
    const t = await db.adAccount.findUniqueOrThrow({ where: { id } });
    expect(t.throttledUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect((await sync(id)).status).toBe('throttled'); // no call while throttled
    expect((await as('POST', `/api/ads/accounts/${id}/sync`)).statusCode).toBe(429);

    await db.adAccount.update({ where: { id }, data: { throttledUntil: null } });
    g.state.fail = { code: 190 };
    expect((await sync(id)).status).toBe('token_error');
    expect((await db.adAccount.findUniqueOrThrow({ where: { id } })).status).toBe('ERROR');
    expect((await db.adAlert.findFirstOrThrow()).kind).toBe('ACCOUNT_PROBLEM');
    expect((await as('POST', `/api/ads/accounts/${id}/sync`)).statusCode).toBe(409);
    // Reconnecting with a working token clears the error and its alert.
    g.state.fail = null;
    await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-new-system-user-token' });
    expect((await db.adAccount.findUniqueOrThrow({ where: { id } })).status).toBe('CONNECTED');
    expect(await db.adAlert.count()).toBe(0);

    // "Too much data": the 90-day range is retried in halves.
    g.state.tooBigOnce = true;
    const calls0 = g.state.calls.length;
    expect((await sync(id)).status).toBe('synced');
    const insightCalls = g.state.calls.slice(calls0).filter(c => c.includes('/insights'));
    expect(insightCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('is for owners and managers, scoped to the agency', async () => {
    const { app, as, client } = await setup();
    const link = (await as('POST', '/api/team/invites', { email: 'mod@test.eg', role: 'MODERATOR' })).json().link as string;
    const acc = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'منى', password: 'moderator-pass-1' } });
    const cookie = acc.cookies.find(c => c.name === 'dosly_session')!.value;
    const mod = (m: string, u: string) => app.inject({ method: m as 'GET', url: u, cookies: { dosly_session: cookie } });
    expect((await mod('GET', '/api/ads/overview')).statusCode).toBe(403);

    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    const other = await owner(app, 'وكالة تانية');
    expect((await other('GET', '/api/ads/accounts')).json()).toEqual([]);
    expect((await other('DELETE', `/api/ads/accounts/${id}`)).statusCode).toBe(404);
    expect((await other('GET', `/api/ads/overview?clientId=${client.id}`)).statusCode).toBe(404);
  });

  it('shows ads in the client report unless the agency hides them', async () => {
    const { as, client, sync } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    await sync(id);
    expect((await as('GET', `/api/clients/${client.id}/report`)).json().ads).toBeNull(); // hidden until the agency opts in
    await as('PUT', `/api/clients/${client.id}/portal/settings`, { showAdsInPortal: true });
    const rep = (await as('GET', `/api/clients/${client.id}/report`)).json();
    expect(rep.ads.currencies[0].totals.spendMinor).toBeGreaterThan(0);
    expect(rep.ads.campaigns[0]).not.toHaveProperty('dailyBudgetMinor');
    expect(rep.ads.currencies[0].byResult.purchases.costPerResultMinor).toBe(Math.round(rep.ads.currencies[0].byResult.purchases.spendMinor / rep.ads.currencies[0].byResult.purchases.results));
  });

  it('marks campaigns Meta no longer returns as removed, and re-reads from before an outage', async () => {
    const { as, client, sync } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    await sync(id);
    const ghost = await db.adCampaign.create({ data: { adAccountId: id, externalId: '999', name: 'قديمة', status: 'ACTIVE', effectiveStatus: 'ACTIVE', checkedStatus: 'DELIVERING' } });
    await sync(id);
    expect(await db.adCampaign.findUniqueOrThrow({ where: { id: ghost.id } })).toMatchObject({ status: 'DELETED', effectiveStatus: 'DELETED' });
    expect(await db.adAlert.count({ where: { campaignId: ghost.id } })).toBe(0); // removed, not "stopped"

    expect(syncFrom('2026-11-20', 'Africa/Cairo', null, null)).toBe('2026-08-23');
    expect(syncFrom('2026-11-20', 'Africa/Cairo', new Date('2026-11-20T09:00:00Z'), '2026-08-23')).toBe('2026-10-24');
    expect(syncFrom('2026-11-20', 'Africa/Cairo', new Date('2026-10-01T09:00:00Z'), '2026-08-23')).toBe('2026-09-04'); // 28 days before the last good sync
    expect(syncFrom('2026-11-20', 'Africa/Cairo', new Date('2026-01-01T09:00:00Z'), '2025-10-01')).toBe('2026-08-23'); // never more than 90
  });

  it('leaves ad spend out of the report for staff without ads access', async () => {
    const { app, as, client, sync } = await setup();
    const id = (await as('POST', '/api/ads/accounts', { clientId: client.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).json().id;
    await sync(id);
    await as('PUT', `/api/clients/${client.id}/portal/settings`, { showAdsInPortal: true });
    const link = (await as('POST', '/api/team/invites', { email: 'w@test.eg', role: 'WRITER' })).json().link as string;
    const acc = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'سارة', password: 'writer-pass-123' } });
    const cookie = acc.cookies.find(c => c.name === 'dosly_session')!.value;
    const me = (await app.inject({ method: 'GET', url: '/api/me', cookies: { dosly_session: cookie } })).json();
    expect((await as('PUT', `/api/clients/${client.id}/assignments`, { userIds: [me.user.id] })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: `/api/clients/${client.id}/report`, cookies: { dosly_session: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ads).toBeNull();
    expect(res.json().inbox).toBeDefined();
    // Moving an account to another client needs it disconnected first.
    const other = (await as('POST', '/api/clients', { name: 'عميل تاني' })).json();
    expect((await as('POST', '/api/ads/accounts', { clientId: other.id, adAccountId: PERFUME, accessToken: 'EAAG-system-user-token-123' })).statusCode).toBe(409);
  });
});
