import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { z } from 'zod';
import { createDb, Prisma } from '@dosly/db';
import { demoFetch, loadKey, publishFacebookPost, publishInstagramPost } from '@dosly/shared';
import { DEMO_TTL_HOURS, deleteExpiredDemos, fetchInboundMedia, localMediaStore, markMediaFailed, markSendFailed, overduePosts, pendingInboundMedia, PermanentMediaError, processMetaWebhook, publishPost, sendQueuedMessage, simulateComment, simulateInbound, simulateSocialMessage, simulateReply, simulateStatus, syncTemplates, type MediaDeps, type Publishers, type Publisher } from '@dosly/core';
import type { Job } from 'bullmq';

const env = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  PRIVATE_MEDIA_DIR: z.string().default('./private-media'),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4), // ffmpeg and image work are CPU heavy
  META_APP_ID: z.string().optional(), // echoes of messages Dosly sent are skipped by this app id
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

const store = localMediaStore(env.PRIVATE_MEDIA_DIR);
const demoQueue = demo ? new Queue('demo', { connection }) : null;
const graphFetch = demo ? demoFetch : fetch;
const mediaDeps: MediaDeps = { db, store, key, pub, fetch: graphFetch, log };
const mediaQueue = new Queue('media', { connection });
const jobOpts = (attempts: number, delay: number) => ({ attempts, backoff: { type: 'exponential' as const, delay }, removeOnComplete: 1000, removeOnFail: 5000 });
const fetchMediaLater = async (messageId: string) => { await mediaQueue.add('fetch', { messageId }, { jobId: `fetch-${messageId}`, ...jobOpts(6, 5000) }); };
// key + fetch: names of new Messenger/Instagram customers; store: removing attachments a customer unsent.
const hooks = { onMedia: fetchMediaLater, key, fetch: graphFetch, store, appId: env.META_APP_ID };

const webhooks = new Worker('webhooks', async job => {
  const event = await db.webhookEvent.findUnique({ where: { id: job.data.eventId } });
  if (!event || event.processedAt) return;
  try {
    const res = await processMetaWebhook(db, event.payload, pub, hooks);
    if (res.unknown.length) log.warn({ ids: res.unknown }, 'Webhook for numbers or pages not connected to any agency');
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

/** Runs a media job; on a permanent error, or the last retry, records the failure on the message. */
async function withFailure(job: Job, run: () => Promise<unknown>, fail: (msg: string) => Promise<void>) {
  try { return await run(); }
  catch (err) {
    const last = err instanceof PermanentMediaError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (last) { await fail((err as Error).message); if (err instanceof PermanentMediaError) return { failed: (err as Error).message }; }
    throw err;
  }
}

const media = new Worker('media', async job => {
  switch (job.name) {
    case 'fetch': return withFailure(job, () => fetchInboundMedia(mediaDeps, job.data.messageId), e => markMediaFailed(db, pub, job.data.messageId, e));
    case 'send': return withFailure(job, async () => {
      const r = await sendQueuedMessage(mediaDeps, job.data.messageId);
      if (r === 'sent' && demoQueue) {
        const o = { removeOnComplete: 100, removeOnFail: 100 };
        await demoQueue.add('status', { messageId: job.data.messageId, status: 'delivered' }, { ...o, delay: 1500 });
        await demoQueue.add('status', { messageId: job.data.messageId, status: 'read' }, { ...o, delay: 4000 });
        if (Math.random() < 0.5) await demoQueue.add('reply', { messageId: job.data.messageId }, { ...o, delay: 9000 + Math.random() * 8000 });
      }
      return r;
    }, e => markSendFailed(db, pub, job.data.messageId, e));
    case 'templates': return { templates: await syncTemplates(db, key, job.data.waNumberId, pub, graphFetch) };
    case 'sweep': {
      // Safety net for lost jobs: downloads still pending, and sends still queued after a few minutes.
      for (const m of await pendingInboundMedia(db)) await fetchMediaLater(m.id);
      const stuck = await db.message.findMany({ where: { direction: 'OUT', status: 'QUEUED', payload: { not: Prisma.DbNull }, createdAt: { lt: new Date(Date.now() - 5 * 60_000), gt: new Date(Date.now() - 24 * 3600_000) } }, select: { id: true }, take: 200 });
      for (const m of stuck) await mediaQueue.add('send', { messageId: m.id }, { jobId: `send-${m.id}`, ...jobOpts(4, 3000) });
      return { stuck: stuck.length };
    }
  }
}, { connection, concurrency: env.MEDIA_CONCURRENCY });
await mediaQueue.upsertJobScheduler('media-sweep', { every: 60_000 }, { name: 'sweep' });

const workers = [webhooks, posts, media];
const queues = [sweeper, mediaQueue];
if (demoQueue) {
  queues.push(demoQueue);
  await demoQueue.upsertJobScheduler('demo-cleanup', { every: 10 * 60_000 }, { name: 'cleanup' });
  if (env.DEMO_AMBIENT_SECONDS > 0) await demoQueue.upsertJobScheduler('demo-ambient', { every: env.DEMO_AMBIENT_SECONDS * 1000 }, { name: 'ambient' });
  else await demoQueue.removeJobScheduler('demo-ambient');
  workers.push(new Worker('demo', async job => {
    switch (job.name) {
      case 'status': return simulateStatus(db, pub, job.data.messageId, job.data.status);
      case 'reply': return simulateReply(db, pub, job.data.messageId, hooks);
      case 'cleanup': return { deleted: await deleteExpiredDemos(db, new Date(), store) };
      case 'ambient': {
        // Sandboxes opened in the last two hours get an occasional new customer, so the inbox feels alive.
        const openedRecently = new Date(Date.now() + (DEMO_TTL_HOURS - 2) * 3600_000); // expiry is set to opening time + TTL
        const active = await db.agency.findMany({ where: { demoExpiresAt: { gt: openedRecently } }, select: { id: true }, take: 50 });
        for (const a of active) {
          const r = Math.random();
          // WhatsApp stays the busiest channel; comments come next, then Messenger and Instagram messages.
          if (r < 0.35) await simulateInbound(db, pub, { agencyId: a.id, media: 'random' }, hooks);
          else if (r < 0.6) await simulateComment(db, pub, { agencyId: a.id });
          else if (r < 0.72) await simulateSocialMessage(db, pub, { agencyId: a.id, media: Math.random() < 0.2 ? 'photo' : undefined }, hooks);
        }
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
