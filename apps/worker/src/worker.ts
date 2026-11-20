import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import { createDb } from '@dosly/db';
import { demoFetch, loadKey, publishFacebookPost, publishInstagramPost } from '@dosly/shared';
import { DEMO_TTL_HOURS, deleteExpiredDemos, overduePosts, processWhatsAppWebhook, publishPost, simulateInbound, simulateReply, simulateStatus, type Publishers, type Publisher } from '@dosly/core';

const env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  DEMO_AMBIENT_SECONDS: z.coerce.number().int().min(0).default(120) // 0 turns off the background customers
}).parse(process.env);
const demo = env.DEMO_MODE === 'true';
// In demo mode nothing reaches Meta: publishing goes to the simulated Graph API.
const publishers: Publishers | undefined = demo
  ? { facebook: o => publishFacebookPost(o, demoFetch), instagram: o => publishInstagramPost({ ...o, pollMs: 0 }, demoFetch) }
  : undefined;

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
  const status = await publishPost(db, job.data.postId, key, pub, publishers);
  log.info({ postId: job.data.postId, status }, 'Post processed');
  return { status };
}, { connection, concurrency: 4 });

const sweeper = new Queue('posts', { connection });
await sweeper.upsertJobScheduler('overdue-sweep', { every: 60_000 }, { name: 'sweep' });

const workers = [webhooks, posts];
const queues = [sweeper];
if (demo) {
  const demoQueue = new Queue('demo', { connection });
  queues.push(demoQueue);
  await demoQueue.upsertJobScheduler('demo-cleanup', { every: 10 * 60_000 }, { name: 'cleanup' });
  if (env.DEMO_AMBIENT_SECONDS > 0) await demoQueue.upsertJobScheduler('demo-ambient', { every: env.DEMO_AMBIENT_SECONDS * 1000 }, { name: 'ambient' });
  else await demoQueue.removeJobScheduler('demo-ambient');
  workers.push(new Worker('demo', async job => {
    switch (job.name) {
      case 'status': return simulateStatus(db, pub, job.data.messageId, job.data.status);
      case 'reply': return simulateReply(db, pub, job.data.messageId);
      case 'cleanup': return { deleted: await deleteExpiredDemos(db) };
      case 'ambient': {
        // Sandboxes opened in the last two hours get an occasional new customer, so the inbox feels alive.
        const openedRecently = new Date(Date.now() + (DEMO_TTL_HOURS - 2) * 3600_000); // expiry is set to opening time + TTL
        const active = await db.agency.findMany({ where: { demoExpiresAt: { gt: openedRecently } }, select: { id: true }, take: 50 });
        for (const a of active) if (Math.random() < 0.5) await simulateInbound(db, pub, { agencyId: a.id });
        return { agencies: active.length };
      }
    }
  }, { connection, concurrency: 4 }));
  log.warn('DEMO MODE: Meta is simulated and nothing is sent to real customers');
}

for (const w of workers) {
  w.on('failed', (job, err) => log.error({ queue: w.name, jobId: job?.id, err: err.message }, 'Job failed'));
}
log.info('Dosly worker started');

const shutdown = async () => {
  await Promise.all([...workers.map(w => w.close()), ...queues.map(q => q.close())]);
  redis.disconnect();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
