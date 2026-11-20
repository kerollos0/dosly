import { graph, GraphError, GRAPH_URL } from './whatsapp.js';

/**
 * Facebook Page and Instagram comments and direct messages (Messenger Platform, Instagram Messaging
 * with Facebook Login). Every call uses the Page access token; `me` is the Page that token belongs to,
 * which also covers the Instagram account linked to it.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type F = typeof fetch | undefined;
export type SocialPlatform = 'FACEBOOK_PAGE' | 'INSTAGRAM';

/** Messenger and Instagram: free replies for 24h, then 7 more days with the HUMAN_AGENT tag, then nothing. */
export const SOCIAL_WINDOW_MS = 24 * 3600_000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 3600_000;
export type SocialWindow = 'open' | 'human_agent' | 'closed';
export function socialWindow(lastInboundAt: Date | null | undefined, now = new Date()): SocialWindow {
  if (!lastInboundAt) return 'closed';
  const age = now.getTime() - lastInboundAt.getTime();
  return age < SOCIAL_WINDOW_MS ? 'open' : age < HUMAN_AGENT_WINDOW_MS ? 'human_agent' : 'closed';
}
/** Whether the inbox may send a free-form reply now: WhatsApp has only the 24h window, Messenger/Instagram also the tagged 7 days. */
export function replyWindow(channel: 'WHATSAPP' | 'MESSENGER' | 'INSTAGRAM', lastInboundAt: Date | null | undefined, now = new Date()): SocialWindow {
  const w = socialWindow(lastInboundAt, now);
  return channel === 'WHATSAPP' && w === 'human_agent' ? 'closed' : w;
}
export const WINDOW_CLOSED_AR = {
  WHATSAPP: 'عدّى أكتر من 24 ساعة على آخر رسالة من العميل. واتساب بيسمح بس برسايل Template دلوقتي.',
  MESSENGER: 'عدّى أكتر من 7 أيام على آخر رسالة من العميل، فماسنجر مش هيسمح بالرد لحد ما يكتبلك تاني.',
  INSTAGRAM: 'عدّى أكتر من 7 أيام على آخر رسالة من العميل، فإنستجرام مش هيسمح بالرد لحد ما يكتبلك تاني.'
} as const;

/** A private reply to a comment is allowed once, within 7 days of the comment. */
export const PRIVATE_REPLY_MS = 7 * 24 * 3600_000;
/** Send API attachment limit (Messenger and Instagram: 25 MB; Instagram images 8 MB). */
export const SOCIAL_MEDIA_MAX = 25 * 1024 * 1024;
export const SOCIAL_IMAGE_MAX = 8 * 1024 * 1024;
export const SOCIAL_TEXT_MAX = 1999; // Messenger: "less than 2000 characters"
export const INSTAGRAM_TEXT_MAX_BYTES = 1000; // Instagram: UTF-8, 1000 bytes or less (about 500 Arabic letters)
/** Why Meta would refuse this text on this channel, in Arabic, or null when it fits. */
export function socialTextProblem(channel: 'MESSENGER' | 'INSTAGRAM' | 'FACEBOOK_PAGE', text: string): string | null {
  if (channel === 'INSTAGRAM') {
    const bytes = new TextEncoder().encode(text).length;
    return bytes > INSTAGRAM_TEXT_MAX_BYTES ? `الرسالة طويلة على إنستجرام (أقصى حاجة حوالي 500 حرف عربي). قصّرها أو قسّمها على رسالتين.` : null;
  }
  return text.length > SOCIAL_TEXT_MAX ? `الرسالة أطول من ${SOCIAL_TEXT_MAX} حرف، وده أقصى طول في ماسنجر` : null;
}

// ---------- Webhooks ----------

export type SocialAttachment = { type: string; url?: string; stickerId?: string; title?: string };
export type SocialInbound = {
  platform: SocialPlatform;
  accountId: string; // the Page id or Instagram account id the webhook is for
  customerId: string; // PSID or IGSID
  mid: string;
  timestamp: Date;
  echo: boolean; // sent by the business (from Dosly or from another tool such as Business Suite)
  appId?: string; // on echoes: the app that sent it
  text?: string;
  attachments: SocialAttachment[];
  deleted?: boolean;
};
export type SocialRead = { platform: SocialPlatform; accountId: string; customerId: string; watermark?: Date; mid?: string; kind: 'read' | 'delivery' };
export type SocialCommentEvent = {
  platform: SocialPlatform;
  accountId: string;
  verb: 'add' | 'edited' | 'remove' | 'hide' | 'unhide';
  commentId: string;
  postId: string;
  parentId?: string; // only for replies; a top-level comment has none
  fromId?: string;
  fromName?: string;
  text?: string;
  createdAt: Date;
};

const FEED_VERBS: Record<string, SocialCommentEvent['verb'] | undefined> = { add: 'add', edited: 'edited', edit: 'edited', remove: 'remove', delete: 'remove', hide: 'hide', unhide: 'unhide' };

const time = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n < 1e12 ? n * 1000 : n); // feed uses seconds, messaging uses milliseconds
};

/** Parses a Page (`object: "page"`) or Instagram (`object: "instagram"`) webhook. Unknown parts are skipped. */
export function parseSocialWebhook(payload: Json): { messages: SocialInbound[]; reads: SocialRead[]; comments: SocialCommentEvent[] } {
  const out = { messages: [] as SocialInbound[], reads: [] as SocialRead[], comments: [] as SocialCommentEvent[] };
  const platform: SocialPlatform | null = payload?.object === 'page' ? 'FACEBOOK_PAGE' : payload?.object === 'instagram' ? 'INSTAGRAM' : null;
  if (!platform) return out;
  for (const entry of payload.entry ?? []) {
    const accountId = String(entry.id ?? '');
    for (const ev of [...(entry.messaging ?? []), ...(entry.standby ?? [])] as Json[]) {
      const sender = String(ev.sender?.id ?? ''), recipient = String(ev.recipient?.id ?? '');
      const m = ev.message;
      if (m?.mid) {
        const echo = !!m.is_echo || sender === accountId;
        out.messages.push({
          platform, accountId, customerId: echo ? recipient : sender, mid: String(m.mid), timestamp: time(ev.timestamp), echo,
          text: typeof m.text === 'string' ? m.text : undefined, deleted: !!m.is_deleted, appId: m.app_id ? String(m.app_id) : undefined,
          attachments: (m.attachments ?? []).map((a: Json) => ({ type: String(a.type ?? 'fallback'), url: a.payload?.url, stickerId: a.payload?.sticker_id ? String(a.payload.sticker_id) : undefined, title: a.payload?.title ?? a.title }))
        });
      } else if (ev.postback?.mid || ev.postback?.title) {
        out.messages.push({ platform, accountId, customerId: sender, mid: String(ev.postback.mid ?? `pb-${sender}-${ev.timestamp}`), timestamp: time(ev.timestamp), echo: false, text: ev.postback.title, attachments: [] });
      }
      if (ev.read) out.reads.push({ platform, accountId, customerId: sender, kind: 'read', watermark: ev.read.watermark ? time(ev.read.watermark) : time(ev.timestamp), mid: ev.read.mid });
      if (ev.delivery) out.reads.push({ platform, accountId, customerId: sender, kind: 'delivery', watermark: ev.delivery.watermark ? time(ev.delivery.watermark) : undefined, mid: ev.delivery.mids?.[0] });
    }
    for (const ch of (entry.changes ?? []) as Json[]) {
      const v = ch.value ?? {};
      if (platform === 'FACEBOOK_PAGE' && ch.field === 'feed' && v.item === 'comment' && v.comment_id) {
        const postId = String(v.post_id ?? '');
        // On Facebook a top-level comment's parent_id is the post itself.
        const parentId = v.parent_id && v.parent_id !== postId ? String(v.parent_id) : undefined;
        // Other verbs (block, follow, mute, update, ...) say nothing about the comment's text or visibility.
        const verb = FEED_VERBS[String(v.verb)];
        if (!verb) continue;
        out.comments.push({ platform, accountId, verb, commentId: String(v.comment_id), postId, parentId, fromId: v.from?.id, fromName: v.from?.name, text: v.message, createdAt: time(v.created_time) });
      } else if (platform === 'INSTAGRAM' && (ch.field === 'comments' || ch.field === 'live_comments') && (v.id || v.comment_id)) {
        out.comments.push({
          platform, accountId, verb: 'add', commentId: String(v.id ?? v.comment_id), postId: String(v.media?.id ?? ''), parentId: v.parent_id ? String(v.parent_id) : undefined,
          fromId: v.from?.id, fromName: v.from?.username, text: v.text, createdAt: time(entry.time)
        });
      }
    }
  }
  return out;
}

/** Message.type for a Messenger/Instagram attachment, matching the WhatsApp types the inbox already shows. */
export function socialMessageType(a: SocialAttachment | undefined): string {
  if (!a) return 'text';
  if (a.stickerId || a.type === 'sticker' || a.type === 'animated_image_share' || a.type === 'like_heart') return 'sticker';
  if (a.type === 'image') return 'image';
  if (a.type === 'video' || a.type === 'ig_reel' || a.type === 'reel') return a.url && a.type === 'video' ? 'video' : 'share';
  if (a.type === 'audio') return 'audio';
  if (a.type === 'file') return 'document';
  return 'share'; // story mentions, shared posts, links, fallbacks: shown as a link
}

// ---------- Graph calls ----------

export type SocialRecipient = { id: string } | { comment_id: string };
export type SendTag = 'HUMAN_AGENT' | undefined;
/** Text or an attachment by URL. For a local file use sendSocialFile. */
export async function sendSocialMessage(o: { token: string; recipient: SocialRecipient; text?: string; attachment?: { type: 'image' | 'video' | 'audio' | 'file'; url: string }; tag?: SendTag }, f?: F): Promise<{ recipientId: string; messageId: string }> {
  const message = o.attachment ? { attachment: { type: o.attachment.type, payload: { url: o.attachment.url, is_reusable: false } } } : { text: o.text };
  const body: Json = { recipient: o.recipient, message, messaging_type: o.tag ? 'MESSAGE_TAG' : 'RESPONSE', ...(o.tag ? { tag: o.tag } : {}) };
  const r = await graph<{ recipient_id: string; message_id: string }>('me/messages', o.token, { body }, f);
  return { recipientId: r.recipient_id, messageId: r.message_id };
}

/** Sends a file from our server as multipart `filedata`. Meta rejects non-ASCII file names, so they are replaced. */
export async function sendSocialFile(o: { token: string; recipientId: string; kind: 'image' | 'video' | 'audio' | 'file'; bytes: Uint8Array; mime: string; fileName: string; tag?: SendTag }, f: typeof fetch = fetch): Promise<{ recipientId: string; messageId: string }> {
  const form = new FormData();
  form.set('recipient', JSON.stringify({ id: o.recipientId }));
  form.set('message', JSON.stringify({ attachment: { type: o.kind, payload: { is_reusable: false } } }));
  form.set('messaging_type', o.tag ? 'MESSAGE_TAG' : 'RESPONSE');
  if (o.tag) form.set('tag', o.tag);
  form.set('filedata', new Blob([o.bytes as BlobPart], { type: o.mime }), asciiName(o.fileName));
  const res = await f(`${GRAPH_URL}/me/messages`, { method: 'POST', headers: { Authorization: `Bearer ${o.token}` }, body: form });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || json.error) throw new GraphError(json.error?.message ?? `Send API ${res.status}`, res.status, json.error?.code);
  return { recipientId: json.recipient_id, messageId: json.message_id };
}

export function asciiName(name: string) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).replace(/[^\w.]/g, '') : '';
  const base = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'file'}${ext}`.slice(0, 100);
}

/** Webhook fields a connected Page subscribes this app to: comments, messages, echoes and receipts. */
export const PAGE_WEBHOOK_FIELDS = ['feed', 'messages', 'message_echoes', 'message_reads', 'message_deliveries', 'messaging_postbacks'];
/** Without this call Meta sends no webhooks for the Page, even with the app's webhook configured. */
export async function subscribePage(o: { pageId: string; token: string }, f?: F) {
  await graph(`${o.pageId}/subscribed_apps?subscribed_fields=${PAGE_WEBHOOK_FIELDS.join(',')}`, o.token, { method: 'POST' }, f);
}

/** Public reply under a comment. Returns the new comment id. */
export async function replyToComment(o: { platform: SocialPlatform; token: string; commentId: string; text: string }, f?: F): Promise<string> {
  const edge = o.platform === 'INSTAGRAM' ? 'replies' : 'comments';
  const r = await graph<{ id: string }>(`${o.commentId}/${edge}`, o.token, { body: { message: o.text } }, f);
  return r.id;
}

export async function setCommentHidden(o: { platform: SocialPlatform; token: string; commentId: string; hidden: boolean }, f?: F) {
  await graph(o.commentId, o.token, { body: o.platform === 'INSTAGRAM' ? { hide: o.hidden } : { is_hidden: o.hidden } }, f);
}

export async function deleteComment(o: { token: string; commentId: string }, f?: F) {
  await graph(o.commentId, o.token, { method: 'DELETE' }, f);
}

/** Name and picture of a Messenger or Instagram customer. Optional: a failure just leaves the contact unnamed. */
export async function getSocialProfile(o: { platform: SocialPlatform; token: string; userId: string }, f?: F): Promise<{ name?: string; username?: string; avatarUrl?: string }> {
  if (o.platform === 'INSTAGRAM') {
    const r = await graph<{ name?: string; username?: string; profile_pic?: string }>(`${o.userId}?fields=name,username,profile_pic`, o.token, {}, f);
    return { name: r.name || r.username, username: r.username, avatarUrl: r.profile_pic };
  }
  const r = await graph<{ first_name?: string; last_name?: string; profile_pic?: string }>(`${o.userId}?fields=first_name,last_name,profile_pic`, o.token, {}, f);
  return { name: [r.first_name, r.last_name].filter(Boolean).join(' ') || undefined, avatarUrl: r.profile_pic };
}

/** Send API errors that will not succeed on retry: outside the window, user unavailable, bad token, bad request. */
const PERMANENT_SOCIAL = new Set([10, 100, 190, 200, 230, 551, 2018001, 2018108, 2018278, 2534022]);
export const isPermanentSocialError = (e: unknown) => e instanceof GraphError && ((e.code !== undefined && PERMANENT_SOCIAL.has(e.code)) || e.status === 400 || e.status === 403 || e.status === 404);
