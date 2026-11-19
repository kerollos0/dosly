import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth.js';

export const auditRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;
  app.get('/audit', async req => {
    const auth = requirePermission(req, 'audit:view');
    const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const items = await db.auditLog.findMany({ where: { agencyId: auth.agencyId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
    const users = await db.user.findMany({ where: { id: { in: [...new Set(items.map(i => i.userId).filter(Boolean) as string[])] } }, select: { id: true, name: true } });
    const names = new Map(users.map(u => [u.id, u.name]));
    const page = items.slice(0, q.limit).map(i => ({ ...i, userName: i.userId ? names.get(i.userId) ?? null : null }));
    return { items: page, nextCursor: items.length > q.limit ? page.at(-1)!.id : null };
  });
};
