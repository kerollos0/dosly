import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '@dosly/shared';
import { processWhatsAppWebhook } from '@dosly/core';
import { db, key, makeApp, owner, reset, session, sign } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

describe('auth', () => {
  it('signs up, reads /me, logs out', async () => {
    const { app } = await makeApp();
    const as = await owner(app);
    const me = await as('GET', '/api/me');
    expect(me.json()).toMatchObject({ role: 'OWNER', agency: { name: 'وكالة النيل' } });
    await as('POST', '/api/auth/logout');
    expect((await as('GET', '/api/me')).statusCode).toBe(401);
  });

  it('rejects a wrong password with an Arabic message', async () => {
    const { app } = await makeApp();
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { agencyName: 'X Agency', name: 'Ali', email: 'ali@test.eg', password: 'very-secret-pass' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ali@test.eg', password: 'nope-nope-nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('الإيميل أو الباسورد غلط');
  });

  it('never stores the raw session token', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { agencyName: 'X Agency', name: 'Ali', email: 'ali2@test.eg', password: 'very-secret-pass' } });
    const token = res.cookies.find(c => c.name === 'dosly_session')!.value;
    expect(await db.session.findUnique({ where: { id: token } })).toBeNull();
    expect(res.cookies[0]!.httpOnly).toBe(true);
  });
});

describe('tenancy and roles', () => {
  it('keeps agencies apart', async () => {
    const { app } = await makeApp();
    const a = await owner(app, 'وكالة أ');
    const b = await owner(app, 'وكالة ب');
    const client = (await a('POST', '/api/clients', { name: 'مطعم الريس' })).json();
    expect((await b('GET', '/api/clients')).json()).toEqual([]);
    expect((await b('PATCH', `/api/clients/${client.id}`, { name: 'hacked' })).statusCode).toBe(404);
  });

  it('shows moderators only their assigned clients, and they cannot manage clients', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const c1 = (await own('POST', '/api/clients', { name: 'عميل 1' })).json();
    await own('POST', '/api/clients', { name: 'عميل 2' });
    const link = (await own('POST', '/api/team/invites', { email: 'mod@test.eg', role: 'MODERATOR' })).json().link as string;
    const accept = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'منى', password: 'moderator-pass-1' } });
    expect(accept.statusCode).toBe(200);
    const mod = session(app, accept.cookies.find(c => c.name === 'dosly_session')!.value);
    const modUser = await db.user.findUniqueOrThrow({ where: { email: 'mod@test.eg' } });
    await own('PUT', `/api/clients/${c1.id}/assignments`, { userIds: [modUser.id] });
    expect((await mod('GET', '/api/clients')).json().map((c: { name: string }) => c.name)).toEqual(['عميل 1']);
    expect((await mod('POST', '/api/clients', { name: 'x' })).statusCode).toBe(403);
    // the invite link works only once
    expect((await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'منى', password: 'moderator-pass-1' } })).statusCode).toBe(410);
  });
});

describe('webhooks', () => {
  it('answers the Meta verification challenge', async () => {
    const { app } = await makeApp();
    const ok = await app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=42' });
    expect(ok.body).toBe('42');
    expect((await app.inject({ url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42' })).statusCode).toBe(403);
  });

  it('stores signed events, queues them, and rejects unsigned ones', async () => {
    const { app, calls } = await makeApp();
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const bad = await app.inject({ method: 'POST', url: '/webhooks/meta', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/webhooks/meta', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } });
    expect(good.statusCode).toBe(200);
    expect(calls.webhooks).toHaveLength(1);
    expect(await db.webhookEvent.count()).toBe(1);
  });
});

describe('inbox', () => {
  async function setup(graph = (url: string) => (url.includes('/messages') ? { messages: [{ id: 'wamid.OUT1' }] } : { display_phone_number: '+1 555 149 7547', verified_name: 'Test' })) {
    const { app, calls } = await makeApp(graph);
    const as = await owner(app);
    const client = (await as('POST', '/api/clients', { name: 'مطعم الريس' })).json();
    const connect = await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: '1445980835268017', wabaId: '1', accessToken: 'EAAG-test-token-123456789' });
    expect(connect.statusCode).toBe(201);
    const num = await db.whatsAppNumber.findFirstOrThrow();
    expect(num.accessTokenEnc).not.toContain('EAAG');
    return { app, calls, as, client };
  }
  const inbound = (ts: number) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1445980835268017' }, contacts: [{ wa_id: '201116123614', profile: { name: 'كيرلس' } }], messages: [{ from: '201116123614', id: `wamid.${ts}`, timestamp: String(ts), type: 'text', text: { body: 'السعر كام؟' } }] } }] }] });

  it('lists conversations and replies inside the 24h window', async () => {
    const { as, calls } = await setup();
    await processWhatsAppWebhook(db, inbound(Math.floor(Date.now() / 1000)), { publish() {} });
    const list = (await as('GET', '/api/conversations')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ windowOpen: true, unreadCount: 1, contact: { name: 'كيرلس' } });
    const sent = await as('POST', `/api/conversations/${list.items[0].id}/messages`, { body: 'أهلا بيك، السعر 250 ج.م' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ status: 'SENT', waMessageId: 'wamid.OUT1' });
    expect(calls.graph.at(-1)!.body).toMatchObject({ to: '201116123614', text: { body: 'أهلا بيك، السعر 250 ج.م' } });
    const msgs = (await as('GET', `/api/conversations/${list.items[0].id}/messages`)).json();
    expect(msgs.items.map((m: { direction: string }) => m.direction)).toEqual(['IN', 'OUT']);
  });

  it('blocks free-form replies after 24 hours', async () => {
    const { as } = await setup();
    await processWhatsAppWebhook(db, inbound(Math.floor(Date.now() / 1000) - 25 * 3600), { publish() {} });
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    const res = await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('window_closed');
  });

  it('records a failed send with the reason', async () => {
    const { as } = await setup(url => (url.includes('/messages') ? new Response(JSON.stringify({ error: { message: 'Recipient not in allowed list', code: 131030 } }), { status: 400 }) : { display_phone_number: '+1 555', verified_name: 'T' }));
    await processWhatsAppWebhook(db, inbound(Math.floor(Date.now() / 1000)), { publish() {} });
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    const res = await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'hi' });
    expect(res.statusCode).toBe(502);
    expect((await db.message.findFirstOrThrow({ where: { direction: 'OUT' } })).status).toBe('FAILED');
  });

  it('paginates conversations with a cursor', async () => {
    const { as } = await setup();
    const num = await db.whatsAppNumber.findFirstOrThrow();
    for (let i = 0; i < 5; i++) {
      const c = await db.contact.create({ data: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, waId: `2010000000${i}` } });
      await db.conversation.create({ data: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, contactId: c.id, lastMessageAt: new Date(Date.now() - i * 1000) } });
    }
    const p1 = (await as('GET', '/api/conversations?limit=2')).json();
    const p2 = (await as('GET', `/api/conversations?limit=2&cursor=${p1.nextCursor}`)).json();
    const p3 = (await as('GET', `/api/conversations?limit=2&cursor=${p2.nextCursor}`)).json();
    const ids = [...p1.items, ...p2.items, ...p3.items].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
  });
});

describe('posts', () => {
  it('writers draft, managers approve, and approval schedules the job', async () => {
    const { app, calls } = await makeApp(() => ({ id: '111' }));
    const own = await owner(app);
    const client = (await own('POST', '/api/clients', { name: 'مطعم الريس' })).json();
    const page = (await own('POST', '/api/channels/social', { clientId: client.id, platform: 'FACEBOOK_PAGE', externalId: '111', name: 'Page', accessToken: 'EAAG-page-token-12345' })).json();
    const link = (await own('POST', '/api/team/invites', { email: 'w@test.eg', role: 'WRITER' })).json().link as string;
    const acc = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'سارة', password: 'writer-pass-123' } });
    const writer = session(app, acc.cookies.find(c => c.name === 'dosly_session')!.value);
    const w = await db.user.findUniqueOrThrow({ where: { email: 'w@test.eg' } });
    await own('PUT', `/api/clients/${client.id}/assignments`, { userIds: [w.id] });

    const at = new Date(Date.now() + 3600_000).toISOString();
    const draft = await writer('POST', '/api/posts', { clientId: client.id, caption: 'عرض الجمعة 🔥', socialAccountIds: [page.id], scheduledAt: at });
    expect(draft.json().status).toBe('DRAFT');
    expect(calls.scheduled).toHaveLength(0);
    expect((await writer('POST', `/api/posts/${draft.json().id}/approve`)).statusCode).toBe(403);
    const ok = await own('POST', `/api/posts/${draft.json().id}/approve`);
    expect(ok.json().status).toBe('SCHEDULED');
    expect(calls.scheduled[0]!.postId).toBe(draft.json().id);
  });

  it('refuses Instagram posts without an image', async () => {
    const { app } = await makeApp(() => ({ id: '222' }));
    const own = await owner(app);
    const client = (await own('POST', '/api/clients', { name: 'C' })).json();
    const ig = (await own('POST', '/api/channels/social', { clientId: client.id, platform: 'INSTAGRAM', externalId: '222', name: 'IG', accessToken: 'EAAG-ig-token-123456' })).json();
    const res = await own('POST', '/api/posts', { clientId: client.id, caption: 'x', socialAccountIds: [ig.id] });
    expect(res.json().error).toBe('instagram_needs_image');
  });

  it('accepts real images only', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const form = (bytes: Buffer) => {
      const b = '----dosly';
      return { payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), bytes, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
    };
    const cookie = own.cookie;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const good = await app.inject({ method: 'POST', url: '/api/uploads', ...form(png), headers: { ...form(png).headers, cookie } });
    expect(good.statusCode).toBe(201);
    expect(good.json().url).toMatch(/^http:\/\/localhost:3000\/media\/\d{4}\/\d{2}\/.+\.png$/);
    const fake = await app.inject({ method: 'POST', url: '/api/uploads', ...form(Buffer.from('<?php echo 1;')), headers: { ...form(Buffer.from('<?php')).headers, cookie } });
    expect(fake.statusCode).toBe(400);
  });
});
