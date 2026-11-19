import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import { createDb } from '@dosly/db';
import { loadKey } from '@dosly/shared';
import { overduePosts, processWhatsAppWebhook, publishPost, type Publisher } from '@dosly/core';

const env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8)
}).parse(process.env);

const log = pino({ level: 'info' });
const db = createDb(env.DATABASE_URL);
const key = loadKey(env.ENCRYPTION_KEY);
const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
const redis = new Redis(env.REDIS_URL);
const pub: Publisher = { publish: (agencyId, event) => { void redis.publish('dosly:events', JSON.stringify({ agencyId, event })); } };

const webhooks = new Worker('webhooks', async job => {
  const event = await db.webhookEvent.findUnique({ where: { id: job.data.eventId } });
  if (!event || event.processedAt) return;
  try {
    const res = await processWhatsAppWebhook(db, event.payload, pub);
    if (res.unknownNumbers.length) log.warn({ numbers: res.unknownNumbers }, 'Webhook for numbers not connected to any agency');
    await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
  } catch (err) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { error: String((err as Error).message).slice(0, 1000) } });
    throw err; // BullMQ retries with backoff
  }
}, { connection, concurrency: env.WORKER_CONCURRENCY });

const posts = new Worker('posts', async job => {
  if (job.name === 'sweep') {
    // Safety net: catches posts whose delayed job was lost (e.g. Redis restarted without persistence).
    const due = await overduePosts(db);
    const q = new Queue('posts', { connection });
    for (const p of due) await q.add('publish', { postId: p.id }, { jobId: `post-${p.id}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
    await q.close();
    return { requeued: due.length };
  }
  const status = await publishPost(db, job.data.postId, key, pub);
  log.info({ postId: job.data.postId, status }, 'Post processed');
  return { status };
}, { connection, concurrency: 4 });

const sweeper = new Queue('posts', { connection });
await sweeper.upsertJobScheduler('overdue-sweep', { every: 60_000 }, { name: 'sweep' });

for (const w of [webhooks, posts]) {
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'Job failed'));
}
log.info('Dosly worker started');

const shutdown = async () => {
  await Promise.all([webhooks.close(), posts.close(), sweeper.close()]);
  redis.disconnect();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
