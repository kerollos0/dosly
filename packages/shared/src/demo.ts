import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MetaTemplate } from './wa-templates.js';

/**
 * Demo mode: a stand-in for the Meta Graph API. It answers every call Dosly makes
 * (verify a number or page, send a WhatsApp message, publish to Facebook or Instagram)
 * without any network traffic, so the whole product can run with no Meta app at all.
 */
const id = (prefix: string) => `${prefix}${randomBytes(8).toString('hex')}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const DEMO_FAIL_TOKEN = 'demo-fail';

/** Sample files a demo customer can send. They live in packages/shared/demo-assets. */
export const DEMO_MEDIA = {
  photo: { file: 'photo.jpg', mime: 'image/jpeg', type: 'image' as const },
  voice: { file: 'voice.ogg', mime: 'audio/ogg; codecs=opus', type: 'audio' as const, voice: true },
  pricelist: { file: 'price-list.pdf', mime: 'application/pdf', type: 'document' as const, fileName: 'price-list.pdf' }
};
export type DemoMediaName = keyof typeof DEMO_MEDIA;
const DEMO_MEDIA_HOST = 'https://demo-media.dosly.invalid/';
const assetCache = new Map<string, Buffer>();
export function demoAsset(file: string): Buffer {
  let b = assetCache.get(file);
  if (!b) { b = readFileSync(new URL(`../demo-assets/${file}`, import.meta.url)); assetCache.set(file, b); }
  return b;
}

/** Arabic sample templates every demo number has: approved ones of each kind, one in review and one rejected. */
export const DEMO_TEMPLATES: MetaTemplate[] = [
  { id: '9100000000001', name: 'order_follow_up', language: 'ar', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL', components: [
    { type: 'BODY', text: 'أهلاً {{1}}، بنطمن إن طلبك وصلك سليم. لو محتاج أي حاجة ابعتلنا هنا وهنرد عليك على طول.' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'وصل تمام' }, { type: 'QUICK_REPLY', text: 'عندي مشكلة' }] }
  ] },
  { id: '9100000000002', name: 'appointment_reminder', language: 'ar', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL', components: [
    { type: 'HEADER', format: 'TEXT', text: 'تذكير بميعادك' },
    { type: 'BODY', text: 'أهلاً {{1}}، بنفكرك بميعادك يوم {{2}} الساعة {{3}}. لو حابب تغيّره رد على الرسالة دي.' },
    { type: 'FOOTER', text: 'الرسالة دي اتبعتت أوتوماتيك' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'تفاصيل الحجز', url: 'https://example.com/booking/{{1}}' }] }
  ] },
  { id: '9100000000003', name: 'monthly_offer', language: 'ar', status: 'APPROVED', category: 'MARKETING', parameter_format: 'NAMED', components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'أهلاً {{customer_name}}! عرض الشهر: خصم {{discount}} على كل المنتجات لحد {{end_date}}.' },
    { type: 'FOOTER', text: 'ابعت "إيقاف" لو مش عايز رسايل عروض' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'عايز أطلب' }, { type: 'QUICK_REPLY', text: 'إيقاف' }] }
  ] },
  { id: '9100000000004', name: 'new_menu', language: 'ar', status: 'PENDING', category: 'MARKETING', parameter_format: 'POSITIONAL', components: [
    { type: 'BODY', text: 'المنيو الجديد نزل يا {{1}}! تعالى جرّبه.' }
  ] },
  { id: '9100000000005', name: 'win_back', language: 'ar', status: 'REJECTED', category: 'MARKETING', parameter_format: 'POSITIONAL', components: [
    { type: 'BODY', text: 'وحشتنا! ارجع اشتري دلوقتي.' }
  ] }
];

export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname.replace(/^\/v[\d.]+\//, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  // Lets a demo show what a Meta error looks like.
  if (auth.endsWith(DEMO_FAIL_TOKEN)) return json({ error: { message: 'Invalid OAuth access token (demo)', code: 190 } }, 401);

  if (url.href.startsWith(DEMO_MEDIA_HOST)) {
    const m = DEMO_MEDIA[url.pathname.slice(1) as DemoMediaName];
    return m ? new Response(new Uint8Array(demoAsset(m.file)), { headers: { 'content-type': m.mime } }) : new Response('not found', { status: 404 });
  }
  const fields = url.searchParams.get('fields') ?? '';
  const [node, edge] = path.split('/');
  if (method === 'GET') {
    if (node?.startsWith('demo-media-')) {
      const name = node.slice(11) as DemoMediaName;
      const m = DEMO_MEDIA[name];
      if (!m) return json({ error: { message: 'Media not found (demo)', code: 100 } }, 404);
      const bytes = demoAsset(m.file);
      return json({ messaging_product: 'whatsapp', url: `${DEMO_MEDIA_HOST}${name}`, mime_type: m.mime, sha256: createHash('sha256').update(bytes).digest('hex'), file_size: bytes.length, id: node });
    }
    if (edge === 'message_templates') return json({ data: DEMO_TEMPLATES, paging: { cursors: { before: 'b', after: 'a' } } });
    if (fields.includes('display_phone_number')) {
      const digits = (node ?? '').replace(/\D/g, '').padEnd(8, '0').slice(-8);
      return json({ id: node, display_phone_number: `+20 10 ${digits.slice(0, 4)} ${digits.slice(4)}`, verified_name: 'Demo Business' });
    }
    if (fields.includes('status_code')) return json({ id: node, status_code: 'FINISHED' });
    return json({ id: node });
  }
  switch (edge) {
    case 'messages': return json({ messaging_product: 'whatsapp', messages: [{ id: id('wamid.DEMO') }] });
    case 'photos': return json({ id: id(''), post_id: `${node}_${id('')}` });
    case 'feed': return json({ id: `${node}_${id('')}` });
    case 'media': return json({ id: id('17') });
    case 'media_publish': return json({ id: id('18') });
    default: return json({ error: { message: `Demo Graph has no handler for ${method} ${path}` } }, 400);
  }
};

type Json = Record<string, unknown>;
const wrap = (phoneNumberId: string, value: Json) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'demo-waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }]
});

/** A WhatsApp webhook payload for one inbound text or media message, shaped exactly like Meta's. */
export function demoInboundPayload(o: { phoneNumberId: string; waId: string; name?: string; body: string; media?: DemoMediaName; at?: Date }) {
  const ts = String(Math.floor((o.at ?? new Date()).getTime() / 1000));
  const base = { from: o.waId, id: id('wamid.DEMOIN'), timestamp: ts };
  let message: Json = { ...base, type: 'text', text: { body: o.body } };
  if (o.media) {
    const m = DEMO_MEDIA[o.media];
    const bytes = demoAsset(m.file);
    const media: Json = { id: `demo-media-${o.media}`, mime_type: m.mime, sha256: createHash('sha256').update(bytes).digest('hex') };
    if ('voice' in m) media.voice = true;
    else media.caption = o.body || undefined;
    if ('fileName' in m) media.filename = m.fileName;
    message = { ...base, type: m.type, [m.type]: media };
  }
  return wrap(o.phoneNumberId, { contacts: [{ wa_id: o.waId, profile: { name: o.name } }], messages: [message] });
}

/** A WhatsApp webhook payload moving one outbound message to a new status. */
export function demoStatusPayload(o: { phoneNumberId: string; waMessageId: string; status: 'sent' | 'delivered' | 'read'; at?: Date }) {
  const ts = String(Math.floor((o.at ?? new Date()).getTime() / 1000));
  return wrap(o.phoneNumberId, { statuses: [{ id: o.waMessageId, status: o.status, timestamp: ts }] });
}
