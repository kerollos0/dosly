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
  if (method === 'DELETE') return json({ success: true });
  if (method === 'GET') {
    if (fields.includes('first_name')) { const [first, last] = demoPersonName(node ?? '').split(' '); return json({ first_name: first, last_name: last, id: node }); }
    if (fields.includes('username') && fields.includes('profile_pic')) { const n = demoPersonName(node ?? ''); return json({ name: n, username: demoHandle(node ?? ''), id: node }); }
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
  if (node === 'me' && edge === 'messages') {
    // Messenger / Instagram Send API. A private reply names a comment; its commenter is encoded in demo comment ids.
    let recipient: { id?: string; comment_id?: string } = {};
    if (init?.body instanceof FormData) recipient = JSON.parse(String(init.body.get('recipient') ?? '{}'));
    else if (typeof init?.body === 'string') recipient = JSON.parse(init.body).recipient ?? {};
    const rid = recipient.id ?? (recipient.comment_id?.match(/^demo-c-(.+)-[0-9a-f]{16}$/)?.[1] ?? id('demo-psid-'));
    return json({ recipient_id: rid, message_id: id('m_DEMO') });
  }
  if (!edge) return json({ success: true }); // hide / unhide a comment
  switch (edge) {
    case 'comments': case 'replies': return json({ id: id('demo-reply-') });
    case 'subscribed_apps': return json({ success: true });
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

const PEOPLE_FIRST = ['أحمد', 'مريم', 'سارة', 'يوسف', 'نور', 'كريم', 'هبة', 'ياسمين', 'عمر', 'منة', 'مينا', 'مارينا', 'دينا', 'خالد'];
const PEOPLE_LAST = ['حسن', 'سمير', 'عادل', 'فؤاد', 'جرجس', 'منصور', 'رمزي', 'الشريف'];
const HANDLES = ['nour.style', 'mariam_eg', 'yousef.cairo', 'sara_m', 'kareem.x', 'heba.makes', 'omar_alex', 'mina.g'];
const hashOf = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0);
/** A stable demo name for a Messenger or Instagram id, as the Graph profile call would return it. */
export const demoPersonName = (userId: string) => { const h = hashOf(userId); return `${PEOPLE_FIRST[h % PEOPLE_FIRST.length]} ${PEOPLE_LAST[(h >>> 8) % PEOPLE_LAST.length]}`; };
export const demoHandle = (userId: string) => `${HANDLES[hashOf(userId) % HANDLES.length]}${hashOf(userId) % 90 + 10}`;
export const demoSocialUserId = () => id('demo-psid-');
/** Demo comment ids carry the commenter, so a demo private reply reaches the same person. */
export const demoCommentId = (fromId: string) => id(`demo-c-${fromId}-`);

/** A Messenger (`page`) or Instagram webhook for one direct message, shaped like Meta's. */
export function demoSocialMessagePayload(o: { platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; accountId: string; customerId: string; text?: string; media?: DemoMediaName; at?: Date }) {
  const message: Json = { mid: id('m_DEMOIN') };
  if (o.text) message.text = o.text;
  if (o.media) {
    const m = DEMO_MEDIA[o.media];
    message.attachments = [{ type: m.type === 'document' ? 'file' : m.type, payload: { url: `${DEMO_MEDIA_HOST}${o.media}` } }];
  }
  return {
    object: o.platform === 'INSTAGRAM' ? 'instagram' : 'page',
    entry: [{ id: o.accountId, time: Date.now(), messaging: [{ sender: { id: o.customerId }, recipient: { id: o.accountId }, timestamp: (o.at ?? new Date()).getTime(), message }] }]
  };
}

/** A Facebook `feed` or Instagram `comments` webhook for one new comment. */
export function demoCommentPayload(o: { platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; accountId: string; postId: string; commentId: string; fromId: string; fromName: string; text: string; parentId?: string; at?: Date }) {
  const at = o.at ?? new Date();
  if (o.platform === 'INSTAGRAM') {
    return { object: 'instagram', entry: [{ id: o.accountId, time: Math.floor(at.getTime() / 1000), changes: [{ field: 'comments', value: { id: o.commentId, text: o.text, from: { id: o.fromId, username: o.fromName }, media: { id: o.postId, media_product_type: 'FEED' }, ...(o.parentId ? { parent_id: o.parentId } : {}) } }] }] };
  }
  return { object: 'page', entry: [{ id: o.accountId, time: Math.floor(at.getTime() / 1000), changes: [{ field: 'feed', value: {
    item: 'comment', verb: 'add', comment_id: o.commentId, post_id: o.postId, parent_id: o.parentId ?? o.postId, from: { id: o.fromId, name: o.fromName }, message: o.text, created_time: Math.floor(at.getTime() / 1000)
  } }] }] };
}
