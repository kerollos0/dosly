import type { FastifyPluginAsync } from 'fastify';
import { acceptInviteSchema, hashPassword, loginSchema, sha256, signupSchema, verifyPassword } from '@dosly/shared';
import { createSession, HttpError, requireAuth, SESSION_COOKIE } from '../auth.js';

const slugify = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agency') + '-' + Math.random().toString(36).slice(2, 7);

export const authRoutes: FastifyPluginAsync = async app => {
  const { db, env } = app.deps;
  const secure = env.PUBLIC_URL.startsWith('https://');
  const limit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/signup', limit, async (req, reply) => {
    if (env.ALLOW_SIGNUP !== 'true') throw new HttpError(403, 'التسجيل مقفول حاليًا', 'signup_closed');
    const input = signupSchema.parse(req.body);
    if (await db.user.findUnique({ where: { email: input.email } })) throw new HttpError(409, 'الإيميل ده مسجل قبل كده', 'email_taken');
    const passwordHash = await hashPassword(input.password);
    const { user, agency } = await db.$transaction(async tx => {
      const agency = await tx.agency.create({ data: { name: input.agencyName, slug: slugify(input.agencyName) } });
      const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash } });
      await tx.membership.create({ data: { agencyId: agency.id, userId: user.id, role: 'OWNER' } });
      return { user, agency };
    });
    await createSession(db, reply, user.id, agency.id, secure);
    return reply.status(201).send({ user: { id: user.id, name: user.name, email: user.email }, agency });
  });

  app.post('/auth/login', limit, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const user = await db.user.findUnique({ where: { email: input.email }, include: { memberships: { orderBy: { createdAt: 'asc' } } } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) throw new HttpError(401, 'الإيميل أو الباسورد غلط', 'invalid_credentials');
    const membership = user.memberships[0];
    if (!membership) throw new HttpError(403, 'الحساب ده مش تابع لأي وكالة', 'no_agency');
    await createSession(db, reply, user.id, membership.agencyId, secure);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await db.session.delete({ where: { id: req.auth.sessionId } }).catch(() => {});
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async req => {
    const auth = requireAuth(req);
    const user = await db.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, name: true, email: true } });
    const agency = await db.agency.findUniqueOrThrow({ where: { id: auth.agencyId }, select: { id: true, name: true, slug: true, demoExpiresAt: true } });
    return { user, agency, role: auth.role, demo: agency.demoExpiresAt !== null };
  });

  app.post('/invites/accept', limit, async (req, reply) => {
    const input = acceptInviteSchema.parse(req.body);
    const invite = await db.invite.findUnique({ where: { tokenHash: sha256(input.token) } });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw new HttpError(410, 'الدعوة دي انتهت أو اتستخدمت', 'invite_invalid');
    const existing = await db.user.findUnique({ where: { email: invite.email } });
    if (existing && !(await verifyPassword(input.password, existing.passwordHash))) throw new HttpError(401, 'الإيميل ده عنده حساب. اكتب الباسورد بتاعه.', 'invalid_credentials');
    const passwordHash = existing ? existing.passwordHash : await hashPassword(input.password);
    const user = await db.$transaction(async tx => {
      const user = existing ?? (await tx.user.create({ data: { email: invite.email, name: input.name, passwordHash } }));
      await tx.membership.upsert({ where: { agencyId_userId: { agencyId: invite.agencyId, userId: user.id } }, create: { agencyId: invite.agencyId, userId: user.id, role: invite.role }, update: {} });
      await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      return user;
    });
    await createSession(db, reply, user.id, invite.agencyId, secure);
    return { ok: true };
  });
};
