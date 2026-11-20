import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fetchInboundMedia, processWhatsAppWebhook, sendQueuedMessage, type Publisher } from '@dosly/core';
import { DEMO_TEMPLATES, type MetaTemplate } from '@dosly/shared';
import { db, key, makeApp, owner, reset, store } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const PHONE = '1445980835268017';
const nullPub: Publisher = { publish() {} };
const jpeg = () => sharp({ create: { width: 1200, height: 800, channels: 3, background: '#0E9F94' } }).jpeg().toBuffer();

/** A fake Graph API: media info and downloads for inbound files, uploads and sends for outbound ones. */
function graph(files: Record<string, { bytes: Buffer; mime: string; sha?: string }> = {}) {
  const sent: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const fn = (url: string, init?: RequestInit): unknown => {
    const u = new URL(url);
    if (u.hostname === 'cdn.test') {
      const f = files[u.pathname.slice(1)];
      return f ? new Response(new Uint8Array(f.bytes), { headers: { 'content-type': f.mime } }) : new Response('gone', { status: 404 });
    }
    const id = u.pathname.split('/').pop()!;
    if (url.endsWith('/media') && init?.method === 'POST') { uploads.push(String((init.body as FormData).get('type'))); return { id: `UP${uploads.length}` }; }
    if (url.endsWith('/messages')) { sent.push(JSON.parse(String(init!.body))); return { messages: [{ id: `wamid.OUT${sent.length}` }] }; }
    if (url.includes('message_templates')) return { data: DEMO_TEMPLATES };
    if (files[id]) { const f = files[id]!; return { url: `https://cdn.test/${id}`, mime_type: f.mime, sha256: f.sha ?? createHash('sha256').update(f.bytes).digest('hex'), file_size: f.bytes.length, id }; }
    return { display_phone_number: '+20 10 0000 0000', verified_name: 'Test' };
  };
  return Object.assign(fn, { sent, uploads });
}

async function setup(files: Parameters<typeof graph>[0] = {}) {
  const g = graph(files);
  const { app, calls, fetch } = await makeApp(g);
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
  expect((await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: PHONE, wabaId: '102030', accessToken: 'EAAG-test-token-123456789' })).statusCode).toBe(201);
  const deps = { db, store, key, pub: nullPub, fetch };
  return { app, calls, as, client, g, deps };
}

const inbound = (message: Record<string, unknown>, at = Date.now()) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PHONE }, contacts: [{ wa_id: '201116123614', profile: { name: 'ريم' } }],
  messages: [{ from: '201116123614', id: `wamid.${Math.random()}`, timestamp: String(Math.floor(at / 1000)), ...message }]
} }] }] });

async function multipart(fields: Record<string, string>, file?: { name: string; bytes: Buffer; type?: string; field?: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set(file.field ?? 'file', new Blob([new Uint8Array(file.bytes)], { type: file.type ?? 'application/octet-stream' }), file.name);
  const req = new Request('http://x', { method: 'POST', body: form });
  return { payload: Buffer.from(await req.arrayBuffer()), headers: { 'content-type': req.headers.get('content-type')! } };
}

describe('inbound media', () => {
  it('downloads a photo into private storage, checks it, and serves it only to the agency', async () => {
    const photo = await jpeg();
    const { app, as, deps, calls } = await setup({ IMG1: { bytes: photo, mime: 'image/jpeg' } });
    await processWhatsAppWebhook(db, inbound({ type: 'image', image: { id: 'IMG1', mime_type: 'image/jpeg', caption: 'عايزة ده' } }), nullPub, { onMedia: async id => { calls.fetchMedia.push(id); } });
    const msg = await db.message.findFirstOrThrow({ where: { type: 'image' } });
    expect(msg).toMatchObject({ mediaStatus: 'PENDING', body: 'عايزة ده' });
    expect(calls.fetchMedia).toEqual([msg.id]);
    expect((await db.conversation.findFirstOrThrow()).lastPreview).toBe('عايزة ده');

    expect(await fetchInboundMedia(deps, msg.id)).toBe('ready');
    expect(await fetchInboundMedia(deps, msg.id)).toBe('skipped'); // idempotent
    const ready = await db.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(ready).toMatchObject({ mediaStatus: 'READY', mediaSize: photo.length, mediaWidth: 1200, mediaHeight: 800 });
    expect(ready.previewKey).toMatch(/-thumb\.webp$/);

    const res = await as('GET', `/api/messages/${msg.id}/media`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.compare(res.rawPayload, photo)).toBe(0);
    const part = await app.inject({ method: 'GET', url: `/api/messages/${msg.id}/media`, headers: { range: 'bytes=0-99', cookie: as.cookie } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${photo.length}`);
    expect((await as('GET', `/api/messages/${msg.id}/media?v=preview`)).headers['content-type']).toBe('image/webp');

    const list = (await as('GET', `/api/conversations/${msg.conversationId}/messages`)).json().items;
    expect(list[0]).toMatchObject({ hasMedia: true, hasPreview: true });
    expect(list[0].mediaKey).toBeUndefined(); // storage paths never reach the browser

    const other = await owner(app, 'وكالة تانية');
    expect((await other('GET', `/api/messages/${msg.id}/media`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/messages/${msg.id}/media` })).statusCode).toBe(401);
  });

  it('refuses a download whose checksum does not match, so the job retries', async () => {
    const { deps } = await setup({ IMG2: { bytes: await jpeg(), mime: 'image/jpeg', sha: 'a'.repeat(64) } });
    await processWhatsAppWebhook(db, inbound({ type: 'image', image: { id: 'IMG2', mime_type: 'image/jpeg' } }), nullPub);
    const msg = await db.message.findFirstOrThrow({ where: { type: 'image' } });
    await expect(fetchInboundMedia(deps, msg.id)).rejects.toThrow('checksum');
    expect((await db.message.findUniqueOrThrow({ where: { id: msg.id } })).mediaStatus).toBe('PENDING');
  });

  it('gives voice notes a browser-friendly copy and a duration', async () => {
    const voice = await readFile(new URL('../../../packages/shared/demo-assets/voice.ogg', import.meta.url));
    const { deps } = await setup({ VN: { bytes: voice, mime: 'audio/ogg; codecs=opus' } });
    await processWhatsAppWebhook(db, inbound({ type: 'audio', audio: { id: 'VN', mime_type: 'audio/ogg; codecs=opus', voice: true } }), nullPub);
    const msg = await db.message.findFirstOrThrow({ where: { type: 'audio' } });
    expect(msg.voice).toBe(true);
    expect((await db.conversation.findFirstOrThrow()).lastPreview).toBe('رسالة صوتية');
    await fetchInboundMedia(deps, msg.id);
    const ready = await db.message.findUniqueOrThrow({ where: { id: msg.id } });
    expect(ready.previewKey).toMatch(/-play\.m4a$/);
    expect(ready.durationSec).toBeGreaterThan(4);
  });
});

describe('sending attachments', () => {
  async function openConversation(s: Awaited<ReturnType<typeof setup>>) {
    await processWhatsAppWebhook(db, inbound({ type: 'text', text: { body: 'السعر كام؟' } }), nullPub);
    return db.conversation.findFirstOrThrow();
  }

  it('queues a photo with its caption, then uploads and sends it', async () => {
    const s = await setup();
    const conv = await openConversation(s);
    const res = await s.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/attachments`, cookies: { dosly_session: s.as.cookie.split('=')[1]! }, ...(await multipart({ caption: 'ده المتاح' }, { name: 'p.jpg', bytes: await jpeg(), type: 'image/jpeg' })) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'image', status: 'QUEUED', body: 'ده المتاح' });
    expect(s.calls.sends).toEqual([res.json().id]);
    expect(await sendQueuedMessage(s.deps, res.json().id)).toBe('sent');
    expect(s.g.uploads).toEqual(['image/jpeg']);
    expect(s.g.sent.at(-1)).toMatchObject({ to: '201116123614', type: 'image', image: { id: 'UP1', caption: 'ده المتاح' } });
    expect(await sendQueuedMessage(s.deps, res.json().id)).toBe('skipped'); // a retried job never sends twice
  });

  it('turns a browser recording into a WhatsApp voice note', async () => {
    const s = await setup();
    const conv = await openConversation(s);
    const webm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=1.5', '-c:a', 'libopus', '-f', 'webm', '-']);
    const res = await s.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/attachments`, cookies: { dosly_session: s.as.cookie.split('=')[1]! }, ...(await multipart({ voice: 'true' }, { name: 'voice.webm', bytes: webm, type: 'audio/webm' })) });
    expect(res.statusCode).toBe(201);
    await sendQueuedMessage(s.deps, res.json().id);
    expect(s.g.uploads).toEqual(['audio/ogg']);
    expect(s.g.sent.at(-1)).toMatchObject({ type: 'audio', audio: { id: 'UP1', voice: true } });
    const msg = await db.message.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(msg.mediaKey).toMatch(/-wa\.ogg$/);
  });

  it('rejects files WhatsApp does not take, and replies after the 24h window', async () => {
    const s = await setup();
    const conv = await openConversation(s);
    const cookies = { dosly_session: s.as.cookie.split('=')[1]! };
    const exe = await s.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/attachments`, cookies, ...(await multipart({}, { name: 'x.zip', bytes: Buffer.from('PK\x03\x04aaaa') })) });
    expect(exe.statusCode).toBe(400);
    expect(exe.json().error).toBe('bad_media');
    await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } });
    const late = await s.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/attachments`, cookies, ...(await multipart({}, { name: 'p.jpg', bytes: await jpeg() })) });
    expect(late.statusCode).toBe(409);
  });
});

describe('templates', () => {
  async function withTemplates() {
    const s = await setup();
    await processWhatsAppWebhook(db, inbound({ type: 'text', text: { body: 'مرحبا' } }, Date.now() - 30 * 3600_000), nullPub); // window closed
    const conv = await db.conversation.findFirstOrThrow();
    const num = await db.whatsAppNumber.findFirstOrThrow();
    await db.waTemplate.createMany({ data: DEMO_TEMPLATES.map((t: MetaTemplate) => ({ agencyId: num.agencyId, waNumberId: num.id, metaId: t.id, name: t.name, language: t.language, status: t.status, category: t.category, parameterFormat: t.parameter_format!, components: t.components as never })) });
    await db.whatsAppNumber.update({ where: { id: num.id }, data: { templatesSyncedAt: new Date() } });
    const list = (await s.as('GET', `/api/conversations/${conv.id}/templates`)).json();
    return { ...s, conv, list, byName: (n: string) => list.items.find((t: { name: string }) => t.name === n) };
  }

  it('lists approved templates first and sends one after the window has closed', async () => {
    const s = await withTemplates();
    expect(s.list.windowOpen).toBe(false);
    expect(s.list.items[0].status).toBe('APPROVED');
    const res = await s.as('POST', `/api/conversations/${s.conv.id}/template`, { templateId: s.byName('order_follow_up').id, values: { 'body.1': 'ريم' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'template', body: expect.stringContaining('أهلاً ريم'), template: { buttons: ['وصل تمام', 'عندي مشكلة'] } });
    await sendQueuedMessage(s.deps, res.json().id);
    expect(s.g.sent.at(-1)).toMatchObject({ type: 'template', template: { name: 'order_follow_up', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'ريم' }] }] } });
  });

  it('refuses templates that are not approved, missing values, and media headers without a file', async () => {
    const s = await withTemplates();
    expect((await s.as('POST', `/api/conversations/${s.conv.id}/template`, { templateId: s.byName('new_menu').id, values: { 'body.1': 'x' } })).statusCode).toBe(409);
    expect((await s.as('POST', `/api/conversations/${s.conv.id}/template`, { templateId: s.byName('order_follow_up').id, values: { 'body.1': 'سطر\nتاني' } })).json().error).toBe('bad_params');
    expect((await s.as('POST', `/api/conversations/${s.conv.id}/template`, { templateId: s.byName('monthly_offer').id, values: { 'body.customer_name': 'a', 'body.discount': 'b', 'body.end_date': 'c' } })).json().error).toBe('header_required');
  });

  it('sends an image header uploaded with the template', async () => {
    const s = await withTemplates();
    const t = s.byName('monthly_offer');
    const res = await s.app.inject({ method: 'POST', url: `/api/conversations/${s.conv.id}/template`, cookies: { dosly_session: s.as.cookie.split('=')[1]! },
      ...(await multipart({ data: JSON.stringify({ templateId: t.id, values: { 'body.customer_name': 'ريم', 'body.discount': '20%', 'body.end_date': 'الجمعة' } }) }, { field: 'header', name: 'offer.jpg', bytes: await jpeg(), type: 'image/jpeg' })) });
    expect(res.statusCode).toBe(201);
    await sendQueuedMessage(s.deps, res.json().id);
    const sent = s.g.sent.at(-1) as { template: { components: { type: string; parameters: unknown[] }[] } };
    expect(sent.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'image', image: { id: 'UP1' } }] });
    expect(sent.template.components[1]!.type).toBe('body');
  });
});
