import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fetchInboundMedia, processSocialWebhook, sendQueuedMessage, type Publisher } from '@dosly/core';
import { demoCommentPayload, demoSocialMessagePayload } from '@dosly/shared';
import { db, key, makeApp, owner, reset, store } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const pub: Publisher = { publish() {} };
const PAGE = '1000001', IG = '1784000001';

/** Fake Graph API for comments, the Send API and attachment downloads. */
function graph(files: Record<string, { bytes: Buffer; mime: string }> = {}) {
  const sent: { url: string; method: string; body: any }[] = [];
  let n = 0;
  const fn = (url: string, init?: RequestInit): unknown => {
    const u = new URL(url);
    if (u.hostname.endsWith('fbcdn.net')) {
      const f = files[u.pathname.slice(1)];
      return f ? new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.mime } }) : new Response('gone', { status: 404 });
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : undefined;
    sent.push({ url: u.pathname.replace(/^\/v[\d.]+\//, '') + u.search, method: init?.method ?? 'GET', body });
    if (u.pathname.endsWith('/me/messages')) {
      if (body?.recipient?.comment_id || String(body?.recipient ?? '').includes('comment_id')) return { recipient_id: 'PSID-FROM-COMMENT', message_id: `m_out${++n}` };
      return { recipient_id: 'x', message_id: `m_out${++n}` };
    }
    if (u.pathname.endsWith('/me') && u.searchParams.get('fields')?.includes('instagram_business_account')) return { id: PAGE, instagram_business_account: { id: IG } };
    if (/\/(comments|replies)$/.test(u.pathname)) return { id: `REPLY${++n}` };
    if (u.searchParams.get('fields')?.includes('first_name')) return { first_name: 'سارة', last_name: 'عادل' };
    return { success: true };
  };
  return Object.assign(fn, { sent });
}

async function setup(files: Parameters<typeof graph>[0] = {}) {
  const g = graph(files);
  const { app, calls, fetch } = await makeApp(g);
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
  for (const [platform, externalId] of [['FACEBOOK_PAGE', PAGE], ['INSTAGRAM', IG]]) {
    expect((await as('POST', '/api/channels/social', { clientId: client.id, platform, externalId, name: 'لمسة', accessToken: 'EAAG-page-token-123456789' })).statusCode).toBe(201);
  }
  return { app, calls, as, client, g, fetch, hooks: { key, fetch } };
}

const comment = (o: Partial<Parameters<typeof demoCommentPayload>[0]> = {}) =>
  demoCommentPayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, postId: `${PAGE}_55`, commentId: 'C1', fromId: 'U1', fromName: 'مريم حسن', text: 'بكام؟', ...o });

describe('comments', () => {
  it('subscribes a connected Page to its webhooks, and only for the Page\'s own token and agency', async () => {
    const { g, app, client } = await setup();
    expect(g.sent.find(s => s.url.startsWith(`${PAGE}/subscribed_apps`))?.url).toContain('feed,messages,message_echoes');
    const as = (await owner(app, 'وكالة تانية'));
    const other = (await as('POST', '/api/clients', { name: 'عميل' })).json();
    const taken = await as('POST', '/api/channels/social', { clientId: other.id, platform: 'FACEBOOK_PAGE', externalId: PAGE, name: 'x', accessToken: 'EAAG-other-token-123456' });
    expect(taken.json().error).toBe('account_taken');
    const notOwner = await as('POST', '/api/channels/social', { clientId: other.id, platform: 'FACEBOOK_PAGE', externalId: '5550001', name: 'x', accessToken: 'EAAG-other-token-123456' });
    expect(notOwner.json().error).toBe('not_owner');
    expect(client.id).toBeTruthy();
  });

  it('lists a new comment, replies publicly once, and ignores the echo of that reply', async () => {
    const { as, g, hooks } = await setup();
    await processSocialWebhook(db, comment(), pub, hooks);
    await processSocialWebhook(db, comment(), pub, hooks); // Meta retries: no duplicate
    let list = (await as('GET', '/api/comments')).json();
    expect(list.openCount).toBe(1);
    const c = list.items[0];
    expect(c).toMatchObject({ body: 'بكام؟', authorName: 'مريم حسن', status: 'OPEN', canPrivateReply: true, platform: 'FACEBOOK_PAGE' });

    expect((await as('POST', `/api/comments/${c.id}/reply`, { text: 'بعتنالك التفاصيل' })).statusCode).toBe(201);
    expect(g.sent.at(-1)).toMatchObject({ url: 'C1/comments', method: 'POST', body: { message: 'بعتنالك التفاصيل' } });
    const ours = await db.socialComment.findFirstOrThrow({ where: { fromPage: true } });
    await processSocialWebhook(db, comment({ commentId: ours.externalId, fromId: PAGE, fromName: 'لمسة', text: 'بعتنالك التفاصيل', parentId: 'C1' }), pub, hooks);
    list = (await as('GET', '/api/comments?status=ALL')).json();
    expect(list.openCount).toBe(0);
    expect(list.items[0].status).toBe('DONE');
    expect(list.items[0].replies.filter((r: any) => r.fromPage)).toHaveLength(1);

    // The customer answers inside the thread: it needs attention again.
    await processSocialWebhook(db, comment({ commentId: 'C9', text: 'طب والشحن؟', parentId: 'C1', at: new Date(Date.now() + 2000) }), pub, hooks);
    const reopened = (await as('GET', '/api/comments')).json().items[0];
    expect(reopened.status).toBe('OPEN');
    expect(reopened.replies.find((r: any) => !r.fromPage)).toMatchObject({ body: 'طب والشحن؟' });
  });

  it('sends one private reply into a new Messenger conversation', async () => {
    const { as, g, hooks } = await setup();
    await processSocialWebhook(db, comment(), pub, hooks);
    const c = (await as('GET', '/api/comments')).json().items[0];
    const res = await as('POST', `/api/comments/${c.id}/private-reply`, { text: 'السعر 850 جنيه' });
    expect(res.statusCode).toBe(201);
    expect(g.sent.at(-1)).toMatchObject({ url: 'me/messages', body: { recipient: { comment_id: 'C1' }, message: { text: 'السعر 850 جنيه' } } });
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: res.json().conversationId }, include: { contact: true, messages: true } });
    expect(conv).toMatchObject({ channel: 'MESSENGER', lastInboundAt: null });
    expect(conv.contact).toMatchObject({ externalId: 'PSID-FROM-COMMENT', name: 'مريم حسن' });
    expect(conv.messages[0]).toMatchObject({ direction: 'OUT', body: 'السعر 850 جنيه', status: 'SENT' });
    expect((await as('POST', `/api/comments/${c.id}/private-reply`, { text: 'تاني' })).statusCode).toBe(409);
    // Until the person answers, the conversation cannot take free replies.
    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'إيه رأيك؟' })).statusCode).toBe(409);
  });

  it('hides with each platform\'s field, deletes, and refuses private replies after 7 days', async () => {
    const { as, g, hooks } = await setup();
    await processSocialWebhook(db, comment({ commentId: 'SPAM', text: 'اكسب فلوس' }), pub, hooks);
    await processSocialWebhook(db, comment({ platform: 'INSTAGRAM', accountId: IG, postId: 'M1', commentId: 'IGC', fromName: 'nour.style' }), pub, hooks);
    const items = (await as('GET', '/api/comments')).json().items as any[];
    const fb = items.find(i => i.platform === 'FACEBOOK_PAGE'), ig = items.find(i => i.platform === 'INSTAGRAM');
    await as('POST', `/api/comments/${fb.id}/hide`, { hidden: true });
    expect(g.sent.at(-1)).toMatchObject({ url: 'SPAM', method: 'POST', body: { is_hidden: true } });
    await as('POST', `/api/comments/${ig.id}/hide`, { hidden: true });
    expect(g.sent.at(-1)).toMatchObject({ url: 'IGC', body: { hide: true } });
    expect((await as('DELETE', `/api/comments/${fb.id}`)).statusCode).toBe(200);
    expect(g.sent.at(-1)).toMatchObject({ url: 'SPAM', method: 'DELETE' });
    expect((await as('GET', '/api/comments?status=ALL')).json().items.map((i: any) => i.id)).toEqual([ig.id]);
    await db.socialComment.update({ where: { id: ig.id }, data: { createdAt: new Date(Date.now() - 8 * 86400_000) } });
    expect((await as('POST', `/api/comments/${ig.id}/private-reply`, { text: 'أهلاً' })).statusCode).toBe(409);
  });
});

describe('Messenger and Instagram messages', () => {
  it('creates the conversation with the customer\'s name and replies with the right messaging type', async () => {
    const { as, g, hooks } = await setup();
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID1', text: 'متاح؟' }), pub, hooks);
    const conv = (await as('GET', '/api/conversations?channel=MESSENGER')).json().items[0];
    expect(conv).toMatchObject({ channel: 'MESSENGER', window: 'open', unreadCount: 1, contact: { name: 'سارة عادل' } });
    expect((await as('GET', '/api/conversations?channel=WHATSAPP')).json().items).toHaveLength(0);

    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'أيوه متاح' })).statusCode).toBe(201);
    expect(g.sent.at(-1)).toMatchObject({ url: 'me/messages', body: { recipient: { id: 'PSID1' }, messaging_type: 'RESPONSE', message: { text: 'أيوه متاح' } } });

    await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 30 * 3600_000) } });
    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'لسه محتاج؟' })).statusCode).toBe(201);
    expect(g.sent.at(-1)!.body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });

    await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 8 * 86400_000) } });
    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'هاي' })).json().error).toBe('window_closed');
    expect((await as('GET', `/api/conversations/${conv.id}/templates`)).json().error).toBe('not_whatsapp');
  });

  it('records echoes from other tools, read receipts, and downloads attachments', async () => {
    const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#E1306C' } }).jpeg().toBuffer();
    const { as, hooks, fetch } = await setup({ 'pic.jpg': { bytes: jpeg, mime: 'image/jpeg' } });
    const ig = (o: object) => ({ object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ timestamp: Date.now(), ...o }] }] });
    await processSocialWebhook(db, ig({ sender: { id: 'IGSID' }, recipient: { id: IG }, message: { mid: 'in1', attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/pic.jpg' } }] } }), pub, hooks);
    await processSocialWebhook(db, ig({ sender: { id: IG }, recipient: { id: 'IGSID' }, message: { mid: 'echo1', text: 'رد من تطبيق إنستجرام', is_echo: true } }), pub, hooks);
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    expect(conv.channel).toBe('INSTAGRAM');
    let msgs = (await as('GET', `/api/conversations/${conv.id}/messages`)).json().items;
    expect(msgs.map((m: any) => [m.direction, m.type, m.status])).toEqual([['IN', 'image', 'RECEIVED'], ['OUT', 'text', 'SENT']]);

    expect(await fetchInboundMedia({ db, store, key, pub, fetch }, msgs[0].id)).toBe('ready');
    const media = await as('GET', `/api/messages/${msgs[0].id}/media`);
    // A webhook URL that is not Meta's CDN is never fetched (no SSRF into the server's network).
    await processSocialWebhook(db, ig({ sender: { id: 'IGSID' }, recipient: { id: IG }, message: { mid: 'in2', attachments: [{ type: 'image', payload: { url: 'http://169.254.169.254/latest/meta-data' } }] } }), pub, hooks);
    const evil = await db.message.findUniqueOrThrow({ where: { waMessageId: 'in2' } });
    await expect(fetchInboundMedia({ db, store, key, pub, fetch }, evil.id)).rejects.toThrow('مش من سيرفرات ميتا');
    expect(media.headers['content-type']).toContain('image/jpeg');

    await processSocialWebhook(db, ig({ sender: { id: 'IGSID' }, recipient: { id: IG }, read: { mid: 'echo1' } }), pub, hooks);
    msgs = (await as('GET', `/api/conversations/${conv.id}/messages`)).json().items;
    expect(msgs[1].status).toBe('READ');
  });
});

describe('echoes and retries', () => {
  it('keeps one copy when the echo of our own send is processed before the send returns', async () => {
    const { as, hooks } = await setup();
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID1', text: 'متاح؟' }), pub, hooks);
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    // The fake Send API numbers its ids; the first send gets m_out1, and its echo is delivered first.
    const next = 'm_out1';
    await processSocialWebhook(db, { object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PAGE }, recipient: { id: 'PSID1' }, timestamp: Date.now(), message: { mid: next, text: 'أيوه', is_echo: true } }] }] }, pub, hooks);
    const res = await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'أيوه' });
    expect(res.statusCode).toBe(201);
    const out = await db.message.findMany({ where: { conversationId: conv.id, direction: 'OUT' } });
    expect(out).toHaveLength(1);
    expect(out[0]!.sentById).not.toBeNull();
  });

  it('refuses Instagram text over 1000 bytes and skips unknown feed verbs', async () => {
    const { as, hooks } = await setup();
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'INSTAGRAM', accountId: IG, customerId: 'IGSID', text: 'هاي' }), pub, hooks);
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'ا'.repeat(501) })).json().error).toBe('too_long');
    expect((await as('POST', `/api/conversations/${conv.id}/messages`, { body: 'ا'.repeat(400) })).statusCode).toBe(201);
    await processSocialWebhook(db, { object: 'page', entry: [{ id: PAGE, changes: [{ field: 'feed', value: { item: 'comment', verb: 'block', comment_id: 'X1', post_id: `${PAGE}_1`, from: { id: 'U' } } }] }] }, pub, hooks);
    expect(await db.socialComment.count()).toBe(0);
  });
});

describe('files on Messenger', () => {
  it('sends the file, then the caption as its own message, and never resends the file', async () => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#0866FF' } }).png().toBuffer();
    const { app, as, g, hooks, fetch } = await setup();
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID1', text: 'ابعتلي صورة' }), pub, hooks);
    const conv = (await as('GET', '/api/conversations')).json().items[0];
    const form = new FormData();
    form.set('caption', 'ده الموديل الجديد');
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'صورة.png');
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/attachments`, payload: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type')!, cookie: as.cookie } });
    expect(res.statusCode).toBe(201);
    const deps = { db, store, key, pub, fetch };
    expect(await sendQueuedMessage(deps, res.json().id)).toBe('sent');
    const sends = g.sent.filter(x => x.url === 'me/messages');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toMatchObject({ recipient: JSON.stringify({ id: 'PSID1' }), filedata: '[file]' });
    expect(sends[1]!.body).toMatchObject({ message: { text: 'ده الموديل الجديد' } });
    const out = await db.message.findMany({ where: { conversationId: conv.id, direction: 'OUT' }, orderBy: { createdAt: 'asc' } });
    expect(out.map(m => [m.type, m.status, m.body])).toEqual([['image', 'SENT', null], ['text', 'SENT', 'ده الموديل الجديد']]);
    expect(await sendQueuedMessage(deps, res.json().id)).toBe('skipped');
    expect(g.sent.filter(x => x.url === 'me/messages')).toHaveLength(2);
  });
});
