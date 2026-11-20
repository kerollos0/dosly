import { randomBytes, createHmac } from 'node:crypto';
import { createDb } from '@dosly/db';
import { localMediaStore, type RealtimeEvent } from '@dosly/core';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

export const db = createDb();
export const key = randomBytes(32);
export const APP_SECRET = 'test-app-secret';

export async function reset() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} CASCADE`);
}

export const store = localMediaStore(`/tmp/dosly-test-private-${process.pid}`);

export type Graph = (url: string, init?: RequestInit) => unknown;

export async function makeApp(graph: Graph = () => ({}), envOverrides: Record<string, string> = {}) {
  const calls = { fetchMedia: [] as string[], sends: [] as string[], templateSyncs: [] as string[], adSyncs: [] as string[], webhooks: [] as string[], scheduled: [] as { postId: string; at: Date }[], cancelled: [] as string[], demo: [] as string[], events: [] as RealtimeEvent[], graph: [] as { url: string; body?: unknown }[] };
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', ENCRYPTION_KEY: key.toString('hex'), META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: 'verify-me-123', PUBLIC_URL: 'http://localhost:3000', UPLOAD_DIR: '/tmp/dosly-test-uploads', ...envOverrides });
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.graph.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ? '[form]' : undefined });
    const out = graph(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  const app = await buildApp({
    db, env, key, fetch: fakeFetch, media: store,
    queues: {
      enqueueWebhook: async id => { calls.webhooks.push(id); },
      fetchMedia: async id => { calls.fetchMedia.push(id); },
      sendMessage: async id => { calls.sends.push(id); },
      syncTemplates: async id => { calls.templateSyncs.push(id); },
      syncAds: async id => { calls.adSyncs.push(id); },
      schedulePost: async (postId, at) => { calls.scheduled.push({ postId, at }); },
      cancelPost: async id => { calls.cancelled.push(id); },
      ...(env.DEMO_MODE === 'true' && { demoAfterSend: async (id: string) => { calls.demo.push(id); } })
    },
    realtime: { publish: (_a, e) => { calls.events.push(e); } }
  });
  return { app, calls, fetch: fakeFetch };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

/** Signs up an agency owner and returns a request helper carrying their session cookie. */
export async function owner(app: App, agencyName = 'وكالة النيل') {
  const email = `owner-${randomBytes(4).toString('hex')}@test.eg`;
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { agencyName, name: 'كيرلس', email, password: 'very-secret-pass' } });
  if (res.statusCode !== 201) throw new Error(res.body);
  return session(app, res.cookies.find(c => c.name === 'dosly_session')!.value);
}

export function session(app: App, cookie: string) {
  const fn = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, cookies: { dosly_session: cookie } });
  return Object.assign(fn, { cookie: `dosly_session=${cookie}` });
}

export const sign = (body: string) => 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
