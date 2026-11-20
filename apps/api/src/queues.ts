import { Queue } from 'bullmq';
import type { Queues } from './app.js';

export const QUEUE_WEBHOOKS = 'webhooks';
export const QUEUE_POSTS = 'posts';
export const QUEUE_DEMO = 'demo';
export const QUEUE_MEDIA = 'media';
export const QUEUE_ADS = 'ads';

/** BullMQ producers. Job ids are deterministic so re-scheduling a post replaces its old job. */
export function bullQueues(connection: { url: string }, demo = false): Queues & { close(): Promise<void> } {
  const opts = { connection: { url: connection.url, maxRetriesPerRequest: null } };
  const webhooks = new Queue(QUEUE_WEBHOOKS, opts);
  const posts = new Queue(QUEUE_POSTS, opts);
  const media = new Queue(QUEUE_MEDIA, opts);
  const ads = new Queue(QUEUE_ADS, opts);
  const demoQ = demo ? new Queue(QUEUE_DEMO, opts) : null;
  const postJobId = (id: string) => `post-${id}`;
  /** Adds a job unless the same one is waiting or running. A finished or failed one is replaced, so a manual retry works. */
  const addOnce = async (q: Queue, name: string, data: object, jobId: string, attempts: number, delay: number) => {
    const old = await q.getJob(jobId);
    if (old) {
      const state = await old.getState();
      if (state !== 'completed' && state !== 'failed') return;
      await old.remove().catch(() => {});
    }
    await q.add(name, data, { jobId, attempts, backoff: { type: 'exponential', delay }, removeOnComplete: 1000, removeOnFail: 5000 });
  };
  return {
    ...(demoQ && {
      async demoAfterSend(messageId: string) {
        const o = { removeOnComplete: 100, removeOnFail: 100 };
        await demoQ.add('status', { messageId, status: 'delivered' }, { ...o, delay: 1500 });
        await demoQ.add('status', { messageId, status: 'read' }, { ...o, delay: 4000 });
        // Real customers do not always answer, so the fake one answers about two times in three.
        if (Math.random() < 0.66) await demoQ.add('reply', { messageId }, { ...o, delay: 9000 + Math.random() * 8000 });
      }
    }),
    // Deterministic job ids: a double click or a retried request never queues the same work twice.
    async fetchMedia(messageId) {
      await addOnce(media, 'fetch', { messageId }, `fetch-${messageId}`, 6, 5000);
    },
    async sendMessage(messageId) {
      await addOnce(media, 'send', { messageId }, `send-${messageId}`, 4, 3000);
    },
    async syncTemplates(waNumberId) {
      await addOnce(media, 'templates', { waNumberId }, `tpl-${waNumberId}`, 3, 10_000);
    },
    async syncAds(adAccountId) {
      await addOnce(ads, 'sync', { adAccountId, force: true }, `ads-${adAccountId}`, 3, 30_000);
    },
    async enqueueWebhook(eventId) {
      await webhooks.add('meta', { eventId }, { jobId: `wh-${eventId}`, attempts: 8, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 });
    },
    async schedulePost(postId, at) {
      await posts.remove(postJobId(postId)).catch(() => {});
      await posts.add('publish', { postId }, { jobId: postJobId(postId), delay: Math.max(0, at.getTime() - Date.now()), attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
    },
    async cancelPost(postId) {
      await posts.remove(postJobId(postId)).catch(() => {});
    },
    async stats() {
      const all = [webhooks, posts, media, ads, ...(demoQ ? [demoQ] : [])];
      const counts = await Promise.all(all.map(q => q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')));
      return Object.fromEntries(all.map((q, i) => [q.name, counts[i]!]));
    },
    async close() { await Promise.all([webhooks.close(), posts.close(), media.close(), ads.close(), demoQ?.close()]); }
  };
}
