import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, makeApp, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const demoApp = () => makeApp(() => ({ messages: [{ id: `wamid.T${Math.random()}` }] }), { DEMO_MODE: 'true' });
async function start(app: Awaited<ReturnType<typeof demoApp>>['app'], role: string) {
  const res = await app.inject({ method: 'POST', url: '/api/demo/start', payload: { role } });
  return session(app, res.cookies.find(c => c.name === 'dosly_session')!.value);
}

describe('today', () => {
  it('counts what needs the owner: waiting customers, comments, client changes, ad alerts', async () => {
    const { app } = await demoApp();
    const as = await start(app, 'OWNER');
    const t = (await as('GET', '/api/today')).json();
    expect(t.inbox.waiting).toBeGreaterThan(0);
    expect(t.comments).toBeGreaterThan(0);
    expect(t.posts.changesRequested).toBe(1);
    expect(t.posts.changes[0]).toMatchObject({ note: expect.any(String), client: expect.any(String) });
    expect(t.posts.waitingForClient).toBeGreaterThan(0);
    expect(typeof t.posts.publishingToday).toBe('number');
    expect(t.posts.failed).toBeGreaterThan(0);
    expect(t.adAlerts).not.toBeNull();
  });

  it('only sends each role what it can act on', async () => {
    const { app } = await demoApp();
    const writer = (await (await start(app, 'WRITER'))('GET', '/api/today')).json();
    expect(writer.inbox).toBeNull();
    expect(writer.comments).toBeNull();
    expect(writer.adAlerts).toBeNull();
    expect(writer.posts.draftsToApprove).toBeNull();
    expect(writer.posts.changesRequested).not.toBeNull();
    expect(writer.posts.failed).toBeNull(); // retrying is a manager's button
    const mod = (await (await start(app, 'MODERATOR'))('GET', '/api/today')).json();
    expect(mod.inbox).not.toBeNull();
    expect(mod.posts.changesRequested).toBeNull();
    expect(mod.posts.changes).toEqual([]);
  });
});
