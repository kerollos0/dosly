import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Message, Prisma } from '@dosly/db';
import { classifyUpload, mediaKey, previewText, tempPath, UploadRejected, type OutboundPayload } from '@dosly/core';
import { buildTemplateMessage, isWindowOpen, replyWindow, socialTextProblem, SOCIAL_IMAGE_MAX, SOCIAL_MEDIA_MAX, WINDOW_CLOSED_AR, paramProblem, renderTemplate, templateShape, WA_MEDIA_LIMITS } from '@dosly/shared';
import type { AuthContext } from '../auth.js';
import { assertClientAccess, HttpError, requireAuth, requirePermission } from '../auth.js';

const MAX_UPLOAD = WA_MEDIA_LIMITS.document; // 100 MB: the largest thing WhatsApp accepts
const TEMPLATE_STALE_MS = 60 * 60_000;

/** What the browser gets for a message: storage keys and the worker's payload stay on the server. */
export function publicMessage(m: Message & { sentBy?: { id: string; name: string } | null }) {
  const { mediaKey: mk, previewKey, payload, mediaId: _mid, mediaSha256: _sha, ...rest } = m;
  const p = (payload ?? {}) as OutboundPayload;
  return {
    ...rest,
    hasMedia: !!mk || m.mediaStatus === 'PENDING' || m.mediaStatus === 'FAILED',
    hasPreview: !!previewKey,
    ...(p.kind === 'template' ? { template: { name: p.template?.name, header: p.rendered?.header, footer: p.rendered?.footer, buttons: p.rendered?.buttons ?? [], headerKind: p.headerKind } } : {})
  };
}

const RFC5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const mediaRoutes: FastifyPluginAsync = async app => {
  const { db, realtime, queues, media: store } = app.deps;

  async function conversationFor(auth: AuthContext, id: string) {
    const conv = await db.conversation.findFirst({ where: { id, agencyId: auth.agencyId }, include: { waNumber: true, contact: true } });
    if (!conv) throw new HttpError(404, 'المحادثة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, conv.clientId);
    return conv;
  }
  /** Templates exist only on WhatsApp. */
  async function waConversationFor(auth: AuthContext, id: string) {
    const conv = await conversationFor(auth, id);
    const { waNumber, waNumberId } = conv;
    if (!waNumber || !waNumberId || !conv.contact.waId) throw new HttpError(400, 'رسايل Template موجودة في واتساب بس', 'not_whatsapp');
    return { ...conv, waNumber, waNumberId, contact: { ...conv.contact, waId: conv.contact.waId } };
  }
  async function messageFor(auth: AuthContext, id: string) {
    const msg = await db.message.findFirst({ where: { id, agencyId: auth.agencyId }, include: { conversation: { select: { clientId: true } } } });
    if (!msg) throw new HttpError(404, 'الرسالة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, msg.conversation.clientId);
    return msg;
  }

  /** Streams a private file, with byte ranges so audio and video can seek. */
  async function stream(req: FastifyRequest, reply: FastifyReply, key: string, mime: string, opts: { etag: string; download?: string }) {
    const st = await store.stat(key);
    if (!st) throw new HttpError(404, 'الملف مش موجود', 'not_found');
    reply.header('Cache-Control', 'private, max-age=604800, immutable'); // keys never change content
    reply.header('ETag', `"${opts.etag}"`);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('X-Content-Type-Options', 'nosniff');
    // Customer files are untrusted: even an HTML or SVG file opened directly cannot run anything.
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Content-Disposition', opts.download ? `attachment; filename="file"; filename*=UTF-8''${RFC5987(opts.download)}` : 'inline');
    reply.type(mime);
    if (req.headers['if-none-match'] === `"${opts.etag}"`) return reply.status(304).send();
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { reply.header('Content-Range', `bytes */${st.size}`); return reply.status(416).send(); }
      reply.header('Content-Range', `bytes ${start}-${end}/${st.size}`).header('Content-Length', end - start + 1);
      return reply.status(206).send(store.read(key, { start, end }));
    }
    reply.header('Content-Length', st.size);
    return reply.send(store.read(key));
  }

  // ?v=preview: the thumbnail, video poster or browser-friendly audio. ?download=1: save with the original file name.
  app.get<{ Params: { id: string }; Querystring: { v?: string; download?: string } }>('/messages/:id/media', async (req, reply) => {
    const auth = requireAuth(req);
    const msg = await messageFor(auth, req.params.id);
    if (req.query.v === 'preview') {
      if (!msg.previewKey) throw new HttpError(404, 'مفيش معاينة', 'not_found');
      const ext = msg.previewKey.split('.').pop();
      return stream(req, reply, msg.previewKey, ext === 'webp' ? 'image/webp' : ext === 'm4a' ? 'audio/mp4' : 'image/jpeg', { etag: `${msg.id}-p` });
    }
    if (!msg.mediaKey || msg.mediaStatus !== 'READY') throw new HttpError(404, 'الملف لسه بيتحمّل', 'not_ready');
    const download = req.query.download === '1' || msg.type === 'document'
      ? (msg.fileName ?? `dosly-${msg.id}.${msg.mediaKey.split('.').pop()}`) : undefined;
    return stream(req, reply, msg.mediaKey, msg.mediaMime ?? 'application/octet-stream', { etag: msg.mediaSha256 ?? msg.id, download });
  });

  // Sends a photo, video, document or voice note. Fields (caption, voice) must come before the file part.
  app.post<{ Params: { id: string } }>('/conversations/:id/attachments', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await conversationFor(auth, req.params.id);
    if (replyWindow(conv.channel, conv.lastInboundAt) === 'closed') throw new HttpError(409, WINDOW_CLOSED_AR[conv.channel], 'window_closed');
    const social = conv.channel !== 'WHATSAPP';
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5 } });
    if (!file) throw new HttpError(400, 'مفيش ملف', 'no_file');
    const field = (n: string) => { const f = file.fields[n] as { value?: unknown } | undefined; return typeof f?.value === 'string' ? f.value : undefined; };
    const caption = (field('caption') ?? '').trim().slice(0, 1024) || null;
    const wantVoice = field('voice') === 'true';
    const fileName = (file.filename || 'file').replace(/[\\/\0]/g, '_').slice(0, 200);

    const tmp = tempPath('upload');
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw new HttpError(413, 'الملف أكبر من 100 ميجا، وده أقصى حجم في واتساب', 'too_large');
      const size = file.file.bytesRead;
      let c: Omit<Awaited<ReturnType<typeof classifyUpload>>, 'convert'> & { convert: OutboundPayload['convert'] };
      try { c = await classifyUpload(tmp, size, fileName, wantVoice); }
      catch (e) { if (e instanceof UploadRejected) throw new HttpError(400, e.message, 'bad_media'); throw e; }
      if (social) {
        // Messenger and Instagram: 25 MB, images 8 MB, audio as AAC/MP3 (no Ogg), Instagram files PDF only.
        if (size > SOCIAL_MEDIA_MAX && c.kind !== 'image') throw new HttpError(400, 'الملف أكبر من 25 ميجا، وده أقصى حجم في ماسنجر وإنستجرام', 'bad_media');
        if (c.kind === 'document' && conv.channel === 'INSTAGRAM' && c.mime !== 'application/pdf') throw new HttpError(400, 'إنستجرام بيقبل ملفات PDF بس', 'bad_media');
        if (c.kind === 'audio' && (c.convert || !['audio/mpeg', 'audio/mp4', 'audio/aac'].includes(c.mime))) c = { ...c, mime: 'audio/mp4', ext: 'm4a', convert: 'm4a' as const };
        // Instagram takes PNG or JPEG only; anything else, or anything over 8 MB, becomes JPEG.
        if (c.kind === 'image' && !c.convert && (size > SOCIAL_IMAGE_MAX || (conv.channel === 'INSTAGRAM' && !['image/png', 'image/jpeg'].includes(c.mime)))) c = { ...c, mime: 'image/jpeg', ext: 'jpg', convert: 'jpeg' as const };
        const captionProblem = caption ? socialTextProblem(conv.channel === 'INSTAGRAM' ? 'INSTAGRAM' : 'MESSENGER', caption) : null;
        if (captionProblem) throw new HttpError(400, captionProblem, 'too_long');
      }

      const payload: OutboundPayload = { kind: c.kind, convert: c.convert };
      const msg = await db.message.create({ data: {
        agencyId: auth.agencyId, conversationId: conv.id, direction: 'OUT', type: c.kind, body: c.kind === 'audio' ? null : caption,
        status: 'QUEUED', sentById: auth.userId, mediaStatus: 'READY', mediaMime: c.mime, mediaSize: size, voice: c.voice,
        fileName: c.kind === 'document' ? fileName : null, mediaWidth: c.width, mediaHeight: c.height, durationSec: c.duration,
        payload: payload as Prisma.InputJsonValue
      } });
      const k = mediaKey(auth.agencyId, msg.id, c.convert ? (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin' : c.ext, c.convert ? '-src' : '');
      await store.put(k, tmp);
      const saved = await db.message.update({ where: { id: msg.id }, data: { mediaKey: k } });
      await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: saved.createdAt, lastPreview: previewText(saved.type, saved.body, saved.voice), unreadCount: 0, assigneeId: conv.assigneeId ?? auth.userId } });
      await queues.sendMessage(saved.id);
      await realtime.publish(auth.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: saved.id, direction: 'OUT' });
      return reply.status(201).send(publicMessage(saved));
    } finally {
      await rm(tmp, { force: true });
    }
  });

  // Retry: a failed outbound send, or an inbound file that could not be downloaded.
  app.post<{ Params: { id: string } }>('/messages/:id/retry', async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const msg = await messageFor(auth, req.params.id);
    if (msg.direction === 'IN' && (msg.mediaId || (msg.payload as { sourceUrl?: string } | null)?.sourceUrl) && msg.mediaStatus === 'FAILED') {
      await db.message.update({ where: { id: msg.id }, data: { mediaStatus: 'PENDING', error: null } });
      await queues.fetchMedia(msg.id);
    } else if (msg.direction === 'OUT' && msg.status === 'FAILED' && msg.payload) {
      await db.message.update({ where: { id: msg.id }, data: { status: 'QUEUED', error: null } });
      await queues.sendMessage(msg.id);
    } else throw new HttpError(409, 'الرسالة دي مش محتاجة إعادة', 'not_failed');
    await realtime.publish(auth.agencyId, { type: 'message.updated', conversationId: msg.conversationId, messageId: msg.id });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/conversations/:id/templates', async req => {
    const auth = requireAuth(req);
    const conv = await waConversationFor(auth, req.params.id);
    const synced = conv.waNumber.templatesSyncedAt;
    if (!synced || Date.now() - synced.getTime() > TEMPLATE_STALE_MS) await queues.syncTemplates(conv.waNumberId);
    const rows = await db.waTemplate.findMany({ where: { waNumberId: conv.waNumberId }, orderBy: [{ name: 'asc' }, { language: 'asc' }] });
    const items = rows.map(t => ({ id: t.id, name: t.name, language: t.language, category: t.category, status: t.status, reason: t.reason, shape: templateShape(t) }));
    items.sort((a, b) => Number(b.status === 'APPROVED') - Number(a.status === 'APPROVED'));
    return { items, syncedAt: synced, windowOpen: isWindowOpen(conv.lastInboundAt) };
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/templates/sync', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await waConversationFor(auth, req.params.id);
    await queues.syncTemplates(conv.waNumberId);
    return { ok: true };
  });

  const templateBody = z.object({ templateId: z.string(), values: z.record(z.string(), z.string().max(1024)).default({}) });

  // Sends an approved template. JSON, or multipart (`data` JSON field first, then `header` file) when the header is media.
  app.post<{ Params: { id: string } }>('/conversations/:id/template', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await waConversationFor(auth, req.params.id);
    let input: z.infer<typeof templateBody>;
    let tmp: string | undefined;
    let header: { size: number; fileName: string } | undefined;
    try {
      if (req.isMultipart()) {
        const file = await req.file({ limits: { fileSize: WA_MEDIA_LIMITS.document, files: 1, fields: 2 } });
        if (!file) throw new HttpError(400, 'مفيش ملف', 'no_file');
        const data = (file.fields.data as { value?: string } | undefined)?.value;
        input = templateBody.parse(JSON.parse(data ?? '{}'));
        tmp = tempPath('upload');
        await pipeline(file.file, createWriteStream(tmp));
        if (file.file.truncated) throw new HttpError(413, 'الملف كبير جدًا', 'too_large');
        header = { size: file.file.bytesRead, fileName: (file.filename || 'file').replace(/[\\/\0]/g, '_').slice(0, 200) };
      } else input = templateBody.parse(req.body);

      const t = await db.waTemplate.findFirst({ where: { id: input.templateId, waNumberId: conv.waNumberId } });
      if (!t) throw new HttpError(404, 'القالب مش موجود على الرقم ده', 'not_found');
      if (t.status !== 'APPROVED') throw new HttpError(409, 'القالب ده لسه مش متوافق عليه من Meta', 'template_not_approved');
      const shape = templateShape(t);
      const missing = shape.fields.filter(f => paramProblem(input.values[f.id]));
      if (missing.length) throw new HttpError(400, 'كمّل كل الخانات. ممنوع سطر جديد أو أكتر من 4 مسافات ورا بعض (قاعدة واتساب)', 'bad_params');

      let c: Awaited<ReturnType<typeof classifyUpload>> | undefined;
      if (shape.headerMedia) {
        if (!tmp || !header) throw new HttpError(400, 'القالب ده محتاج صورة أو ملف في أوله', 'header_required');
        try { c = await classifyUpload(tmp, header.size, header.fileName, false); }
        catch (e) { if (e instanceof UploadRejected) throw new HttpError(400, e.message, 'bad_media'); throw e; }
        if (c.kind !== shape.headerMedia.toLowerCase()) throw new HttpError(400, 'نوع الملف مش زي اللي القالب مستنيه', 'bad_media');
      }
      const built = buildTemplateMessage(t, input.values, c ? { id: 'pending' } : undefined).template;
      const rendered = renderTemplate(t, input.values);
      const payload: OutboundPayload = {
        kind: 'template', template: { ...built, components: (built.components as Record<string, unknown>[] | undefined)?.filter(x => !(c && x.type === 'header')) },
        ...(c && { headerKind: c.kind as 'image' | 'video' | 'document', convert: c.convert }),
        rendered: { header: rendered.header, footer: rendered.footer, buttons: rendered.buttons }
      };
      const msg = await db.message.create({ data: {
        agencyId: auth.agencyId, conversationId: conv.id, direction: 'OUT', type: 'template', body: rendered.body, status: 'QUEUED', sentById: auth.userId,
        payload: payload as Prisma.InputJsonValue,
        ...(c && header && { mediaStatus: 'READY' as const, mediaMime: c.mime, mediaSize: header.size, fileName: c.kind === 'document' ? header.fileName : null, mediaWidth: c.width, mediaHeight: c.height })
      } });
      let saved = msg;
      if (c && tmp) {
        const k = mediaKey(auth.agencyId, msg.id, c.convert ? 'src' : c.ext, c.convert ? '-src' : '');
        await store.put(k, tmp);
        saved = await db.message.update({ where: { id: msg.id }, data: { mediaKey: k } });
      }
      await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: saved.createdAt, lastPreview: previewText('template', rendered.body), assigneeId: conv.assigneeId ?? auth.userId } });
      await queues.sendMessage(saved.id);
      await realtime.publish(auth.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: saved.id, direction: 'OUT' });
      return reply.status(201).send(publicMessage(saved));
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  });
};
