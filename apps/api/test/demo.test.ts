import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { demoFetch } from '@dosly/shared';
import { deleteExpiredDemos } from '@dosly/core';
import { db, makeApp, owner, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const demoApp = () => makeApp(() => ({ messages: [{ id: `wamid.T${Math.random()}` }] }), { DEMO_MODE: 'true' });
const start = async (app: Awaited<ReturnType<typeof demoApp>>['app'], role = 'OWNER') => {
  const res = await app.inject({ method: 'POST', url: '/api/demo/start', payload: { role } });
  expect(res.statusCode).toBe(200);
  return session(app, res.cookies.find(c => c.name === 'dosly_session')!.value);
};

describe('demo mode', () => {
  it('is not reachable unless DEMO_MODE is on', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/demo/start' })).statusCode).toBe(404);
  });

  it('gives each visitor a private, fully stocked sandbox', async () => {
    const { app } = await demoApp();
    const a = await start(app);
    const b = await start(app);
    const meA = (await a('GET', '/api/me')).json();
    const meB = (await b('GET', '/api/me')).json();
    expect(meA).toMatchObject({ demo: true, role: 'OWNER' });
    expect(meA.agency.id).not.toBe(meB.agency.id);
    expect((await a('GET', '/api/clients')).json()).toHaveLength(4);
    const convs = (await a('GET', '/api/conversations')).json();
    expect(convs.items.length).toBeGreaterThanOrEqual(20);
    expect(await db.message.count({ where: { agencyId: meA.agency.id, createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } })).toBeGreaterThan(50); // a month of history for reports
    expect(convs.items.every((c: { agencyId: string }) => c.agencyId === meA.agency.id)).toBe(true);
  });

  it('switches role inside the same sandbox, and a moderator sees only assigned clients', async () => {
    const { app } = await demoApp();
    const own = await start(app);
    const agencyId = (await own('GET', '/api/me')).json().agency.id;
    const res = await own('POST', '/api/demo/switch', { role: 'MODERATOR' });
    const mod = session(app, res.cookies.find(c => c.name === 'dosly_session')!.value);
    const me = (await mod('GET', '/api/me')).json();
    expect(me).toMatchObject({ role: 'MODERATOR', agency: { id: agencyId } });
    expect((await mod('GET', '/api/clients')).json()).toHaveLength(2);
    expect((await own('GET', '/api/me')).statusCode).toBe(401); // the old session is gone
  });

  it('simulates a new customer and queues receipts after a reply', async () => {
    const { app, calls } = await demoApp();
    const as = await start(app);
    const agencyId = (await as('GET', '/api/me')).json().agency.id;
    const before = await db.conversation.count({ where: { agencyId } });
    expect((await as('POST', '/api/demo/inbound', {})).statusCode).toBe(200);
    expect(await db.conversation.count({ where: { agencyId } })).toBe(before + 1);
    const fresh = (await as('GET', '/api/conversations')).json().items[0];
    const sent = await as('POST', `/api/conversations/${fresh.id}/messages`, { body: 'أهلًا بيك' });
    expect(sent.statusCode).toBe(201);
    expect(calls.demo).toEqual([sent.json().id]);
  });

  it('refuses demo tools on a real agency', async () => {
    const { app } = await demoApp();
    const real = await owner(app);
    expect((await real('POST', '/api/demo/inbound', {})).statusCode).toBe(403);
  });

  it('cleans up expired sandboxes with their users', async () => {
    const { app } = await demoApp();
    const as = await start(app);
    await as('POST', '/api/demo/end');
    expect(await deleteExpiredDemos(db, new Date(Date.now() + 1000))).toBe(1);
    expect(await db.agency.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it('answers the Graph calls Dosly makes without touching the network', async () => {
    const r = await demoFetch('https://graph.facebook.com/v25.0/123/messages', { method: 'POST', headers: { Authorization: 'Bearer x' }, body: '{}' });
    expect((await r.json()).messages[0].id).toMatch(/^wamid\.DEMO/);
    const bad = await demoFetch('https://graph.facebook.com/v25.0/123?fields=id', { headers: { Authorization: 'Bearer demo-fail' } });
    expect(bad.status).toBe(401);
  });
});
