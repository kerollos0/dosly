import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { decrypt, PLAN_TIERS, PLANS, verifyPassword, verifyTotp } from '@dosly/shared';
import { createSession, HttpError } from '../auth.js';
import { ADMIN_COOKIE, createAdminSession, requireAdmin, resolveAdminSession } from '../admin-auth.js';

const DAY = 86400_000;

/** Dosly's own back office. Mounted at /api/admin. */
export const adminRoutes: FastifyPluginAsync = async app => {
  const { db, env, key, queues } = app.deps;
  const secure = env.PUBLIC_URL.startsWith('https://');

  app.addHook('onRequest', async req => {
    const ctx = await resolveAdminSession(db, req.cookies[ADMIN_COOKIE]);
    if (ctx) req.admin = ctx;
  });

  // An admin action is also written to the agency's own activity log, so agencies can see when Dosly touched their account.
  // Real staff see real agencies; the read-only demo tour sees only demo sandboxes (made-up data).
  const scope = (a: { readOnly: boolean }) => (a.readOnly ? { demoExpiresAt: { not: null } } : { demoExpiresAt: null });

  const agencyLog = (agencyId: string, action: string, meta: object) =>
    db.auditLog.create({ data: { agencyId, userId: null, action, entity: 'Agency', entityId: agencyId, meta: { by: 'dosly', ...meta } } });

  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const input = z.object({ email: z.email().trim().toLowerCase(), password: z.string().min(1), code: z.string().trim() }).parse(req.body);
    const admin = await db.adminUser.findUnique({ where: { email: input.email } });
    // One message for every failure, so the form does not reveal which part was wrong.
    const ok = admin && (await verifyPassword(input.password, admin.passwordHash)) && verifyTotp(decrypt(admin.totpSecretEnc, key), input.code);
    if (!ok) throw new HttpError(401, 'البيانات أو الكود غلط', 'invalid_credentials');
    await createAdminSession(db, reply, admin.id, secure);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.admin) await db.adminSession.delete({ where: { id: req.admin.sessionId } }).catch(() => {});
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async req => {
    const a = requireAdmin(req);
    return { name: a.name, readOnly: a.readOnly };
  });

  app.get('/overview', async req => {
    const admin = requireAdmin(req);
    const now = new Date();
    const real = scope(admin);
    const [byPlan, suspended, newWeek, trialsEnding, messagesWeek, postsWeek, failedPosts, failedHooks] = await Promise.all([
      db.agency.groupBy({ by: ['plan'], where: { ...real, status: 'ACTIVE' }, _count: true }),
      db.agency.count({ where: { ...real, status: 'SUSPENDED' } }),
      db.agency.count({ where: { ...real, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      db.agency.count({ where: { ...real, plan: 'TRIAL', trialEndsAt: { gte: now, lt: new Date(now.getTime() + 3 * DAY) } } }),
      db.message.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY) }, agency: real } }),
      db.postTarget.count({ where: { status: 'PUBLISHED', publishedAt: { gte: new Date(now.getTime() - 7 * DAY) }, post: { agency: real } } }),
      db.post.count({ where: { status: { in: ['FAILED', 'PARTIAL'] }, updatedAt: { gte: new Date(now.getTime() - 7 * DAY) }, agency: real } }),
      db.webhookEvent.count({ where: { processedAt: null, receivedAt: { lt: new Date(now.getTime() - 5 * 60_000) } } })
    ]);
    const plans = Object.fromEntries(PLAN_TIERS.map(t => [t, byPlan.find(b => b.plan === t)?._count ?? 0])) as Record<string, number>;
    const mrrEgp = PLAN_TIERS.reduce((sum, t) => sum + plans[t]! * PLANS[t].priceEgp, 0);
    const demoSandboxes = await db.agency.count({ where: { demoExpiresAt: { not: null } } });
    return { plans, suspended, newWeek, trialsEnding, mrrEgp, messagesWeek, postsWeek, failedPosts, failedHooks, demoSandboxes };
  });

  app.get('/agencies', async req => {
    const admin = requireAdmin(req);
    const q = z.object({ q: z.string().trim().max(100).optional(), demo: z.enum(['true', 'false']).default('false'), cursor: z.string().optional() }).parse(req.query);
    const where = admin.readOnly ? scope(admin) : { demoExpiresAt: q.demo === 'true' ? { not: null } : null };
    const take = 30;
    const rows = await db.agency.findMany({
      where: {
        ...where,
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { memberships: { some: { role: 'OWNER', user: { email: { contains: q.q, mode: 'insensitive' } } } } }] } : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true, name: true, plan: true, status: true, trialEndsAt: true, paidUntil: true, createdAt: true, demoExpiresAt: true,
        memberships: { where: { role: 'OWNER' }, take: 1, select: { user: { select: { name: true, email: true } } } },
        _count: { select: { clients: { where: { archivedAt: null } }, memberships: true } }
      }
    });
    const page = rows.slice(0, take);
    return {
      items: page.map(({ memberships, _count, ...a }) => ({ ...a, owner: memberships[0]?.user ?? null, clients: _count.clients, members: _count.memberships })),
      nextCursor: rows.length > take ? page[page.length - 1]!.id : null
    };
  });

  app.get<{ Params: { id: string } }>('/agencies/:id', async req => {
    const admin = requireAdmin(req);
    const a = await db.agency.findFirst({
      where: { id: req.params.id, ...(admin.readOnly ? scope(admin) : {}) },
      include: {
        memberships: { orderBy: { createdAt: 'asc' }, select: { role: true, createdAt: true, user: { select: { id: true, name: true, email: true } } } },
        payments: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { clients: { where: { archivedAt: null } }, waNumbers: true, socialAccounts: true } }
      }
    });
    if (!a) throw new HttpError(404, 'الوكالة مش موجودة', 'not_found');
    const since = new Date(Date.now() - 30 * DAY);
    const [messages30d, posts30d, conversationsOpen, lastActivity, log] = await Promise.all([
      db.message.count({ where: { agencyId: a.id, createdAt: { gte: since } } }),
      db.postTarget.count({ where: { status: 'PUBLISHED', publishedAt: { gte: since }, post: { agencyId: a.id } } }),
      db.conversation.count({ where: { agencyId: a.id, status: { in: ['OPEN', 'PENDING'] } } }),
      db.auditLog.findFirst({ where: { agencyId: a.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      db.auditLog.findMany({ where: { agencyId: a.id, meta: { path: ['by'], equals: 'dosly' } }, orderBy: { createdAt: 'desc' }, take: 20 })
    ]);
    const { _count, ...agency } = a;
    return { ...agency, counts: { ..._count, messages30d, posts30d, conversationsOpen }, lastActivityAt: lastActivity?.createdAt ?? null, doslyLog: log, limits: PLANS[a.plan] };
  });

  app.post<{ Params: { id: string } }>('/agencies/:id/plan', async req => {
    const admin = requireAdmin(req, true);
    const input = z.object({ plan: z.enum(PLAN_TIERS), trialEndsAt: z.coerce.date().optional() }).parse(req.body);
    const a = await db.agency.update({ where: { id: req.params.id }, data: { plan: input.plan, ...(input.trialEndsAt ? { trialEndsAt: input.trialEndsAt } : {}) } });
    await agencyLog(a.id, 'dosly.plan_change', { admin: admin.name, plan: input.plan, trialEndsAt: input.trialEndsAt });
    return a;
  });

  // Until online payments exist, InstaPay or bank transfers are recorded here by hand.
  app.post<{ Params: { id: string } }>('/agencies/:id/payments', async (req, reply) => {
    const admin = requireAdmin(req, true);
    const input = z.object({ plan: z.enum(PLAN_TIERS).exclude(['TRIAL']), months: z.number().int().min(1).max(24), amountEgp: z.number().int().min(0), method: z.enum(['instapay', 'bank', 'vodafone_cash', 'cash', 'other']), reference: z.string().trim().max(200).optional() }).parse(req.body);
    const agency = await db.agency.findUnique({ where: { id: req.params.id } });
    if (!agency) throw new HttpError(404, 'الوكالة مش موجودة', 'not_found');
    const start = agency.paidUntil && agency.paidUntil > new Date() ? agency.paidUntil : new Date();
    const paidUntil = new Date(start); paidUntil.setMonth(paidUntil.getMonth() + input.months);
    const [payment] = await db.$transaction([
      db.payment.create({ data: { ...input, agencyId: agency.id, recordedById: admin.adminId } }),
      db.agency.update({ where: { id: agency.id }, data: { plan: input.plan, paidUntil, status: 'ACTIVE', suspendedReason: null } })
    ]);
    await agencyLog(agency.id, 'dosly.payment', { admin: admin.name, plan: input.plan, months: input.months, amountEgp: input.amountEgp });
    return reply.status(201).send({ payment, paidUntil });
  });

  app.post<{ Params: { id: string } }>('/agencies/:id/suspend', async req => {
    const admin = requireAdmin(req, true);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    await db.agency.update({ where: { id: req.params.id }, data: { status: 'SUSPENDED', suspendedReason: reason } });
    await agencyLog(req.params.id, 'dosly.suspend', { admin: admin.name, reason });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/agencies/:id/unsuspend', async req => {
    const admin = requireAdmin(req, true);
    await db.agency.update({ where: { id: req.params.id }, data: { status: 'ACTIVE', suspendedReason: null } });
    await agencyLog(req.params.id, 'dosly.unsuspend', { admin: admin.name });
    return { ok: true };
  });

  /**
   * Support sign-in: an hour-long, read-only session as the agency owner, so staff see exactly what
   * the agency sees. It cannot send messages or publish, and the agency's log records it with the reason.
   */
  app.post<{ Params: { id: string } }>('/agencies/:id/impersonate', async (req, reply) => {
    const admin = requireAdmin(req, true);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const owner = await db.membership.findFirst({ where: { agencyId: req.params.id, role: 'OWNER' }, orderBy: { createdAt: 'asc' } });
    if (!owner) throw new HttpError(404, 'الوكالة مالهاش صاحب', 'not_found');
    await agencyLog(req.params.id, 'dosly.support_login', { admin: admin.name, reason });
    await createSession(db, reply, owner.userId, req.params.id, secure, admin.adminId);
    return { ok: true };
  });

  app.get('/health', async req => {
    const admin = requireAdmin(req);
    const now = Date.now();
    const [pendingHooks, oldestHook, failedHooks24h, failedPosts7d, stuckPublishing] = await Promise.all([
      db.webhookEvent.count({ where: { processedAt: null } }),
      db.webhookEvent.findFirst({ where: { processedAt: null }, orderBy: { receivedAt: 'asc' }, select: { receivedAt: true } }),
      db.webhookEvent.findMany({ where: { error: { not: null }, receivedAt: { gte: new Date(now - DAY) } }, orderBy: { receivedAt: 'desc' }, take: 10, select: { id: true, receivedAt: true, error: true } }),
      db.postTarget.findMany({ where: { status: 'FAILED', post: { updatedAt: { gte: new Date(now - 7 * DAY) }, agency: scope(admin) } }, take: 10, orderBy: { post: { updatedAt: 'desc' } }, select: { error: true, socialAccount: { select: { platform: true, name: true } }, post: { select: { id: true, agency: { select: { id: true, name: true } } } } } }),
      db.post.count({ where: { status: 'PUBLISHING', updatedAt: { lt: new Date(now - 10 * 60_000) } } })
    ]);
    return { queues: (await queues.stats?.()) ?? null, pendingHooks, oldestHookAt: oldestHook?.receivedAt ?? null, failedHooks24h, failedPosts7d, stuckPublishing };
  });
};
