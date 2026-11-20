import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@dosly/shared';
import { seedDemoAgency, simulateInbound } from '@dosly/core';
import { audit, createSession, HttpError, requireAuth, SESSION_COOKIE } from '../auth.js';

/** Registered only when DEMO_MODE=true. Lets anyone open a private sandbox agency with one click. */
export const demoRoutes: FastifyPluginAsync = async app => {
  const { db, key, env, realtime } = app.deps;
  const secure = env.PUBLIC_URL.startsWith('https://');
  const roleSchema = z.object({ role: z.enum(ROLES).default('OWNER') });

  const sandboxOf = async (req: FastifyRequest) => {
    const auth = requireAuth(req);
    const agency = await db.agency.findUniqueOrThrow({ where: { id: auth.agencyId } });
    if (!agency.demoExpiresAt) throw new HttpError(403, 'الأداة دي للديمو بس', 'not_demo');
    return { auth, agency };
  };

  const signInAs = async (req: FastifyRequest, reply: Parameters<typeof createSession>[1], agencyId: string, role: (typeof ROLES)[number]) => {
    const m = await db.membership.findFirst({ where: { agencyId, role }, orderBy: { createdAt: 'asc' } });
    if (!m) throw new HttpError(404, 'مفيش حد بالدور ده في الديمو', 'not_found');
    if (req.auth) await db.session.delete({ where: { id: req.auth.sessionId } }).catch(() => {});
    await createSession(db, reply, m.userId, agencyId, secure);
  };

  app.get('/demo/info', async () => ({ demo: true, roles: ROLES }));

  // Seeding costs a few hundred rows, so it is rate limited harder than login.
  app.post('/demo/start', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { role } = roleSchema.parse(req.body ?? {});
    let agencyId: string | undefined;
    if (req.auth) {
      const current = await db.agency.findUnique({ where: { id: req.auth.agencyId } });
      if (current?.demoExpiresAt && current.demoExpiresAt > new Date()) agencyId = current.id; // keep the visitor's own sandbox
    }
    agencyId ??= (await seedDemoAgency(db, key)).agencyId;
    await signInAs(req, reply, agencyId, role);
    return { ok: true };
  });

  app.post('/demo/switch', async (req, reply) => {
    const { agency } = await sandboxOf(req);
    const { role } = roleSchema.parse(req.body ?? {});
    await signInAs(req, reply, agency.id, role);
    return { ok: true };
  });

  app.post('/demo/inbound', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { auth } = await sandboxOf(req);
    const { clientId } = z.object({ clientId: z.string().optional() }).parse(req.body ?? {});
    await simulateInbound(db, realtime, { agencyId: auth.agencyId, clientId });
    return { ok: true };
  });

  app.post('/demo/end', async (req, reply) => {
    const { auth, agency } = await sandboxOf(req);
    await audit(db, auth, 'demo.end', 'Agency', agency.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await db.agency.update({ where: { id: agency.id }, data: { demoExpiresAt: new Date() } }); // the worker sweeps it
    return { ok: true };
  });
};
