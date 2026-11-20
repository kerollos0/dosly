import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clientSchema } from '@dosly/shared';
import { clientReport, monthRange } from '@dosly/core';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';
import { createLoginLink } from '../portal-auth.js';

export const clientRoutes: FastifyPluginAsync = async app => {
  const { db, env } = app.deps;

  app.get('/clients', async req => {
    const auth = requireAuth(req);
    const visible = await visibleClientIds(db, auth);
    const clients = await db.client.findMany({
      where: { agencyId: auth.agencyId, archivedAt: null, ...(visible === 'all' ? {} : { id: { in: visible } }) },
      orderBy: { name: 'asc' },
      include: {
        assignments: { select: { userId: true } },
        waNumbers: { select: { id: true, displayPhone: true, status: true } },
        socialAccounts: { select: { id: true, platform: true, name: true, status: true } },
        _count: { select: { conversations: { where: { unreadCount: { gt: 0 } } } } }
      }
    });
    return clients.map(({ assignments, _count, ...c }) => ({ ...c, assigneeIds: assignments.map(a => a.userId), unreadConversations: _count.conversations }));
  });

  app.post('/clients', async (req, reply) => {
    const auth = requirePermission(req, 'clients:manage');
    const input = clientSchema.parse(req.body);
    const client = await db.client.create({ data: { ...input, agencyId: auth.agencyId } });
    await audit(db, auth, 'client.create', 'Client', client.id, { name: client.name });
    return reply.status(201).send(client);
  });

  app.patch<{ Params: { id: string } }>('/clients/:id', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    const input = clientSchema.partial().parse(req.body);
    return db.client.update({ where: { id: req.params.id }, data: input });
  });

  app.post<{ Params: { id: string } }>('/clients/:id/archive', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    await db.client.update({ where: { id: req.params.id }, data: { archivedAt: new Date() } });
    await audit(db, auth, 'client.archive', 'Client', req.params.id);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/clients/:id/assignments', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    const { userIds } = z.object({ userIds: z.array(z.string()).max(50) }).parse(req.body);
    const members = await db.membership.count({ where: { agencyId: auth.agencyId, userId: { in: userIds } } });
    if (members !== new Set(userIds).size) throw new HttpError(400, 'فيه عضو مش تابع للوكالة', 'bad_member');
    await db.$transaction([
      db.clientAssignment.deleteMany({ where: { clientId: req.params.id } }),
      db.clientAssignment.createMany({ data: [...new Set(userIds)].map(userId => ({ clientId: req.params.id, userId })) })
    ]);
    await audit(db, auth, 'client.assign', 'Client', req.params.id, { userIds });
    return { ok: true };
  });

  // ---- Client portal: who on the client side can sign in, and whether posts need their OK ----

  app.get<{ Params: { id: string } }>('/clients/:id/portal', async req => {
    const auth = requireAuth(req);
    const client = await assertClientAccess(db, auth, req.params.id);
    const users = await db.clientUser.findMany({ where: { clientId: client.id }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, lastLoginAt: true, createdAt: true } });
    return { requiresClientApproval: client.requiresClientApproval, users };
  });

  app.put<{ Params: { id: string } }>('/clients/:id/portal/settings', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    const { requiresClientApproval } = z.object({ requiresClientApproval: z.boolean() }).parse(req.body);
    await db.client.update({ where: { id: req.params.id }, data: { requiresClientApproval } });
    await audit(db, auth, 'client.portal_settings', 'Client', req.params.id, { requiresClientApproval });
    return { requiresClientApproval };
  });

  // There is no email sending yet, so the agency copies the sign-in link and sends it itself.
  app.post<{ Params: { id: string } }>('/clients/:id/portal/users', async (req, reply) => {
    const auth = requirePermission(req, 'clients:manage');
    const client = await assertClientAccess(db, auth, req.params.id);
    const input = z.object({ name: z.string().trim().min(2).max(80), email: z.email().trim().toLowerCase() }).parse(req.body);
    const user = await db.clientUser.upsert({
      where: { clientId_email: { clientId: client.id, email: input.email } },
      create: { ...input, clientId: client.id, agencyId: auth.agencyId },
      update: { name: input.name }
    });
    const link = await createLoginLink(db, user.id, env.PUBLIC_URL);
    await audit(db, auth, 'client.portal_invite', 'ClientUser', user.id, { email: user.email });
    return reply.status(201).send({ user: { id: user.id, name: user.name, email: user.email }, link });
  });

  app.post<{ Params: { id: string; uid: string } }>('/clients/:id/portal/users/:uid/link', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    const user = await db.clientUser.findFirst({ where: { id: req.params.uid, clientId: req.params.id } });
    if (!user) throw new HttpError(404, 'الشخص ده مش موجود', 'not_found');
    return { link: await createLoginLink(db, user.id, env.PUBLIC_URL) };
  });

  app.delete<{ Params: { id: string; uid: string } }>('/clients/:id/portal/users/:uid', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await assertClientAccess(db, auth, req.params.id);
    const res = await db.clientUser.deleteMany({ where: { id: req.params.uid, clientId: req.params.id } }); // sessions and links cascade
    if (!res.count) throw new HttpError(404, 'الشخص ده مش موجود', 'not_found');
    await audit(db, auth, 'client.portal_remove', 'ClientUser', req.params.uid);
    return { ok: true };
  });

  /** The same report the client sees in the portal, so the agency can check it first. */
  app.get<{ Params: { id: string } }>('/clients/:id/report', async req => {
    const auth = requireAuth(req);
    await assertClientAccess(db, auth, req.params.id);
    const now = new Date();
    const q = z.object({ year: z.coerce.number().int().min(2024).max(2100).default(now.getFullYear()), month: z.coerce.number().int().min(1).max(12).default(now.getMonth() + 1) }).parse(req.query);
    const [from, to] = monthRange(q.year, q.month);
    return clientReport(db, req.params.id, from, to);
  });
};
