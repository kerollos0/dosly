import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processSocialWebhook, processWhatsAppWebhook, runCommentRules, sendQueuedMessage, type Publisher } from '@dosly/core';
import { demoCommentPayload, demoSocialMessagePayload, isOpen, matchKeyword, normalizeAr } from '@dosly/shared';
import { db, key, makeApp, owner, reset, store } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const pub: Publisher = { publish() {} };
const PHONE = '1445980835268099', PAGE = '1000001', IG = '1784000001';

function graph() {
  const sent: { url: string; body: any }[] = [];
  let n = 0;
  const fn = (url: string, init?: RequestInit): unknown => {
    const u = new URL(url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url: u.pathname.replace(/^\/v[\d.]+\//, ''), body });
    if (u.pathname.endsWith('/me/messages')) return { recipient_id: body?.recipient?.comment_id ? 'PSID-FROM-COMMENT' : 'x', message_id: `m_out${++n}` };
    if (u.pathname.endsWith('/messages')) return { messages: [{ id: `wamid.AUTO${++n}` }] };
    if (u.pathname.endsWith('/me') && u.searchParams.get('fields')?.includes('instagram_business_account')) return { id: PAGE, instagram_business_account: { id: IG } };
    if (/\/(comments|replies)$/.test(u.pathname)) return { id: `REPLY${++n}` };
    return { success: true, display_phone_number: '+20 10 0000 0000', verified_name: 'Test' };
  };
  return Object.assign(fn, { sent });
}

async function setup() {
  const g = graph();
  const { app, calls, fetch } = await makeApp(g);
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'كافيه نسمة' })).json();
  await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: PHONE, wabaId: '1', accessToken: 'EAAG-test-token-123456789' });
  for (const [platform, externalId] of [['FACEBOOK_PAGE', PAGE], ['INSTAGRAM', IG]]) {
    await as('POST', '/api/channels/social', { clientId: client.id, platform, externalId, name: 'نسمة', accessToken: 'EAAG-page-token-123456789' });
  }
  const sends: string[] = [];
  const hooks = { key, fetch, onSend: async (id: string) => { sends.push(id); }, onComment: async () => {} };
  const rule = async (body: object) => { const r = await as('POST', '/api/automations', { clientId: client.id, ...body }); expect(r.statusCode, r.body).toBeLessThan(300); return r.json().id as string; };
  return { app, calls, as, client, g, fetch, hooks, sends, rule, deps: { db, store, key, pub, fetch } };
}

const waText = (from: string, body: string, at = new Date()) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PHONE }, contacts: [{ wa_id: from, profile: { name: 'مريم حسن' } }],
  messages: [{ from, id: `wamid.in.${Math.random()}`, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'text', text: { body } }]
} }] }] });
const comment = (o: Partial<Parameters<typeof demoCommentPayload>[0]> = {}) =>
  demoCommentPayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, postId: `${PAGE}_55`, commentId: 'C1', fromId: 'U1', fromName: 'مريم حسن', text: 'بكام؟', ...o });

describe('automatic replies', () => {
  it('matches Arabic loosely and knows working hours in Cairo', () => {
    expect(normalizeAr('السِّعر كاااام؟ ١٠٠')).toBe('السعر كام 100');
    expect(matchKeyword('وبكام الكومبو ده', ['بكام'])).toBe('بكام');
    expect(matchKeyword('عايزة أعرف الأسعار', ['اسعار'])).toBe('اسعار');
    expect(matchKeyword('كامل العدد', ['كم'])).toBeNull(); // short words only on their own
    expect(matchKeyword('كم السعر', ['كم'])).toBe('كم');
    expect(matchKeyword('كامل العدد', ['كام'])).toBeNull(); // "كام" is not inside "كامل"
    expect(matchKeyword('سعرات حرارية', ['سعر'])).toBeNull();
    expect(matchKeyword('سعره كام؟', ['السعر'])).toBe('السعر');
    expect(matchKeyword('بكاااام ده', ['بكام'])).toBe('بكام');
    expect(matchKeyword('فين العنوان بالظبط', ['العنوان بالظبط'])).toBe('العنوان بالظبط');
    const h = { days: [0, 1, 2, 3, 4], from: '10:00', to: '22:00' };
    // 2026-11-22 is a Sunday; Cairo is UTC+2 in November.
    expect(isOpen(h, new Date('2026-11-22T09:00:00Z'))).toBe(true);
    expect(isOpen(h, new Date('2026-11-22T21:00:00Z'))).toBe(false);
    expect(isOpen(h, new Date('2026-11-27T09:00:00Z'))).toBe(false); // Friday
    const night = { days: [5], from: '18:00', to: '02:00' };
    expect(isOpen(night, new Date('2026-11-27T23:30:00Z'))).toBe(true); // Saturday 01:30 Cairo, still Friday's shift
  });

  it('validates rules and keeps one welcome per client', async () => {
    const s = await setup();
    expect((await s.as('POST', '/api/automations', { clientId: s.client.id, kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: [], reply: 'x' })).statusCode).toBe(400);
    expect((await s.as('POST', '/api/automations', { clientId: s.client.id, kind: 'COMMENT', platforms: ['INSTAGRAM'], keywords: [], publicReplies: [] })).statusCode).toBe(400);
    const a = await s.rule({ kind: 'WELCOME', channels: ['WHATSAPP'], reply: 'أهلًا' });
    const b = await s.rule({ kind: 'WELCOME', channels: ['WHATSAPP', 'INSTAGRAM'], reply: 'أهلًا بيك' });
    expect(a).toBe(b);
    const opts = (await s.as('GET', '/api/automations/options')).json();
    expect(opts[0]).toMatchObject({ channels: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'], platforms: expect.arrayContaining(['FACEBOOK_PAGE', 'INSTAGRAM']), active: 1 });
    expect((await s.as('PATCH', `/api/automations/${a}`, { enabled: false })).statusCode).toBe(200);
    expect((await s.as('GET', `/api/automations?clientId=${s.client.id}`)).json().rules[0]).toMatchObject({ enabled: false, reply: 'أهلًا بيك' });
  });

  it('answers a keyword with the customer\'s name, welcomes once, and never twice in 2 minutes', async () => {
    const s = await setup();
    await s.rule({ kind: 'WELCOME', channels: ['WHATSAPP'], reply: 'أهلًا يا [الاسم] 👋' });
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: ['بكام', 'السعر'], reply: 'الكومبو بـ 220 جنيه' });
    await processWhatsAppWebhook(db, waText('201000000001', 'مساء الخير'), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    const first = await db.message.findUniqueOrThrow({ where: { id: s.sends[0]! } });
    expect(first).toMatchObject({ body: 'أهلًا يا مريم 👋', status: 'QUEUED', sentById: null });
    expect(await sendQueuedMessage(s.deps, first.id)).toBe('sent');
    expect(s.g.sent.at(-1)!.body).toMatchObject({ to: '201000000001', type: 'text', text: { body: 'أهلًا يا مريم 👋' } });
    // Within 2 minutes nothing more, even for a keyword.
    await processWhatsAppWebhook(db, waText('201000000001', 'بكام الكومبو؟'), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    // Later: the keyword answers; the welcome does not repeat.
    const conv = await db.conversation.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    await db.conversation.update({ where: { id: conv.id }, data: { autoReplyAt: new Date(Date.now() - 5 * 60_000) } });
    await processWhatsAppWebhook(db, waText('201000000001', 'السعر كام'), pub, s.hooks);
    expect(s.sends).toHaveLength(2);
    expect((await db.message.findUniqueOrThrow({ where: { id: s.sends[1]! } })).body).toBe('الكومبو بـ 220 جنيه');
    // The inbox shows them as automatic, and the chat still needs a person.
    const msgs = (await s.as('GET', `/api/conversations/${conv.id}/messages`)).json();
    const items = msgs.items ?? msgs;
    expect(items.filter((m: any) => m.auto)).toHaveLength(2);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).unreadCount).toBe(3);
  });

  it('stays quiet while a person from the team is in the chat', async () => {
    const s = await setup();
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: ['بكام'], reply: 'السعر 220' });
    await processWhatsAppWebhook(db, waText('201000000002', 'ازيك'), pub, s.hooks);
    const conv = await db.conversation.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    expect((await s.as('POST', `/api/conversations/${conv.id}/messages`, { body: 'أهلًا، أقدر أساعدك إزاي؟' })).statusCode).toBe(201);
    await processWhatsAppWebhook(db, waText('201000000002', 'بكام؟'), pub, s.hooks);
    expect(s.sends).toHaveLength(0);
  });

  it('sends the away message outside working hours, once per 12 hours, on Messenger too', async () => {
    const s = await setup();
    // Open no day at all: always "closed".
    await s.rule({ kind: 'AWAY', channels: ['MESSENGER'], reply: 'إحنا قافلين دلوقتي، هنرد عليك الصبح', hours: { days: [1], from: '00:00', to: '00:01' } });
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID9', text: 'متاح؟' }), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    expect(await sendQueuedMessage(s.deps, s.sends[0]!)).toBe('sent');
    expect(s.g.sent.at(-1)).toMatchObject({ url: 'me/messages', body: { recipient: { id: 'PSID9' }, message: { text: 'إحنا قافلين دلوقتي، هنرد عليك الصبح' }, messaging_type: 'RESPONSE' } });
    const conv = await db.conversation.findFirstOrThrow({ where: { channel: 'MESSENGER' } });
    await db.conversation.update({ where: { id: conv.id }, data: { autoReplyAt: new Date(Date.now() - 10 * 60_000) } });
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID9', text: 'طب تمام' }), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    // WhatsApp is not in this rule.
    await processWhatsAppWebhook(db, waText('201000000003', 'متاح؟'), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
  });

  it('answers a comment under the post and in private, once per person per post', async () => {
    const s = await setup();
    await s.rule({ kind: 'COMMENT', platforms: ['FACEBOOK_PAGE'], keywords: ['بكام', 'السعر'], publicReplies: ['بعتنالك السعر في الرسايل يا [الاسم] 💬'], reply: 'أهلًا يا [الاسم]، الكومبو بـ 220 جنيه' });
    const calls: string[] = [];
    await processSocialWebhook(db, comment(), pub, { ...s.hooks, onComment: async id => { calls.push(id); } });
    expect(calls).toHaveLength(1);
    const r = await runCommentRules({ db, pub, key, fetch: s.fetch }, calls[0]!);
    expect(r).toMatchObject({ publicReply: true, privateReply: true });
    expect(s.g.sent.find(x => x.url === 'C1/comments')!.body).toEqual({ message: 'بعتنالك السعر في الرسايل يا مريم 💬' });
    expect(s.g.sent.find(x => x.url === 'me/messages')!.body).toMatchObject({ recipient: { comment_id: 'C1' }, message: { text: 'أهلًا يا مريم، الكومبو بـ 220 جنيه' } });
    const c = await db.socialComment.findFirstOrThrow({ where: { externalId: 'C1' } });
    expect(c).toMatchObject({ status: 'DONE', privateReplyAt: expect.any(Date) });
    const list = (await s.as('GET', '/api/comments?status=ALL')).json();
    expect(list.items[0]).toMatchObject({ auto: true, canPrivateReply: false });
    expect(list.items[0].replies[0]).toMatchObject({ fromPage: true, auto: true });
    const conv = await db.conversation.findFirstOrThrow({ where: { channel: 'MESSENGER' } });
    expect(conv.status).toBe('CLOSED'); // nothing to answer until they write back
    // Running twice, or the same person again on the same post: nothing more.
    expect(await runCommentRules({ db, pub, key, fetch: s.fetch }, c.id)).toBeNull();
    await processSocialWebhook(db, comment({ commentId: 'C2', text: 'السعر؟' }), pub, s.hooks);
    const c2 = await db.socialComment.findFirstOrThrow({ where: { externalId: 'C2' } });
    expect(await runCommentRules({ db, pub, key, fetch: s.fetch }, c2.id)).toBeNull();
    // Someone else, no keyword: no rule fits.
    await processSocialWebhook(db, comment({ commentId: 'C3', fromId: 'U3', text: 'شكله حلو' }), pub, s.hooks);
    expect(await runCommentRules({ db, pub, key, fetch: s.fetch }, (await db.socialComment.findFirstOrThrow({ where: { externalId: 'C3' } })).id)).toBeNull();
    const rule = (await s.as('GET', `/api/automations?clientId=${s.client.id}`)).json().rules[0];
    expect(rule).toMatchObject({ fired: 1, lastError: null });
  });

  it('a rule for one post wins over a general one, and a failed send leaves the comment for a person', async () => {
    const s = await setup();
    await s.rule({ kind: 'COMMENT', platforms: ['FACEBOOK_PAGE'], keywords: [], publicReplies: ['شكرًا ❤️'] });
    const special = await s.rule({ kind: 'COMMENT', platforms: ['FACEBOOK_PAGE'], keywords: [], postExternalId: `${PAGE}_77`, postLabel: 'عرض الجمعة', publicReplies: [], reply: 'تفاصيل عرض الجمعة' });
    await processSocialWebhook(db, comment({ postId: `${PAGE}_77`, commentId: 'C7' }), pub, s.hooks);
    const r = await runCommentRules({ db, pub, key, fetch: s.fetch }, (await db.socialComment.findFirstOrThrow({ where: { externalId: 'C7' } })).id);
    expect(r).toMatchObject({ ruleId: special, privateReply: true, publicReply: false });

    const broken = async () => new Response(JSON.stringify({ error: { message: 'Permissions error', code: 200 } }), { status: 403 });
    await processSocialWebhook(db, comment({ commentId: 'C8', fromId: 'U8' }), pub, s.hooks);
    const c8 = await db.socialComment.findFirstOrThrow({ where: { externalId: 'C8' } });
    const r2 = await runCommentRules({ db, pub, key, fetch: broken as typeof fetch }, c8.id);
    expect(r2?.error).toContain('الرد تحت الكومنت');
    expect(await db.socialComment.findUniqueOrThrow({ where: { id: c8.id } })).toMatchObject({ status: 'OPEN', autoRuleId: null });
    // Freed: once Meta works again the same comment is answered.
    expect(await runCommentRules({ db, pub, key, fetch: s.fetch }, c8.id)).toMatchObject({ publicReply: true });
    // A network failure is retried by the worker (the job throws).
    await processSocialWebhook(db, comment({ commentId: 'C9', fromId: 'U9' }), pub, s.hooks);
    const down = async () => { throw new TypeError('fetch failed'); };
    await expect(runCommentRules({ db, pub, key, fetch: down as typeof fetch }, (await db.socialComment.findFirstOrThrow({ where: { externalId: 'C9' } })).id)).rejects.toThrow();
  });
  it('offers and order messages do not pause it, replies from the phone app do, and another bot gets at most 3', async () => {
    const s = await setup();
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP', 'MESSENGER'], keywords: ['بكام'], reply: 'السعر 220' });
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: ['المنيو'], reply: 'المنيو هنا' });
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: ['العنوان'], reply: 'التجمع الخامس' });
    await s.rule({ kind: 'KEYWORD', channels: ['WHATSAPP'], keywords: ['مواعيد'], reply: 'من 8 لـ 1' });
    await processWhatsAppWebhook(db, waText('201000000005', 'أهلا'), pub, s.hooks);
    const conv = await db.conversation.findFirstOrThrow({ where: { channel: 'WHATSAPP' } });
    const owner = await db.user.findFirstOrThrow();
    // An offer sent by the owner a minute ago is not a person talking.
    await db.message.create({ data: { agencyId: conv.agencyId, conversationId: conv.id, direction: 'OUT', type: 'template', body: 'عرض', status: 'SENT', sentById: owner.id, payload: { kind: 'template', broadcastId: 'b1' } } });
    const ago = () => db.conversation.update({ where: { id: conv.id }, data: { autoReplyAt: new Date(Date.now() - 5 * 60_000) } });
    await processWhatsAppWebhook(db, waText('201000000005', 'بكام؟'), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    // The same keyword again soon: not repeated.
    await ago(); await processWhatsAppWebhook(db, waText('201000000005', 'بكام يعني'), pub, s.hooks);
    expect(s.sends).toHaveLength(1);
    await ago(); await processWhatsAppWebhook(db, waText('201000000005', 'المنيو'), pub, s.hooks);
    await ago(); await processWhatsAppWebhook(db, waText('201000000005', 'العنوان'), pub, s.hooks);
    expect(s.sends).toHaveLength(3);
    await ago(); await processWhatsAppWebhook(db, waText('201000000005', 'مواعيد'), pub, s.hooks);
    expect(s.sends).toHaveLength(3); // the daily cap without a person
    // An old (replayed) webhook is never answered.
    await processWhatsAppWebhook(db, waText('201000000006', 'بكام؟', new Date(Date.now() - 3600_000)), pub, s.hooks);
    expect(s.sends).toHaveLength(3);
    // Messenger: the moderator answered from Business Suite (an echo): quiet for half an hour.
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID7', text: 'ازيك' }), pub, s.hooks);
    const mconv = await db.conversation.findFirstOrThrow({ where: { channel: 'MESSENGER' } });
    await db.message.create({ data: { agencyId: mconv.agencyId, conversationId: mconv.id, direction: 'OUT', type: 'text', body: 'أهلًا', status: 'SENT', waMessageId: 'm_echo_1' } });
    await processSocialWebhook(db, demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: PAGE, customerId: 'PSID7', text: 'بكام؟' }), pub, s.hooks);
    expect(s.sends).toHaveLength(3);
  });

  it('two comments from one person at the same moment get one reply', async () => {
    const s = await setup();
    await s.rule({ kind: 'COMMENT', platforms: ['FACEBOOK_PAGE'], keywords: [], publicReplies: ['شكرًا ❤️'], reply: 'أهلًا' });
    await processSocialWebhook(db, comment({ commentId: 'D1' }), pub, s.hooks);
    await processSocialWebhook(db, comment({ commentId: 'D2', text: 'ممكن السعر' }), pub, s.hooks);
    const ids = (await db.socialComment.findMany({ where: { externalId: { in: ['D1', 'D2'] } } })).map(c => c.id);
    const rs = await Promise.all(ids.map(id => runCommentRules({ db, pub, key, fetch: s.fetch }, id)));
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(s.g.sent.filter(x => x.url === 'me/messages')).toHaveLength(1);
  });
});
