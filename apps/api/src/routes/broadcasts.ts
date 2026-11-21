import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@dosly/db';
import { broadcastStats, cancelBroadcast, classifyUpload, countAudience, mediaKey, messageFor, tempPath, toWhatsAppJpeg, UploadRejected } from '@dosly/core';
import {
  BROADCAST_MAX_RECIPIENTS, broadcastAudienceSchema, broadcastErrorAr, estimateCostUsd, NAME_TOKEN, paramProblem, templateShape, UNVERIFIED_DAILY_LIMIT, WA_MEDIA_LIMITS
} from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requirePermission, visibleClientIds, type AuthContext } from '../auth.js';

const createBody = z.object({
  waNumberId: z.string().min(1),
  templateId: z.string().min(1),
  name: z.string().trim().min(1, 'اكتب اسم للحملة').max(120),
  values: z.record(z.string(), z.string().max(1024)).default({}),
  audience: broadcastAudienceSchema,
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  consent: z.literal(true, { error: 'لازم تأكد إن العملاء دول وافقوا يوصلهم رسايل من البيزنس' })
});
const audienceBody = z.object({ waNumberId: z.string().min(1), templateId: z.string().min(1).optional(), audience: broadcastAudienceSchema });

/** Categories a broadcast may use. Authentication templates are for one-time codes only. */
const SENDABLE = ['MARKETING', 'UTILITY'];

export const broadcastRoutes: FastifyPluginAsync = async app => {
  const { db, queues, realtime, media: store } = app.deps;

  async function numberFor(auth: AuthContext, waNumberId: string) {
    const num = await db.whatsAppNumber.findFirst({ where: { id: waNumberId, agencyId: auth.agencyId } });
    if (!num) throw new HttpError(404, 'الرقم مش موجود', 'not_found');
    await assertClientAccess(db, auth, num.clientId);
    return num;
  }
  async function templateFor(waNumberId: string, templateId: string) {
    const t = await db.waTemplate.findFirst({ where: { id: templateId, waNumberId } });
    if (!t) throw new HttpError(404, 'القالب مش موجود على الرقم ده', 'not_found');
    if (t.status !== 'APPROVED') throw new HttpError(409, 'القالب ده لسه مش متوافق عليه من ميتا', 'template_not_approved');
    if (!SENDABLE.includes(t.category)) throw new HttpError(409, 'قوالب أكواد التأكيد مينفعش تتبعت كحملة', 'bad_category');
    return t;
  }
  async function broadcastFor(auth: AuthContext, id: string) {
    const b = await db.broadcast.findFirst({ where: { id, agencyId: auth.agencyId }, include: { client: { select: { name: true } }, waNumber: { select: { displayPhone: true } }, createdBy: { select: { name: true } } } });
    if (!b) throw new HttpError(404, 'الحملة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, b.clientId);
    return b;
  }
  const publicBroadcast = (b: Awaited<ReturnType<typeof broadcastFor>>, stats: unknown) => {
    const { template, values, headerKey, headerMediaId, headerUploadedAt, ...rest } = b;
    const sample = messageFor(b, 'أحمد');
    return { ...rest, hasHeader: !!headerKey, preview: sample ? { ...sample.rendered, body: sample.rendered.body } : null, stats };
  };

  /** What can be sent: per visible client, its connected numbers and their approved templates. */
  app.get('/broadcasts/options', async req => {
    const auth = requirePermission(req, 'broadcasts:send');
    const visible = await visibleClientIds(db, auth);
    const clients = await db.client.findMany({
      where: { agencyId: auth.agencyId, archivedAt: null, ...(visible !== 'all' && { id: { in: visible } }) }, orderBy: { name: 'asc' },
      select: { id: true, name: true, waNumbers: { where: { status: 'CONNECTED' }, orderBy: { createdAt: 'asc' }, select: { id: true, displayPhone: true, verifiedName: true, templates: { where: { status: 'APPROVED', category: { in: SENDABLE } }, orderBy: { name: 'asc' } } } } }
    });
    return clients.map(c => ({
      id: c.id, name: c.name,
      numbers: c.waNumbers.map(n => ({
        id: n.id, displayPhone: n.displayPhone, verifiedName: n.verifiedName,
        // Offers first: that is what broadcasts are for.
        templates: [...n.templates].sort((a, b) => Number(b.category === 'MARKETING') - Number(a.category === 'MARKETING')).map(t => ({ id: t.id, name: t.name, language: t.language, category: t.category, shape: templateShape(t) }))
      }))
    }));
  });

  /** How many people an audience reaches right now, and roughly what Meta will charge. */
  app.post('/broadcasts/audience', async req => {
    const auth = requirePermission(req, 'broadcasts:send');
    const input = audienceBody.parse(req.body);
    const num = await numberFor(auth, input.waNumberId);
    const category = input.templateId ? (await templateFor(num.id, input.templateId)).category : 'MARKETING';
    const c = await countAudience(db, { clientId: num.clientId, waNumberId: num.id, category }, input.audience);
    const people = Math.min(c.people, BROADCAST_MAX_RECIPIENTS);
    return { ...c, people, capped: c.people > BROADCAST_MAX_RECIPIENTS, costUsd: estimateCostUsd(category, people), category, overNewLimit: people > UNVERIFIED_DAILY_LIMIT };
  });

  /**
   * Creates a broadcast to start now or at a time. JSON, or multipart (`data` JSON field first, then the
   * `header` image) when the template starts with an image.
   */
  app.post('/broadcasts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'broadcasts:send');
    let raw: unknown;
    let tmp: string | undefined;
    let size = 0, fileName = 'header';
    try {
      if (req.isMultipart()) {
        const file = await req.file({ limits: { fileSize: WA_MEDIA_LIMITS.image * 4, files: 1, fields: 2 } });
        if (!file) throw new HttpError(400, 'مفيش صورة', 'no_file');
        try { raw = JSON.parse(String((file.fields.data as { value?: string } | undefined)?.value ?? '{}')); } catch { throw new HttpError(400, 'البيانات مش مفهومة', 'bad_json'); }
        tmp = tempPath('upload');
        await pipeline(file.file, createWriteStream(tmp));
        if (file.file.truncated) throw new HttpError(413, 'الصورة كبيرة جدًا. الحد 5 ميجا', 'too_large');
        size = file.file.bytesRead;
        fileName = (file.filename || 'header').replace(/[\\/\0]/g, '_').slice(0, 200);
      } else raw = req.body;
      const input = createBody.parse(raw);
      const num = await numberFor(auth, input.waNumberId);
      const client = await db.client.findUniqueOrThrow({ where: { id: num.clientId }, select: { archivedAt: true } });
      if (client.archivedAt) throw new HttpError(409, 'العميل ده متأرشف', 'archived');
      if (num.status !== 'CONNECTED') throw new HttpError(409, 'الرقم ده مش متوصل دلوقتي', 'not_connected');
      const t = await templateFor(num.id, input.templateId);
      const shape = templateShape(t);
      const values = Object.fromEntries(shape.fields.map(f => [f.id, (input.values[f.id] ?? '').trim()]));
      // Checked as it would go out with a real name, since "[الاسم]" is filled per person.
      if (shape.fields.some(f => paramProblem(values[f.id]!.split(NAME_TOKEN).join('أحمد')))) {
        throw new HttpError(400, 'كمّل كل الخانات. ممنوع سطر جديد أو أكتر من 4 مسافات ورا بعض (قاعدة واتساب)', 'bad_params');
      }
      if (shape.headerMedia && shape.headerMedia !== 'IMAGE') throw new HttpError(400, 'القوالب اللي أولها فيديو أو ملف لسه مش مدعومة في الحملات. اختار قالب بصورة أو من غير', 'unsupported_header');
      if (shape.headerMedia && !tmp) throw new HttpError(400, 'القالب ده محتاج صورة في أوله', 'header_required');

      const now = new Date();
      const at = input.scheduledAt ? new Date(input.scheduledAt) : now;
      if (at.getTime() < now.getTime() - 60_000) throw new HttpError(400, 'الميعاد ده عدّى', 'past');
      if (at.getTime() > now.getTime() + 30 * 86_400_000) throw new HttpError(400, 'الميعاد لازم يكون خلال 30 يوم', 'too_far');
      const count = await countAudience(db, { clientId: num.clientId, waNumberId: num.id, category: t.category }, input.audience, now);
      if (at <= now && count.people === 0) throw new HttpError(409, 'مفيش حد في الجمهور ده دلوقتي', 'empty_audience');

      let headerKey: string | null = null;
      if (tmp && shape.headerMedia === 'IMAGE') {
        let c;
        try { c = await classifyUpload(tmp, size, fileName, false); }
        catch (e) { if (e instanceof UploadRejected) throw new HttpError(400, e.message, 'bad_media'); throw e; }
        if (c.kind !== 'image') throw new HttpError(400, 'القالب ده محتاج صورة (JPG أو PNG)', 'bad_media');
        const src = c.convert ? await toWhatsAppJpeg(tmp) : tmp;
        headerKey = mediaKey(auth.agencyId, `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, c.convert ? 'jpg' : c.ext);
        await store.put(headerKey, src);
        if (src !== tmp) await rm(src, { force: true });
      }

      const b = await db.broadcast.create({ data: {
        agencyId: auth.agencyId, clientId: num.clientId, waNumberId: num.id, name: input.name, templateName: t.name, language: t.language, category: t.category,
        template: { parameterFormat: t.parameterFormat, components: t.components } as Prisma.InputJsonValue, values, audience: input.audience,
        headerKey, scheduledAt: at, createdById: auth.userId, total: count.people
      } });
      await queues.runBroadcast(b.id, at);
      await audit(db, auth, 'broadcast.create', 'Broadcast', b.id, { name: b.name, template: t.name, audience: input.audience, people: count.people, scheduledAt: at });
      await realtime.publish(auth.agencyId, { type: 'broadcast.updated', broadcastId: b.id });
      return reply.status(201).send({ id: b.id });
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  });

  app.get<{ Querystring: { clientId?: string; cursor?: string } }>('/broadcasts', async req => {
    const auth = requirePermission(req, 'broadcasts:send');
    const visible = await visibleClientIds(db, auth);
    if (req.query.clientId) await assertClientAccess(db, auth, req.query.clientId);
    const rows = await db.broadcast.findMany({
      where: { agencyId: auth.agencyId, ...(req.query.clientId ? { clientId: req.query.clientId } : visible !== 'all' && { clientId: { in: visible } }) },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }], take: 31, ...(req.query.cursor && { cursor: { id: req.query.cursor }, skip: 1 }),
      include: { client: { select: { name: true } }, waNumber: { select: { displayPhone: true } }, createdBy: { select: { name: true } } }
    });
    const page = rows.slice(0, 30);
    const stats = await broadcastStats(db, page.map(b => b.id));
    return { items: page.map(b => publicBroadcast(b, stats.get(b.id))), nextCursor: rows.length > 30 ? page.at(-1)!.id : null };
  });

  app.get<{ Params: { id: string }; Querystring: { show?: string; cursor?: string } }>('/broadcasts/:id', async req => {
    const auth = requirePermission(req, 'broadcasts:send');
    const b = await broadcastFor(auth, req.params.id);
    const stats = (await broadcastStats(db, [b.id])).get(b.id);
    const show = req.query.show;
    const where: Prisma.BroadcastRecipientWhereInput = { broadcastId: b.id,
      ...(show === 'replied' ? { repliedAt: { not: null } }
        : show === 'failed' ? { state: 'FAILED' }
        : show === 'pending' ? { state: 'PENDING' } : {}) };
    const rows = await db.broadcastRecipient.findMany({
      where, orderBy: { id: 'asc' }, take: 51, ...(req.query.cursor && { cursor: { id: req.query.cursor }, skip: 1 }),
      include: { contact: { select: { name: true, waId: true, marketingOptOutAt: true, conversations: { where: { waNumberId: b.waNumberId }, select: { id: true }, take: 1 } } } }
    });
    const msgs = new Map((await db.message.findMany({ where: { id: { in: rows.map(r => r.messageId).filter((x): x is string => !!x) } }, select: { id: true, status: true, error: true } })).map(m => [m.id, m]));
    const page = rows.slice(0, 50);
    return {
      broadcast: publicBroadcast(b, stats),
      recipients: page.map(r => {
        const m = r.messageId ? msgs.get(r.messageId) : undefined;
        const failed = r.state === 'FAILED' || m?.status === 'FAILED';
        const code = r.errorCode ?? (m?.error ? Number(/^(\d{3,6})\b/.exec(m.error)?.[1]) || null : null);
        return {
          id: r.id, name: r.contact.name, phone: r.contact.waId, conversationId: r.contact.conversations[0]?.id ?? null,
          state: failed ? 'FAILED' : r.state === 'SENT' ? (m?.status ?? 'SENT') : r.state, repliedAt: r.repliedAt, sentAt: r.sentAt,
          optedOut: !!r.contact.marketingOptOutAt, error: failed ? broadcastErrorAr(code, r.error ?? m?.error) : null
        };
      }),
      nextCursor: rows.length > 50 ? page.at(-1)!.id : null
    };
  });

  app.post<{ Params: { id: string } }>('/broadcasts/:id/cancel', async req => {
    const auth = requirePermission(req, 'broadcasts:send');
    const b = await broadcastFor(auth, req.params.id);
    if (!(await cancelBroadcast(db, realtime, auth.agencyId, b.id))) throw new HttpError(409, 'الحملة دي خلصت خلاص', 'finished');
    await audit(db, auth, 'broadcast.cancel', 'Broadcast', b.id, { name: b.name });
    return { ok: true };
  });

  /** The header image, for the preview. */
  app.get<{ Params: { id: string } }>('/broadcasts/:id/header', async (req, reply) => {
    const auth = requirePermission(req, 'broadcasts:send');
    const b = await db.broadcast.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { clientId: true, headerKey: true } });
    if (!b?.headerKey) throw new HttpError(404, 'مفيش صورة', 'not_found');
    await assertClientAccess(db, auth, b.clientId);
    const st = await store.stat(b.headerKey);
    if (!st) throw new HttpError(404, 'مفيش صورة', 'not_found');
    reply.header('Cache-Control', 'private, max-age=604800, immutable').header('X-Content-Type-Options', 'nosniff').header('Content-Length', st.size);
    return reply.type(b.headerKey.endsWith('.png') ? 'image/png' : 'image/jpeg').send(store.read(b.headerKey));
  });
};
