import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { broadcastStats, cancelBroadcast, processWhatsAppWebhook, sendBroadcastBatch, startBroadcast, type Publisher, type RealtimeEvent } from '@dosly/core';
import { DEMO_TEMPLATES, isStopRequest, firstNameOf } from '@dosly/shared';
import { db, key, makeApp, owner, reset, session, store } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const PHONE = '1445980835268017';
const events: RealtimeEvent[] = [];
const pub: Publisher = { publish: (_a, e) => { events.push(e); } };

/** A fake Graph API that records sends and uploads, and can answer a send with an error. */
function graph() {
  const sent: { to: string; template: { name: string; components?: { type: string; parameters: { text?: string; image?: { id: string } }[] }[] } }[] = [];
  const uploads: string[] = [];
  let failNext: { code: number; status: number; times: number } | null = null;
  const fn = (url: string, init?: RequestInit): unknown => {
    if (url.endsWith('/media') && init?.method === 'POST') { uploads.push(String((init.body as FormData).get('type'))); return { id: `UP${uploads.length}` }; }
    if (url.endsWith('/messages')) {
      if (failNext && failNext.times > 0) { failNext.times--; return new Response(JSON.stringify({ error: { message: 'nope', code: failNext.code } }), { status: failNext.status }); }
      const body = JSON.parse(String(init!.body));
      sent.push(body);
      return { messages: [{ id: `wamid.BC${sent.length}` }] };
    }
    return { display_phone_number: '+20 10 0000 0000', verified_name: 'Test' };
  };
  return Object.assign(fn, { sent, uploads, fail: (code: number, status = 400, times = 1) => { failNext = { code, status, times }; } });
}

async function setup(people = 3) {
  const g = graph();
  const { app, calls, fetch } = await makeApp(g);
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'كافيه نسمة' })).json();
  const num = (await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: PHONE, wabaId: '1', accessToken: 'EAAG-test-token-123456789' })).json();
  const agencyId = (await db.client.findUniqueOrThrow({ where: { id: client.id } })).agencyId;
  const tpl = async (name: string, status = 'APPROVED') => {
    const t = DEMO_TEMPLATES.find(x => x.name === name)!;
    return db.waTemplate.create({ data: { agencyId, waNumberId: num.id, metaId: t.id, name: t.name, language: t.language, status, category: t.category, parameterFormat: t.parameter_format ?? 'POSITIONAL', components: t.components as object } });
  };
  const offer = await tpl('weekend_offer');
  const imageOffer = await tpl('monthly_offer');
  const names = ['مريم حسن', 'أحمد سمير', '🌸🌸', 'يوسف عادل', 'نور', 'كريم'];
  const contacts = [];
  for (let i = 0; i < people; i++) {
    const c = await db.contact.create({ data: { agencyId, clientId: client.id, waNumberId: num.id, waId: `2010000000${i}`, name: names[i % names.length] } });
    await db.conversation.create({ data: { agencyId, clientId: client.id, waNumberId: num.id, contactId: c.id, status: 'CLOSED', lastInboundAt: new Date(Date.now() - (i + 1) * 86400_000) } });
    contacts.push(c);
  }
  const deps = { db, store, key, pub, fetch };
  const values = { 'body.1': '[الاسم]', 'body.2': 'كومبو فطار بـ 220 جنيه', 'body.3': 'الجمعة' };
  const create = async (over: Record<string, unknown> = {}) => as('POST', '/api/broadcasts', { waNumberId: num.id, templateId: offer.id, name: 'عرض الويك إند', values, audience: { kind: 'all' }, consent: true, ...over });
  return { app, calls, as, client, num, agencyId, offer, imageOffer, contacts, deps, g, values, create, tpl };
}

/** What the worker does: start, then batches until done. */
async function run(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await startBroadcast(db, pub, id);
  for (let i = 0; i < 20; i++) { const r = await sendBroadcastBatch(s.deps, id, { batch: 2, concurrency: 2 }); if (r.done || r.slowDown) return r; }
  throw new Error('never finished');
}

const statusHook = (waMessageId: string, status: string, error?: { code: number; title: string }) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PHONE }, statuses: [{ id: waMessageId, status, timestamp: String(Math.floor(Date.now() / 1000)), ...(error && { errors: [error] }) }]
} }] }] });
const textHook = (from: string, body: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PHONE }, contacts: [{ wa_id: from, profile: { name: 'x' } }],
  messages: [{ from, id: `wamid.in.${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }]
} }] }] });

describe('broadcast rules', () => {
  it('knows stop words and safe first names', () => {
    expect(isStopRequest('إيقاف')).toBe('clear');
    expect(isStopRequest(' ايقاف العروض ')).toBe('clear');
    expect(isStopRequest('STOP')).toBe('short');
    expect(isStopRequest('إلغاء الطلب')).toBe(false); // an order cancel is not an opt-out
    expect(isStopRequest('عايز أوقف الطلب بتاعي عشان هسافر')).toBe(false);
    expect(firstNameOf('مريم حسن')).toBe('مريم');
    expect(firstNameOf('🌸🌸')).toBe('حضرتك');
    expect(firstNameOf(null)).toBe('حضرتك');
  });
});

describe('broadcasts', () => {
  it('lists only approved marketing and utility templates, and counts the audience with a cost estimate', async () => {
    const s = await setup(3);
    await s.tpl('new_menu', 'PENDING');
    const opts = (await s.as('GET', '/api/broadcasts/options')).json();
    expect(opts[0].numbers[0].templates.map((t: { name: string }) => t.name).sort()).toEqual(['monthly_offer', 'weekend_offer']);
    const a = (await s.as('POST', '/api/broadcasts/audience', { waNumberId: s.num.id, templateId: s.offer.id, audience: { kind: 'all' } })).json();
    expect(a).toMatchObject({ people: 3, optedOut: 0, category: 'MARKETING', overNewLimit: false });
    expect(a.costUsd).toBeCloseTo(0.19, 2);
    const recent = (await s.as('POST', '/api/broadcasts/audience', { waNumberId: s.num.id, audience: { kind: 'recent', days: 2 } })).json();
    expect(recent.people).toBe(1);
  });

  it('refuses without consent, with empty fields, with an image template but no image, and to moderators', async () => {
    const s = await setup(2);
    expect((await s.create({ consent: false })).statusCode).toBe(400);
    expect((await s.create({ values: { 'body.1': '[الاسم]', 'body.2': '', 'body.3': 'الجمعة' } })).statusCode).toBe(400);
    expect((await s.create({ values: { ...s.values, 'body.2': 'سطر\nتاني' } })).statusCode).toBe(400);
    expect((await s.create({ templateId: s.imageOffer.id, values: { 'body.customer_name': '[الاسم]', 'body.discount': '20%', 'body.end_date': 'الجمعة' } })).json().error).toBe('header_required');
    expect((await s.create({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).statusCode).toBe(400);

    const link = (await s.as('POST', '/api/team/invites', { email: 'mod@test.eg', role: 'MODERATOR' })).json().link as string;
    const acc = await s.app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'منى', password: 'moderator-pass-1' } });
    const mod = session(s.app, acc.cookies.find(c => c.name === 'dosly_session')!.value);
    expect((await mod('POST', '/api/broadcasts', { waNumberId: s.num.id, templateId: s.offer.id, name: 'x', values: s.values, audience: { kind: 'all' }, consent: true })).statusCode).toBe(403);

    const other = await owner(s.app, 'وكالة تانية');
    expect((await other('POST', '/api/broadcasts/audience', { waNumberId: s.num.id, audience: { kind: 'all' } })).statusCode).toBe(404);
    expect(await db.broadcast.count()).toBe(0);
  });

  it('sends each person their own message with their first name, in their chat, once', async () => {
    const s = await setup(3);
    const res = await s.create();
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(s.calls.broadcasts).toEqual([id]);
    const r = await run(s, id);
    expect(r.done).toBe(true);
    expect(s.g.sent).toHaveLength(3);
    const firstParams = s.g.sent.map(m => m.template.components![0]!.parameters[0]!.text).sort();
    expect(firstParams).toEqual(['أحمد', 'حضرتك', 'مريم'].sort());
    expect(s.g.sent.every(m => m.template.name === 'weekend_offer')).toBe(true);
    const b = await db.broadcast.findUniqueOrThrow({ where: { id } });
    expect(b).toMatchObject({ status: 'DONE', total: 3 });
    expect(await db.message.count({ where: { type: 'template', status: 'SENT' } })).toBe(3);

    // Run again (a retried job): nobody gets it twice.
    await startBroadcast(db, pub, id);
    await sendBroadcastBatch(s.deps, id);
    expect(s.g.sent).toHaveLength(3);

    // The same offer again the same day skips everyone (one marketing message a day per person).
    const again = await s.as('POST', '/api/broadcasts/audience', { waNumberId: s.num.id, templateId: s.offer.id, audience: { kind: 'all' } });
    expect(again.json()).toMatchObject({ people: 0, gotOneToday: 3 });
  });

  it('starts a new chat closed so the inbox is not flooded, and opens it when the customer replies', async () => {
    const s = await setup(0);
    const c = await db.contact.create({ data: { agencyId: s.agencyId, clientId: s.client.id, waNumberId: s.num.id, waId: '201099999999', name: 'سارة' } });
    const order = await db.storeOrder.findFirst(); expect(order).toBeNull();
    // A buyer who never chatted: reachable through "bought before".
    const store = await db.storeConnection.create({ data: { agencyId: s.agencyId, clientId: s.client.id, kind: 'EASYORDERS', name: 'متجر', hookId: 'h1', secretEnc: 'x' } });
    await db.storeOrder.create({ data: { agencyId: s.agencyId, clientId: s.client.id, storeId: store.id, externalId: 'o1', number: '1', status: 'DELIVERED', currency: 'EGP', totalMinor: 50000n, contactId: c.id, waId: c.waId, placedAt: new Date(Date.now() - 86400_000), items: [] } });
    const id = (await s.create({ audience: { kind: 'buyers' } })).json().id;
    await run(s, id);
    const conv = await db.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    expect(conv).toMatchObject({ status: 'CLOSED', unreadCount: 0 });
    await processWhatsAppWebhook(db, textHook('201099999999', 'بكام الكومبو؟'), pub);
    expect(await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ status: 'OPEN', unreadCount: 1 });
    expect((await db.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: id } })).repliedAt).not.toBeNull();
  });

  it('waits on Meta throttling, fails people WhatsApp rejects for good, and can be cancelled', async () => {
    const s = await setup(4);
    const id = (await s.create()).json().id;
    await startBroadcast(db, pub, id);
    s.g.fail(130429, 400, 1);
    const r1 = await sendBroadcastBatch(s.deps, id, { batch: 1, concurrency: 1 });
    expect(r1).toMatchObject({ slowDown: true, sent: 0, failed: 0, done: false });
    expect(await db.broadcastRecipient.count({ where: { broadcastId: id, state: 'PENDING' } })).toBe(4);

    s.g.fail(131026, 400, 1);
    const r2 = await sendBroadcastBatch(s.deps, id, { batch: 1, concurrency: 1 });
    expect(r2).toMatchObject({ failed: 1 });
    const failed = await db.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: id, state: 'FAILED' } });
    expect(failed.errorCode).toBe(131026);
    const detail = (await s.as('GET', `/api/broadcasts/${id}?show=failed`)).json();
    expect(detail.recipients[0].error).toContain('مش عليه واتساب');

    await sendBroadcastBatch(s.deps, id, { batch: 1, concurrency: 1 });
    expect(await cancelBroadcast(db, pub, s.agencyId, id)).toBe(true);
    const r3 = await sendBroadcastBatch(s.deps, id);
    expect(r3.done).toBe(true);
    expect(s.g.sent).toHaveLength(1); // the throttled one went later; nothing after the cancel
    const st = (await broadcastStats(db, [id])).get(id)!;
    expect(st).toMatchObject({ total: 4, sent: 1, failed: 1, pending: 2 });
    expect((await s.as('POST', `/api/broadcasts/${id}/cancel`)).statusCode).toBe(409);
  });

  it('stops the whole campaign when the account itself is blocked, and never sends a claimed person twice', async () => {
    const s = await setup(4);
    const id = (await s.create()).json().id;
    await startBroadcast(db, pub, id);
    // Another run holds one person right now: this run leaves them alone.
    const held = await db.broadcastRecipient.findFirstOrThrow({ where: { broadcastId: id } });
    await db.broadcastRecipient.update({ where: { id: held.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    await sendBroadcastBatch(s.deps, id, { batch: 1, concurrency: 1 });
    expect(s.g.sent).toHaveLength(1);
    expect(s.g.sent[0]!.to).not.toBe(s.contacts.find(c => c.id === held.contactId)!.waId);
    // 131031: the business account is locked. Nobody else gets it, and the reason shows on everyone left.
    s.g.fail(131031, 400, 1);
    const r = await sendBroadcastBatch(s.deps, id, { batch: 1, concurrency: 1 });
    expect(r.done).toBe(true);
    expect((await db.broadcast.findUniqueOrThrow({ where: { id } })).status).toBe('DONE');
    expect(await db.broadcastRecipient.count({ where: { broadcastId: id, state: 'PENDING' } })).toBe(0);
    expect(await db.message.count({ where: { payload: { path: ['broadcastId'], equals: id }, status: 'QUEUED' } })).toBe(0);
    expect(s.g.sent).toHaveLength(1);
  });

  it('a short "stop" opts out only right after an offer', async () => {
    const s = await setup(2);
    const [a] = s.contacts;
    // No offer yet: "وقف" is about something else.
    await processWhatsAppWebhook(db, textHook(a!.waId!, 'وقف'), pub, { onSend: async () => {} });
    expect((await db.contact.findUniqueOrThrow({ where: { id: a!.id } })).marketingOptOutAt).toBeNull();
    await run(s, (await s.create()).json().id);
    await processWhatsAppWebhook(db, textHook(a!.waId!, 'وقف'), pub, { onSend: async () => {} });
    expect((await db.contact.findUniqueOrThrow({ where: { id: a!.id } })).marketingOptOutAt).not.toBeNull();
    // Opting out does not hide the chat from the team.
    const conv = await db.conversation.findFirstOrThrow({ where: { contactId: a!.id } });
    expect(conv.unreadCount).toBeGreaterThan(0);
  });

  it('remembers who stopped offers: the stop word, and Meta error 131050', async () => {
    const s = await setup(3);
    const id = (await s.create()).json().id;
    await run(s, id);
    const [a, b] = s.contacts;
    // "إيقاف": opted out, and told so in the chat.
    await processWhatsAppWebhook(db, textHook(a!.waId!, 'إيقاف'), pub, { onSend: async () => {} });
    expect((await db.contact.findUniqueOrThrow({ where: { id: a!.id } })).marketingOptOutAt).not.toBeNull();
    expect(await db.message.findFirst({ where: { body: { contains: 'مش هنبعتلك رسايل عروض' } } })).not.toBeNull();
    // 131050 in a failed receipt: opted out and the person shows as failed.
    const msgB = await db.message.findFirstOrThrow({ where: { conversation: { contactId: b!.id }, type: 'template' } });
    await processWhatsAppWebhook(db, statusHook(msgB.waMessageId!, 'failed', { code: 131050, title: 'User has stopped marketing messages' }), pub);
    expect((await db.contact.findUniqueOrThrow({ where: { id: b!.id } })).marketingOptOutAt).not.toBeNull();
    expect((await db.broadcastRecipient.findFirstOrThrow({ where: { contactId: b!.id } })).state).toBe('FAILED');
    // Later broadcasts leave both out (and the third got an offer today).
    const later = (await s.as('POST', '/api/broadcasts/audience', { waNumberId: s.num.id, templateId: s.offer.id, audience: { kind: 'all' } })).json();
    expect(later).toMatchObject({ people: 0, optedOut: 2 });
  });

  it('counts deliveries, reads, replies and the orders that followed', async () => {
    const s = await setup(3);
    const id = (await s.create()).json().id;
    await run(s, id);
    const msgs = await db.message.findMany({ where: { type: 'template' }, orderBy: { waMessageId: 'asc' } });
    await processWhatsAppWebhook(db, statusHook(msgs[0]!.waMessageId!, 'read'), pub);
    await processWhatsAppWebhook(db, statusHook(msgs[1]!.waMessageId!, 'delivered'), pub);
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: msgs[0]!.conversationId } });
    const buyer = await db.contact.findUniqueOrThrow({ where: { id: conv.contactId } });
    await processWhatsAppWebhook(db, textHook(buyer.waId!, 'عايز أطلب'), pub);
    const store = await db.storeConnection.create({ data: { agencyId: s.agencyId, clientId: s.client.id, kind: 'EASYORDERS', name: 'متجر', hookId: 'h2', secretEnc: 'x' } });
    await db.storeOrder.create({ data: { agencyId: s.agencyId, clientId: s.client.id, storeId: store.id, externalId: 'o2', number: '2', status: 'PENDING', currency: 'EGP', totalMinor: 22000n, contactId: buyer.id, waId: buyer.waId, placedAt: new Date(Date.now() + 60_000), items: [] } });
    const st = (await broadcastStats(db, [id])).get(id)!;
    expect(st).toMatchObject({ total: 3, sent: 3, delivered: 2, read: 1, replied: 1, orders: 1, sales: [{ currency: 'EGP', minor: 22000 }] });
    const list = (await s.as('GET', '/api/broadcasts')).json();
    expect(list.items[0]).toMatchObject({ name: 'عرض الويك إند', status: 'DONE', stats: { replied: 1 } });
    expect(list.items[0].template).toBeUndefined();
  });

  it('uploads the header image to WhatsApp once for everyone', async () => {
    const s = await setup(3);
    const form = new FormData();
    form.set('data', JSON.stringify({ waNumberId: s.num.id, templateId: s.imageOffer.id, name: 'عرض الشهر', values: { 'body.customer_name': '[الاسم]', 'body.discount': '20%', 'body.end_date': 'الجمعة' }, audience: { kind: 'all' }, consent: true }));
    const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#e0a030' } }).png().toBuffer();
    form.set('header', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'offer.png');
    const req = new Request('http://x', { method: 'POST', body: form });
    const res = await s.app.inject({ method: 'POST', url: '/api/broadcasts', cookies: { dosly_session: s.as.cookie.split('=')[1]! }, payload: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type')! } });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect((await s.as('GET', `/api/broadcasts/${id}/header`)).statusCode).toBe(200);
    await run(s, id);
    expect(s.g.uploads).toEqual(['image/png']);
    expect(s.g.sent).toHaveLength(3);
    for (const m of s.g.sent) expect(m.template.components!.find(c => c.type === 'header')!.parameters[0]!.image!.id).toBe('UP1');
  });

  it('a scheduled broadcast waits for its time', async () => {
    const s = await setup(2);
    const at = new Date(Date.now() + 3 * 3600_000);
    const id = (await s.create({ scheduledAt: at.toISOString() })).json().id;
    expect(await startBroadcast(db, pub, id)).toBeNull();
    expect(await startBroadcast(db, pub, id, new Date(at.getTime() + 1000))).toBe(2);
    expect(await startBroadcast(db, pub, id, new Date(at.getTime() + 2000))).toBeNull(); // a second worker gets nothing
  });
});
