import { Queue } from 'bullmq';
import type { Queues } from './app.js';

export const QUEUE_WEBHOOKS = 'webhooks';
export const QUEUE_POSTS = 'posts';
export const QUEUE_DEMO = 'demo';

/** BullMQ producers. Job ids are deterministic so re-scheduling a post replaces its old job. */
export function bullQueues(connection: { url: string }, demo = false): Queues & { close(): Promise<void> } {
  const opts = { connection: { url: connection.url, maxRetriesPerRequest: null } };
  const webhooks = new Queue(QUEUE_WEBHOOKS, opts);
  const posts = new Queue(QUEUE_POSTS, opts);
  const demoQ = demo ? new Queue(QUEUE_DEMO, opts) : null;
  const postJobId = (id: string) => `post-${id}`;
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
      const all = [webhooks, posts, ...(demoQ ? [demoQ] : [])];
      const counts = await Promise.all(all.map(q => q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')));
      return Object.fromEntries(all.map((q, i) => [q.name, counts[i]!]));
    },
    async close() { await Promise.all([webhooks.close(), posts.close(), demoQ?.close()]); }
  };
}
