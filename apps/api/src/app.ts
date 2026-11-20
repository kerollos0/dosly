import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Db } from '@dosly/db';
import type { Publisher } from '@dosly/core';
import { HttpError, resolveSession, SESSION_COOKIE, type ReadOnlyReason } from './auth.js';
import type { Env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { teamRoutes } from './routes/team.js';
import { clientRoutes } from './routes/clients.js';
import { channelRoutes } from './routes/channels.js';
import { inboxRoutes } from './routes/inbox.js';
import { postRoutes } from './routes/posts.js';
import { webhookRoutes } from './routes/webhooks.js';
import { auditRoutes } from './routes/audit.js';
import { demoRoutes } from './routes/demo.js';
import { portalRoutes } from './routes/portal.js';
import { adminRoutes } from './routes/admin.js';

export interface Queues {
  enqueueWebhook(eventId: string): Promise<void>;
  schedulePost(postId: string, at: Date): Promise<void>;
  cancelPost(postId: string): Promise<void>;
  /** Job counts per queue, for the admin health page. */
  stats?(): Promise<Record<string, Record<string, number>>>;
  /** Demo mode only: queue the fake phone's delivered/read receipts and maybe a customer reply. */
  demoAfterSend?(messageId: string): Promise<void>;
}

const READ_ONLY_MESSAGE: Record<ReadOnlyReason, string> = {
  support: 'ده دخول دعم فني من دوسلي، للعرض بس',
  suspended: 'الحساب موقوف مؤقتًا. كلّم دوسلي عشان نرجّعه.',
  trial_ended: 'التجربة المجانية خلصت. اشترك عشان تكمل ترد وتنشر، وكل بياناتك محفوظة.',
  unpaid: 'الاشتراك خلص. جدّده عشان تكمل ترد وتنشر، وكل بياناتك محفوظة.'
};

/** Writes a read-only session may still make: signing out, clearing unread badges, and demo tools. */
const readOnlyAllowed = (path: string) =>
  path === '/api/auth/logout' || /^\/api\/conversations\/[^/]+\/read$/.test(path) || /^\/api\/(portal|admin|demo)\//.test(path);

export interface Deps {
  db: Db;
  env: Env;
  key: Buffer;
  queues: Queues;
  realtime: Publisher;
  fetch?: typeof fetch; // injectable for tests; defaults to global fetch
}

declare module 'fastify' {
  interface FastifyInstance { deps: Deps }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.env.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024
  });
  app.decorate('deps', deps);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', async req => {
    const auth = await resolveSession(deps.db, req.cookies[SESSION_COOKIE]);
    if (auth) req.auth = auth;
    // Suspended agencies and support sessions are read-only across the whole agency API.
    const path = req.url.split('?')[0]!;
    if (auth?.readOnly && req.method !== 'GET' && !readOnlyAllowed(path)) {
      throw new HttpError(403, READ_ONLY_MESSAGE[auth.readOnly], auth.readOnly);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation', message: 'البيانات مش مظبوطة', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: status === 429 ? 'rate_limited' : 'server_error', message: status === 429 ? 'محاولات كتير. استنى دقيقة وجرّب تاني.' : 'حصلت مشكلة. جرّب تاني.' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(webhookRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(teamRoutes, { prefix: '/api' });
  await app.register(clientRoutes, { prefix: '/api' });
  await app.register(channelRoutes, { prefix: '/api' });
  await app.register(inboxRoutes, { prefix: '/api' });
  await app.register(postRoutes, { prefix: '/api' });
  await app.register(auditRoutes, { prefix: '/api' });
  await app.register(portalRoutes, { prefix: '/api/portal' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  if (deps.env.DEMO_MODE === 'true') await app.register(demoRoutes, { prefix: '/api' });
  return app;
}
