import type { FastifyPluginAsync } from 'fastify';
import { verifyMetaSignature } from '@dosly/shared';

/**
 * Meta webhooks. The handler only verifies, stores and enqueues, then answers 200 at once;
 * a worker does the processing so traffic spikes queue up instead of timing out.
 */
export const webhookRoutes: FastifyPluginAsync = async app => {
  const { db, env, queues } = app.deps;

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/webhooks/meta', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (env.META_VERIFY_TOKEN && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.META_VERIFY_TOKEN) return reply.type('text/plain').send(q['hub.challenge']);
    return reply.status(403).send('forbidden');
  });

  app.post('/webhooks/meta', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const raw = req.body as Buffer;
    if (!env.META_APP_SECRET || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, env.META_APP_SECRET)) {
      req.log.warn('Rejected webhook with a bad signature');
      return reply.status(401).send('bad signature');
    }
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return reply.status(400).send('bad json'); }
    const event = await db.webhookEvent.create({ data: { source: 'meta', payload: payload as object } });
    await queues.enqueueWebhook(event.id);
    return reply.status(200).send('ok');
  });
};
