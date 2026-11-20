import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { can, postSchema } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';
import { localStorage, sniffImage } from '../storage.js';

const EDITABLE = ['DRAFT', 'SCHEDULED', 'FAILED'] as const;

export const postRoutes: FastifyPluginAsync = async app => {
  const { db, queues, env, realtime } = app.deps;
  const storage = localStorage(env.UPLOAD_DIR, env.PUBLIC_URL);

  async function validateTargets(agencyId: string, clientId: string, ids: string[], mediaUrls: string[]) {
    const accounts = await db.socialAccount.findMany({ where: { id: { in: ids }, agencyId, clientId } });
    if (accounts.length !== new Set(ids).size) throw new HttpError(400, 'فيه حساب مش تابع للعميل ده', 'bad_target');
    if (accounts.some(a => a.platform === 'INSTAGRAM') && mediaUrls.length === 0) throw new HttpError(400, 'بوست إنستجرام لازم يكون فيه صورة', 'instagram_needs_image');
  }

  app.get('/posts', async req => {
    const auth = requireAuth(req);
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date(), clientId: z.string().optional() }).parse(req.query);
    if (q.to.getTime() - q.from.getTime() > 62 * 86400_000) throw new HttpError(400, 'أقصى مدة شهرين', 'range_too_long');
    const visible = await visibleClientIds(db, auth);
    return db.post.findMany({
      where: {
        agencyId: auth.agencyId,
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(visible === 'all' ? {} : { clientId: { in: visible } }),
        OR: [{ scheduledAt: { gte: q.from, lt: q.to } }, { scheduledAt: null, createdAt: { gte: q.from, lt: q.to } }]
      },
      orderBy: { scheduledAt: 'asc' },
      include: { targets: { include: { socialAccount: { select: { platform: true, name: true } } } }, client: { select: { name: true } }, createdBy: { select: { name: true } } }
    });
  });

  /**
   * Writers create drafts; a manager's approval schedules them. Managers and owners
   * can schedule directly. A post without a time stays a draft.
   */
  app.post('/posts', async (req, reply) => {
    const auth = requirePermission(req, 'posts:write');
    const input = postSchema.parse(req.body);
    await assertClientAccess(db, auth, input.clientId);
    await validateTargets(auth.agencyId, input.clientId, input.socialAccountIds, input.mediaUrls);
    if (input.scheduledAt && input.scheduledAt.getTime() < Date.now() - 60_000) throw new HttpError(400, 'الميعاد ده عدّى', 'in_past');
    const schedule = !!input.scheduledAt && can(auth.role, 'posts:approve');
    const client = await db.client.findUniqueOrThrow({ where: { id: input.clientId } });
    const post = await db.post.create({
      data: {
        agencyId: auth.agencyId, clientId: input.clientId, createdById: auth.userId, caption: input.caption, mediaUrls: input.mediaUrls,
        scheduledAt: input.scheduledAt ?? null, status: schedule ? 'SCHEDULED' : 'DRAFT', approvedById: schedule ? auth.userId : null,
        clientReview: schedule && client.requiresClientApproval ? 'PENDING' : 'NOT_REQUIRED',
        targets: { create: [...new Set(input.socialAccountIds)].map(socialAccountId => ({ socialAccountId })) }
      }
    });
    if (schedule) await queues.schedulePost(post.id, post.scheduledAt!);
    await audit(db, auth, schedule ? 'post.schedule' : 'post.draft', 'Post', post.id);
    return reply.status(201).send(post);
  });

  app.patch<{ Params: { id: string } }>('/posts/:id', async req => {
    const auth = requirePermission(req, 'posts:write');
    const post = await db.post.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!post) throw new HttpError(404, 'البوست مش موجود', 'not_found');
    await assertClientAccess(db, auth, post.clientId);
    if (!(EDITABLE as readonly string[]).includes(post.status)) throw new HttpError(409, 'البوست ده اتنشر أو بيتنشر دلوقتي', 'locked');
    const input = postSchema.omit({ clientId: true }).partial().parse(req.body);
    const mediaUrls = input.mediaUrls ?? post.mediaUrls;
    if (input.socialAccountIds) await validateTargets(auth.agencyId, post.clientId, input.socialAccountIds, mediaUrls);
    // Any edit by a writer sends the post back for approval.
    const needsApproval = !can(auth.role, 'posts:approve');
    const client = await db.client.findUniqueOrThrow({ where: { id: post.clientId } });
    // A changed post is a different post: the client has to look at it again.
    const changed = input.caption !== undefined || input.mediaUrls !== undefined || input.scheduledAt !== undefined;
    const review = needsApproval ? { clientReview: 'NOT_REQUIRED' as const } : client.requiresClientApproval && changed && post.status === 'SCHEDULED' ? { clientReview: 'PENDING' as const, reviewedAt: null } : {};
    const updated = await db.$transaction(async tx => {
      if (input.socialAccountIds) {
        await tx.postTarget.deleteMany({ where: { postId: post.id } });
        await tx.postTarget.createMany({ data: [...new Set(input.socialAccountIds)].map(socialAccountId => ({ postId: post.id, socialAccountId })) });
      }
      return tx.post.update({
        where: { id: post.id },
        data: { caption: input.caption, mediaUrls, scheduledAt: input.scheduledAt === undefined ? undefined : input.scheduledAt, ...review, ...(needsApproval ? { status: 'DRAFT', approvedById: null } : {}) }
      });
    });
    if (updated.status === 'SCHEDULED' && updated.scheduledAt) await queues.schedulePost(updated.id, updated.scheduledAt);
    else await queues.cancelPost(updated.id);
    await audit(db, auth, 'post.edit', 'Post', post.id);
    return updated;
  });

  app.post<{ Params: { id: string } }>('/posts/:id/approve', async req => {
    const auth = requirePermission(req, 'posts:approve');
    const post = await db.post.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!post) throw new HttpError(404, 'البوست مش موجود', 'not_found');
    if (!post.scheduledAt) throw new HttpError(400, 'حدد ميعاد النشر الأول', 'no_time');
    if (post.status !== 'DRAFT') throw new HttpError(409, 'البوست ده مش مسودة', 'not_draft');
    const client = await db.client.findUniqueOrThrow({ where: { id: post.clientId } });
    const updated = await db.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED', approvedById: auth.userId, clientReview: client.requiresClientApproval ? 'PENDING' : 'NOT_REQUIRED', reviewedAt: null } });
    await queues.schedulePost(post.id, post.scheduledAt);
    await audit(db, auth, 'post.approve', 'Post', post.id);
    await realtime.publish(auth.agencyId, { type: 'post.updated', postId: post.id, status: 'SCHEDULED' });
    return updated;
  });

  app.post<{ Params: { id: string } }>('/posts/:id/publish-now', async req => {
    const auth = requirePermission(req, 'posts:approve');
    const post = await db.post.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!post) throw new HttpError(404, 'البوست مش موجود', 'not_found');
    if (!['DRAFT', 'SCHEDULED', 'FAILED', 'PARTIAL'].includes(post.status)) throw new HttpError(409, 'البوست ده اتنشر أو بيتنشر دلوقتي', 'locked');
    if (post.clientReview === 'PENDING' || post.clientReview === 'CHANGES_REQUESTED') throw new HttpError(409, post.clientReview === 'PENDING' ? 'البوست مستني موافقة العميل من البوابة' : 'العميل طلب تعديل على البوست ده', 'client_review');
    const now = new Date();
    await db.post.update({ where: { id: post.id }, data: { status: 'SCHEDULED', scheduledAt: post.status === 'PARTIAL' ? post.scheduledAt : now, approvedById: auth.userId } });
    await queues.schedulePost(post.id, now);
    await audit(db, auth, 'post.publish_now', 'Post', post.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/posts/:id', async req => {
    const auth = requirePermission(req, 'posts:write');
    const post = await db.post.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!post) throw new HttpError(404, 'البوست مش موجود', 'not_found');
    await assertClientAccess(db, auth, post.clientId);
    if (post.status === 'PUBLISHING') throw new HttpError(409, 'البوست بيتنشر دلوقتي', 'locked');
    await queues.cancelPost(post.id);
    await db.post.delete({ where: { id: post.id } });
    await audit(db, auth, 'post.delete', 'Post', post.id);
    return { ok: true };
  });

  app.post('/uploads', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    requirePermission(req, 'posts:write');
    const file = await req.file();
    if (!file) throw new HttpError(400, 'مفيش ملف', 'no_file');
    const bytes = await file.toBuffer();
    const ext = sniffImage(bytes);
    if (!ext) throw new HttpError(400, 'الصور المسموحة: JPG أو PNG أو WEBP', 'bad_type');
    return reply.status(201).send({ url: await storage.save(bytes, ext) });
  });
};
