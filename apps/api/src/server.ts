import { Redis } from 'ioredis';
import { createDb } from '@dosly/db';
import { loadKey } from '@dosly/shared';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { bullQueues } from './queues.js';
import { attachRealtime, redisPublisher } from './realtime.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queues = bullQueues({ url: env.REDIS_URL });
const app = await buildApp({ db, env, key: loadKey(env.ENCRYPTION_KEY), queues, realtime: redisPublisher(redis) });
const rt = attachRealtime(app.server, db, env.REDIS_URL);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const shutdown = async () => {
  app.log.info('Shutting down');
  await app.close();
  await rt.close();
  await queues.close();
  redis.disconnect();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
