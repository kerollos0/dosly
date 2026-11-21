import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db, Prisma } from '@dosly/db';
import { SOCIAL_MEDIA_MAX, WA_INBOUND_MAX, decrypt, isPermanentSocialError, sendSocialFile, sendSocialMessage, socialWindow, downloadMedia, extOf, getMediaInfo, GraphError, isPermanentGraphError, sendWhatsAppMessage, uploadMedia, baseMime } from '@dosly/shared';
import type { Publisher } from './events.js';
import { attachPlatformId } from './social.js';
import { mediaKey, type MediaStore } from './media-store.js';
import { imagePreview, probe, tempPath, toMp4, toPlaybackAudio, toVoiceNote, toWhatsAppJpeg, videoPoster } from './media-tools.js';

export type MediaDeps = { db: Db; store: MediaStore; key: Buffer; pub: Publisher; fetch?: typeof fetch; log?: { warn(o: object, msg: string): void } };

/** Short text for the conversation list when a message has no words of its own. */
export const MEDIA_LABEL: Record<string, string> = {
  image: 'صورة', audio: 'رسالة صوتية', video: 'فيديو', document: 'ملف', sticker: 'ستيكر', location: 'موقع', contacts: 'جهة اتصال', template: 'رسالة Template', reaction: 'تفاعل', share: 'مشاركة بوست أو لينك'
};
export const previewText = (type: string, body?: string | null, voice?: boolean) =>
  (body?.trim() || (type === 'audio' && !voice ? 'ملف صوتي' : MEDIA_LABEL[type]) || 'رسالة').slice(0, 140);

/** A retry will not help: the job records the failure and stops. */
export class PermanentMediaError extends Error {
  /** The platform's error code when there was one (e.g. 131026: the number is not on WhatsApp). */
  constructor(message: string, readonly code?: number) { super(message); }
}

/** Streams a download to a temp file, hashing it and stopping at `max` bytes. */
async function saveStream(body: ReadableStream<Uint8Array>, ext: string, max: number) {
  const path = tempPath(ext);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max) return cb(new PermanentMediaError('الملف أكبر من 100 ميجا'));
      hash.update(chunk);
      cb(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(body as never), meter, createWriteStream(path));
  } catch (e) { await rm(path, { force: true }); throw e; }
  return { path, size, sha256: hash.digest('hex') };
}

type Derived = { previewKey?: string; mediaWidth?: number; mediaHeight?: number; durationSec?: number };

/** Thumbnails, posters and a browser-friendly audio copy. A failure here never loses the original. */
async function derive(deps: MediaDeps, src: string, type: string, mime: string, agencyId: string, messageId: string): Promise<Derived> {
  const out: Derived = {};
  const tmp: string[] = [];
  try {
    if (type === 'image' || type === 'sticker' || (type === 'template' && mime.startsWith('image/'))) {
      const p = await imagePreview(src); tmp.push(p.path);
      out.previewKey = mediaKey(agencyId, messageId, 'webp', '-thumb');
      await deps.store.put(out.previewKey, p.path);
      out.mediaWidth = p.width; out.mediaHeight = p.height;
    } else if (type === 'video' || (type === 'template' && mime.startsWith('video/'))) {
      const p = await probe(src);
      Object.assign(out, { durationSec: p.duration, mediaWidth: p.width, mediaHeight: p.height });
      const poster = await videoPoster(src); tmp.push(poster);
      out.previewKey = mediaKey(agencyId, messageId, 'jpg', '-poster');
      await deps.store.put(out.previewKey, poster);
    } else if (type === 'audio') {
      out.durationSec = (await probe(src)).duration;
      // Ogg plays in Chrome, Firefox and recent Safari; AMR plays nowhere, so both get an AAC copy.
      if (['audio/ogg', 'audio/opus', 'audio/amr'].includes(baseMime(mime))) {
        const m4a = await toPlaybackAudio(src); tmp.push(m4a);
        out.previewKey = mediaKey(agencyId, messageId, 'm4a', '-play');
        await deps.store.put(out.previewKey, m4a);
      }
    }
  } catch (e) {
    deps.log?.warn({ messageId, err: (e as Error).message }, 'Media preview failed');
  } finally {
    await Promise.all(tmp.map(p => rm(p, { force: true })));
  }
  return out;
}

/**
 * Downloads one inbound attachment from Meta into private storage. Idempotent: a message that is
 * already READY is skipped. Meta's URL is valid for 5 minutes, so it is fetched right before the download.
 */
export async function fetchInboundMedia(deps: MediaDeps, messageId: string): Promise<'ready' | 'skipped'> {
  const { db, store, key, pub } = deps;
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { waNumber: true } } } });
  // Only a waiting download runs: READY is done, and null means the customer unsent it meanwhile.
  if (!msg || msg.direction !== 'IN' || msg.mediaStatus !== 'PENDING') return 'skipped';
  const num = msg.conversation.waNumber;
  const sourceUrl = (msg.payload as { sourceUrl?: string } | null)?.sourceUrl;
  if (!num) return sourceUrl ? fetchSocialMedia(deps, msg, sourceUrl) : 'skipped';
  if (!msg.mediaId) return 'skipped';
  const token = decrypt(num.accessTokenEnc, key);

  let file: { path: string; size: number; sha256: string } | undefined;
  let info: Awaited<ReturnType<typeof getMediaInfo>> | undefined;
  try {
    for (let attempt = 0; attempt < 2 && !file; attempt++) {
      info = await getMediaInfo({ mediaId: msg.mediaId, phoneNumberId: num.phoneNumberId, token }, deps.fetch);
      if (Number(info.file_size) > WA_INBOUND_MAX) throw new PermanentMediaError('الملف أكبر من 100 ميجا');
      try {
        const res = await downloadMedia(info.url, token, deps.fetch);
        file = await saveStream(res.body!, extOf(info.mime_type), WA_INBOUND_MAX);
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404) || attempt === 1) throw e; // an expired URL: ask for a fresh one once
      }
    }
  } catch (e) {
    if (e instanceof PermanentMediaError || isPermanentGraphError(e)) throw new PermanentMediaError((e as Error).message);
    throw e;
  }
  if (!file || !info) throw new Error('Media download failed');
  try {
    const expected = (info.sha256 || msg.mediaSha256 || '').toLowerCase();
    // Meta documents sha256 as a hex digest; a mismatch means a truncated or corrupted download, so retry.
    if (/^[0-9a-f]{64}$/.test(expected) && expected !== file.sha256) throw new Error('Media checksum mismatch');
    const mime = info.mime_type || msg.mediaMime || 'application/octet-stream';
    const k = mediaKey(msg.agencyId, msg.id, extOf(mime));
    const derived = await derive(deps, file.path, msg.type, mime, msg.agencyId, msg.id);
    await store.put(k, file.path);
    await db.message.update({ where: { id: msg.id }, data: { mediaStatus: 'READY', mediaKey: k, mediaMime: mime, mediaSize: file.size, mediaSha256: file.sha256, error: null, ...derived } });
  } finally {
    await rm(file.path, { force: true });
  }
  await pub.publish(msg.agencyId, { type: 'message.updated', conversationId: msg.conversationId, messageId: msg.id });
  return 'ready';
}

/** Hosts Meta serves Messenger and Instagram attachments from (lookaside URLs redirect to scontent). */
const META_CDN = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|facebook\.com|instagram\.com)$/;
const DEMO_CDN = 'demo-media.dosly.invalid';
export const isMetaCdnUrl = (raw: string) => {
  try { const u = new URL(raw); return u.protocol === 'https:' && (META_CDN.test(u.hostname) || u.hostname === DEMO_CDN); } catch { return false; }
};
/**
 * The URL comes from a webhook, so it is only fetched from Meta's CDN over HTTPS, redirects are
 * followed by hand and checked the same way, and the download has a time limit. This keeps the worker
 * from being pointed at internal services.
 */
async function fetchMetaCdn(url: string, f: typeof fetch): Promise<Response> {
  let next = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!isMetaCdnUrl(next)) throw new PermanentMediaError('رابط الملف مش من سيرفرات ميتا');
    const res = await f(next, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    next = new URL(loc, next).href;
  }
  throw new PermanentMediaError('رابط الملف بيحوّل كتير');
}

/**
 * Messenger and Instagram attachments come as a CDN URL in the webhook, with no token needed.
 * The URL expires, so it is downloaded right away; the type comes from the bytes' Content-Type.
 */
async function fetchSocialMedia(deps: MediaDeps, msg: { id: string; agencyId: string; conversationId: string; type: string }, url: string): Promise<'ready'> {
  const { db, store, pub } = deps;
  const res = await fetchMetaCdn(url, deps.fetch ?? fetch);
  if (res.status === 403 || res.status === 404 || res.status === 410) throw new PermanentMediaError('رابط الملف من فيسبوك انتهى');
  if (!res.ok || !res.body) throw new Error(`Media download ${res.status}`);
  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  const file = await saveStream(res.body, extOf(mime), Math.max(SOCIAL_MEDIA_MAX * 2, 50 * 1024 * 1024));
  try {
    const k = mediaKey(msg.agencyId, msg.id, extOf(mime));
    const derived = await derive(deps, file.path, msg.type, mime, msg.agencyId, msg.id);
    await store.put(k, file.path);
    const fileName = msg.type === 'document' ? decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null : null;
    await db.message.update({ where: { id: msg.id }, data: { mediaStatus: 'READY', mediaKey: k, mediaMime: mime, mediaSize: file.size, mediaSha256: file.sha256, error: null, ...(fileName && { fileName }), ...derived } });
  } finally {
    await rm(file.path, { force: true });
  }
  await pub.publish(msg.agencyId, { type: 'message.updated', conversationId: msg.conversationId, messageId: msg.id });
  return 'ready';
}

export async function markMediaFailed(db: Db, pub: Publisher, messageId: string, error: string) {
  const msg = await db.message.update({ where: { id: messageId }, data: { mediaStatus: 'FAILED', error: error.slice(0, 500) } });
  await pub.publish(msg.agencyId, { type: 'message.updated', conversationId: msg.conversationId, messageId });
}

/** Inbound attachments still waiting: catches downloads whose job was lost. Meta keeps them 7 days. */
export function pendingInboundMedia(db: Db, olderThanMs = 2 * 60_000) {
  const now = Date.now();
  return db.message.findMany({
    where: { direction: 'IN', mediaStatus: 'PENDING', createdAt: { lt: new Date(now - olderThanMs), gt: new Date(now - 7 * 24 * 3600_000) } },
    select: { id: true }, take: 500, orderBy: { createdAt: 'asc' }
  });
}

/** What the API stores in Message.payload for the worker. */
export type OutboundPayload = {
  kind: 'image' | 'audio' | 'video' | 'document' | 'template' | 'text';
  convert?: 'voice' | 'jpeg' | 'mp4' | 'm4a' | null;
  converted?: boolean;
  derived?: boolean;
  metaMediaId?: string;
  template?: { name: string; language: { code: string }; components?: Record<string, unknown>[] };
  headerKind?: 'image' | 'video' | 'document';
  rendered?: { header?: string; footer?: string; buttons: string[] };
  /** Messenger/Instagram: the file went out (its id is on the message); the caption may still be owed. */
  fileSent?: boolean;
};

/**
 * Sends one queued outbound message (media or template): converts the file if needed, uploads it
 * to Meta, then sends. Each step is recorded in the payload, so a retry resumes instead of redoing it.
 */
export async function sendQueuedMessage(deps: MediaDeps, messageId: string): Promise<'sent' | 'skipped'> {
  const { db, store, key, pub } = deps;
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { waNumber: true, socialAccount: true, contact: true } } } });
  let payload = (msg?.payload ?? {}) as OutboundPayload;
  // A Messenger/Instagram file already sent may still owe its caption, so only WhatsApp stops at a known id.
  if (!msg || msg.direction !== 'OUT' || msg.status !== 'QUEUED' || (msg.waMessageId && !payload.fileSent)) return 'skipped';
  const save = async (patch: Partial<OutboundPayload>, data: Prisma.MessageUpdateInput = {}) => {
    payload = { ...payload, ...patch };
    await db.message.update({ where: { id: msg.id }, data: { ...data, payload: payload as Prisma.InputJsonValue } });
  };
  const conv = msg.conversation;
  const account = conv.waNumber ?? conv.socialAccount;
  if (!account) throw new PermanentMediaError('القناة دي اتشالت');
  const token = decrypt(account.accessTokenEnc, key);
  let mediaKeyNow = msg.mediaKey;
  let mime = msg.mediaMime ?? 'application/octet-stream';

  if (mediaKeyNow && payload.convert && !payload.converted) {
    const src = store.localPath(mediaKeyNow);
    const c = payload.convert;
    const out = c === 'voice' ? await toVoiceNote(src) : c === 'jpeg' ? await toWhatsAppJpeg(src) : c === 'm4a' ? await toPlaybackAudio(src) : await toMp4(src);
    const ext = c === 'voice' ? 'ogg' : c === 'jpeg' ? 'jpg' : c === 'm4a' ? 'm4a' : 'mp4';
    mime = c === 'voice' ? 'audio/ogg' : c === 'jpeg' ? 'image/jpeg' : c === 'm4a' ? 'audio/mp4' : 'video/mp4';
    const k = mediaKey(msg.agencyId, msg.id, ext, '-wa');
    const size = await store.put(k, out);
    await store.remove(mediaKeyNow);
    mediaKeyNow = k;
    await save({ converted: true }, { mediaKey: k, mediaMime: mime, mediaSize: size });
  }
  if (mediaKeyNow && !payload.derived) {
    const d = await derive(deps, store.localPath(mediaKeyNow), msg.type, mime, msg.agencyId, msg.id);
    await save({ derived: true }, d);
    await pub.publish(msg.agencyId, { type: 'message.updated', conversationId: conv.id, messageId: msg.id });
  }
  if (!conv.waNumber) {
    // Messenger / Instagram: the file goes with the message itself. Past 24h the HUMAN_AGENT tag allows 7 days.
    const w = socialWindow(conv.lastInboundAt);
    if (w === 'closed') throw new PermanentMediaError('عدّى أكتر من 7 أيام على آخر رسالة من العميل، فميتا مش هتسمح بالرد');
    if (!mediaKeyNow || payload.kind === 'template' || payload.kind === 'text' || !conv.contact.externalId) throw new PermanentMediaError('الرسالة دي مش مدعومة هنا');
    const tag = w === 'human_agent' ? 'HUMAN_AGENT' as const : undefined;
    const recipientId = conv.contact.externalId;
    try {
      if (!payload.fileSent) {
        const bytes = await readFile(store.localPath(mediaKeyNow));
        const kind = payload.kind === 'document' ? 'file' : payload.kind;
        const r = await sendSocialFile({ token, recipientId, kind, bytes, mime, fileName: msg.fileName ?? mediaKeyNow.split('/').pop()!, tag }, deps.fetch);
        // Recorded before anything else, so a retry never sends the file twice.
        payload = { ...payload, fileSent: true };
        await attachPlatformId(db, msg.id, r.messageId, { payload: payload as Prisma.InputJsonValue, error: null });
      }
    } catch (e) {
      if (isPermanentSocialError(e)) throw new PermanentMediaError((e as Error).message);
      throw e;
    }
    // A caption is its own message on Messenger and Instagram, so it gets its own bubble too.
    const caption = msg.body?.trim();
    if (caption) {
      const row = await db.message.create({ data: { agencyId: msg.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: caption, status: 'QUEUED', sentById: msg.sentById } });
      await db.message.update({ where: { id: msg.id }, data: { body: null } });
      try {
        const r = await sendSocialMessage({ token, recipient: { id: recipientId }, text: caption, tag }, deps.fetch);
        await attachPlatformId(db, row.id, r.messageId, { status: 'SENT' });
      } catch (e) {
        // The file arrived; only the words did not. They show as a failed message the agent can send again.
        await db.message.update({ where: { id: row.id }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 500) } });
      }
      await pub.publish(msg.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: row.id, direction: 'OUT' });
    }
    const sent = await db.message.update({ where: { id: msg.id }, data: { status: 'SENT', error: null } });
    await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(), lastPreview: previewText(msg.type, caption || null, msg.voice) } });
    await pub.publish(msg.agencyId, { type: 'message.status', conversationId: conv.id, messageId: sent.id, status: 'SENT' });
    return 'sent';
  }
  const num = conv.waNumber;
  try {
    if (mediaKeyNow && !payload.metaMediaId) {
      const bytes = await readFile(store.localPath(mediaKeyNow));
      const id = await uploadMedia({ phoneNumberId: num.phoneNumberId, token, bytes, mime, fileName: msg.fileName ?? mediaKeyNow.split('/').pop()! }, deps.fetch);
      await save({ metaMediaId: id });
    }
    let message: Record<string, unknown>;
    if (payload.kind === 'template') {
      const t = structuredClone(payload.template!);
      if (payload.headerKind) {
        const kind = payload.headerKind;
        t.components = [{ type: 'header', parameters: [{ type: kind, [kind]: { id: payload.metaMediaId, ...(kind === 'document' && msg.fileName ? { filename: msg.fileName } : {}) } }] }, ...(t.components ?? [])];
      }
      message = { type: 'template', template: t };
    } else if (payload.kind === 'text') {
      message = { type: 'text', text: { preview_url: false, body: msg.body ?? '' } };
    } else {
      const k = payload.kind;
      const media: Record<string, unknown> = { id: payload.metaMediaId };
      if (k !== 'audio' && msg.body) media.caption = msg.body;
      if (k === 'document' && msg.fileName) media.filename = msg.fileName;
      if (k === 'audio' && msg.voice) media.voice = true;
      message = { type: k, [k]: media };
    }
    const waMessageId = await sendWhatsAppMessage({ phoneNumberId: num.phoneNumberId, token, to: conv.contact.waId!, message }, deps.fetch);
    const sent = await db.message.update({ where: { id: msg.id }, data: { waMessageId, status: 'SENT', error: null } });
    await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: sent.createdAt, lastPreview: previewText(msg.type, msg.body, msg.voice) } });
    await pub.publish(msg.agencyId, { type: 'message.status', conversationId: conv.id, messageId: msg.id, status: 'SENT' });
    return 'sent';
  } catch (e) {
    if (isPermanentGraphError(e)) throw new PermanentMediaError((e as Error).message, (e as GraphError).code);
    throw e;
  }
}

export async function markSendFailed(db: Db, pub: Publisher, messageId: string, error: string) {
  const msg = await db.message.update({ where: { id: messageId }, data: { status: 'FAILED', error: error.slice(0, 500) } });
  await pub.publish(msg.agencyId, { type: 'message.status', conversationId: msg.conversationId, messageId, status: 'FAILED' });
}
