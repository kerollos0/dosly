import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@dosly/db';
import { decrypt, verifyEasyOrdersSecret, verifyMetaSignature, verifyShopifyHmac } from '@dosly/shared';

/**
 * Meta webhooks. The handler only verifies, stores and enqueues, then answers 200 at once;
 * a worker does the processing so traffic spikes queue up instead of timing out.
 */
export const webhookRoutes: FastifyPluginAsync = async app => {
  const { db, env, queues, key } = app.deps;

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

  /**
   * Online store orders. The URL's hookId says which store; the store proves itself with its secret:
   * EasyOrders sends it as-is in a `secret` header, Shopify signs the raw body (X-Shopify-Hmac-SHA256).
   */
  app.post<{ Params: { hookId: string } }>('/webhooks/store/:hookId', { bodyLimit: 2 * 1024 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const store = await db.storeConnection.findUnique({ where: { hookId: req.params.hookId }, select: { id: true, kind: true, secretEnc: true, lastError: true } });
    if (!store) return reply.status(404).send('unknown store');
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !raw.length) return reply.status(400).send('empty body');
    const h = (name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
    const secret = store.secretEnc ? decrypt(store.secretEnc, key) : '';
    const ok = store.kind === 'SHOPIFY' ? verifyShopifyHmac(raw, h('x-shopify-hmac-sha256'), secret) : verifyEasyOrdersSecret(h('secret'), secret);
    if (!ok) {
      req.log.warn({ storeId: store.id }, 'Rejected store webhook with a bad secret');
      // Note it for the owner once, not on every hit: anyone can call this URL.
      const lastError = secret ? 'وصل طلب من المتجر بسر (secret) غلط. اتأكد إنك نسخته صح.' : 'لسه ما حطيتش السر (secret) اللي المتجر اداهولك';
      if (store.lastError !== lastError) await db.storeConnection.update({ where: { id: store.id }, data: { lastError } });
      return reply.status(401).send('bad secret');
    }
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.status(400).send('bad json'); }
    const deliveryId = h('x-shopify-webhook-id');
    try {
      const event = await db.webhookEvent.create({ data: {
        source: 'store', dedupeKey: deliveryId ? `shopify:${store.id}:${deliveryId}`.slice(0, 200) : null,
        payload: { storeId: store.id, topic: h('x-shopify-topic') ?? null, body } as Prisma.InputJsonValue
      } });
      await queues.enqueueWebhook(event.id);
    } catch (e) {
      // The same delivery again (Shopify retries): already stored, so just say thanks, and queue it
      // again if the first try never got queued (the queue drops a second copy of a waiting job).
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const prev = await db.webhookEvent.findUnique({ where: { dedupeKey: `shopify:${store.id}:${deliveryId}`.slice(0, 200) }, select: { id: true, processedAt: true } });
      if (prev && !prev.processedAt) await queues.enqueueWebhook(prev.id);
    }
    return reply.status(200).send('ok');
  });
};
