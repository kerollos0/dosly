import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt, hashPassword, newTotpSecret, totpCode } from '@dosly/shared';
import { db, key, makeApp, owner, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

type App = Awaited<ReturnType<typeof makeApp>>['app'];

async function admin(app: App) {
  const secret = newTotpSecret();
  await db.adminUser.create({ data: { email: 'staff@dosly.app', name: 'Staff', passwordHash: await hashPassword('long-admin-password'), totpSecretEnc: encrypt(secret, key) } });
  const login = (code: string) => app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: 'staff@dosly.app', password: 'long-admin-password', code } });
  expect((await login('000000')).statusCode).toBe(401);
  const res = await login(totpCode(secret));
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find(c => c.name === 'dosly_admin')!.value;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, cookies: { dosly_admin: cookie } });
}

describe('Dosly admin', () => {
  it('needs password and an authenticator code, and its cookie is useless elsewhere', async () => {
    const { app } = await makeApp();
    const as = await admin(app);
    expect((await as('GET', '/api/admin/me')).json()).toMatchObject({ name: 'Staff', readOnly: false });
    expect((await as('GET', '/api/me')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode).toBe(401);
  });

  it('lists real agencies and records a manual payment', async () => {
    const { app } = await makeApp();
    await owner(app, 'وكالة النيل');
    const as = await admin(app);
    const list = (await as('GET', '/api/admin/agencies')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: 'وكالة النيل', plan: 'TRIAL', owner: { name: 'كيرلس' } });
    const id = list.items[0].id;
    const paid = await as('POST', `/api/admin/agencies/${id}/payments`, { plan: 'GROWTH', months: 3, amountEgp: 2997, method: 'instapay', reference: 'IP-123' });
    expect(paid.statusCode).toBe(201);
    const detail = (await as('GET', `/api/admin/agencies/${id}`)).json();
    expect(detail.plan).toBe('GROWTH');
    expect(new Date(detail.paidUntil).getTime()).toBeGreaterThan(Date.now() + 80 * 86400_000);
    expect(detail.doslyLog[0].action).toBe('dosly.payment');
    expect((await as('GET', '/api/admin/overview')).json()).toMatchObject({ plans: { GROWTH: 1 }, mrrEgp: 999 });
  });

  it('suspends an agency into read-only and back', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const as = await admin(app);
    const id = (await own('GET', '/api/me')).json().agency.id;
    await as('POST', `/api/admin/agencies/${id}/suspend`, { reason: 'دفع متأخر' });
    expect((await own('GET', '/api/clients')).statusCode).toBe(200);
    const blocked = await own('POST', '/api/clients', { name: 'عميل' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('suspended');
    await as('POST', `/api/admin/agencies/${id}/unsuspend`);
    expect((await own('POST', '/api/clients', { name: 'عميل' })).statusCode).toBe(201);
  });

  it('signs support in as the owner, read-only and on the agency record', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const as = await admin(app);
    const id = (await own('GET', '/api/me')).json().agency.id;
    const res = await as('POST', `/api/admin/agencies/${id}/impersonate`, { reason: 'العميل مش شايف الرسايل' });
    const support = session(app, res.cookies.find(c => c.name === 'dosly_session')!.value);
    expect((await support('GET', '/api/me')).json()).toMatchObject({ role: 'OWNER', support: true });
    expect((await support('POST', '/api/clients', { name: 'x' })).json().error).toBe('support');
    const log = await db.auditLog.findFirst({ where: { agencyId: id, action: 'dosly.support_login' } });
    expect(log?.meta).toMatchObject({ by: 'dosly', reason: 'العميل مش شايف الرسايل' });
  });

  it('turns read-only when the trial ends, and enforces plan limits', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const id = (await own('GET', '/api/me')).json().agency.id;
    for (let i = 0; i < 5; i++) expect((await own('POST', '/api/clients', { name: `عميل ${i}` })).statusCode).toBe(201);
    expect((await own('POST', '/api/clients', { name: 'السادس' })).statusCode).toBe(402);
    await db.agency.update({ where: { id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect((await own('POST', '/api/clients', { name: 'x' })).json().error).toBe('trial_ended');
  });

  it('gives demo visitors a read-only tour limited to demo sandboxes', async () => {
    const { app } = await makeApp(() => ({}), { DEMO_MODE: 'true' });
    await owner(app, 'وكالة حقيقية');
    const start = await app.inject({ method: 'POST', url: '/api/demo/start', payload: {} });
    const visitor = session(app, start.cookies.find(c => c.name === 'dosly_session')!.value);
    const res = await visitor('POST', '/api/demo/admin');
    const cookie = res.cookies.find(c => c.name === 'dosly_admin')!.value;
    const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, cookies: { dosly_admin: cookie } });
    const list = (await as('GET', '/api/admin/agencies')).json();
    expect(list.items.map((a: { name: string }) => a.name)).toEqual(['وكالة نون للتسويق']);
    expect((await as('POST', `/api/admin/agencies/${list.items[0].id}/suspend`, { reason: 'تجربة' })).statusCode).toBe(403);
  });
});
