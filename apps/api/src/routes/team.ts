import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { inviteSchema, PLANS, randomToken, ROLES, sha256 } from '@dosly/shared';
import { audit, HttpError, requireAuth, requirePermission } from '../auth.js';

export const teamRoutes: FastifyPluginAsync = async app => {
  const { db, env } = app.deps;

  app.get('/team', async req => {
    const auth = requireAuth(req);
    const members = await db.membership.findMany({ where: { agencyId: auth.agencyId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
    const invites = await db.invite.findMany({ where: { agencyId: auth.agencyId, acceptedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true } });
    return { members: members.map(m => ({ ...m.user, role: m.role })), invites };
  });

  app.post('/team/invites', async (req, reply) => {
    const auth = requirePermission(req, 'team:manage');
    const input = inviteSchema.parse(req.body);
    const agency = await db.agency.findUniqueOrThrow({ where: { id: auth.agencyId } });
    const limit = PLANS[agency.plan].members;
    if (limit !== null) {
      const [members, pending] = await Promise.all([
        db.membership.count({ where: { agencyId: auth.agencyId } }),
        db.invite.count({ where: { agencyId: auth.agencyId, acceptedAt: null, expiresAt: { gt: new Date() } } })
      ]);
      if (members + pending >= limit) throw new HttpError(402, `باقتك فيها ${limit} أعضاء بس، ومعاهم الدعوات اللي لسه متقبلتش.`, 'plan_limit');
    }
    const token = randomToken();
    const invite = await db.invite.create({ data: { agencyId: auth.agencyId, email: input.email, role: input.role, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    await audit(db, auth, 'team.invite', 'Invite', invite.id, { email: input.email, role: input.role });
    // No email is sent: the manager shares this link through WhatsApp or any channel.
    return reply.status(201).send({ id: invite.id, link: `${env.PUBLIC_URL}/invite/${token}` });
  });

  app.delete<{ Params: { id: string } }>('/team/invites/:id', async req => {
    const auth = requirePermission(req, 'team:manage');
    await db.invite.deleteMany({ where: { id: req.params.id, agencyId: auth.agencyId } });
    return { ok: true };
  });

  app.patch<{ Params: { userId: string } }>('/team/:userId', async req => {
    const auth = requirePermission(req, 'team:manage');
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    const target = await db.membership.findUnique({ where: { agencyId_userId: { agencyId: auth.agencyId, userId: req.params.userId } } });
    if (!target) throw new HttpError(404, 'العضو مش موجود', 'not_found');
    if ((role === 'OWNER' || target.role === 'OWNER') && auth.role !== 'OWNER') throw new HttpError(403, 'صاحب الوكالة بس اللي يقدر يغيّر ده', 'forbidden');
    if (target.role === 'OWNER' && role !== 'OWNER' && (await db.membership.count({ where: { agencyId: auth.agencyId, role: 'OWNER' } })) === 1) throw new HttpError(400, 'لازم يفضل صاحب وكالة واحد على الأقل', 'last_owner');
    await db.membership.update({ where: { id: target.id }, data: { role } });
    await audit(db, auth, 'team.role', 'User', req.params.userId, { role });
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>('/team/:userId', async req => {
    const auth = requirePermission(req, 'team:manage');
    const target = await db.membership.findUnique({ where: { agencyId_userId: { agencyId: auth.agencyId, userId: req.params.userId } } });
    if (!target) throw new HttpError(404, 'العضو مش موجود', 'not_found');
    if (target.role === 'OWNER') throw new HttpError(400, 'مينفعش تشيل صاحب الوكالة', 'owner');
    await db.$transaction([
      db.membership.delete({ where: { id: target.id } }),
      db.clientAssignment.deleteMany({ where: { userId: target.userId, client: { agencyId: auth.agencyId } } }),
      db.session.deleteMany({ where: { userId: target.userId, agencyId: auth.agencyId } })
    ]);
    await audit(db, auth, 'team.remove', 'User', target.userId);
    return { ok: true };
  });
};
