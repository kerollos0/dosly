import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clientSchema } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';

export const clientRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;

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
};
