import type { Server as HttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import type { Db } from '@dosly/db';
import type { Publisher, RealtimeEvent } from '@dosly/core';
import { resolveSession, SESSION_COOKIE } from './auth.js';

export const EVENTS_CHANNEL = 'dosly:events';

/** Every process (API or worker) publishes to Redis; every API instance relays to its own sockets. */
export function redisPublisher(redis: Redis): Publisher {
  return { publish: (agencyId, event) => { void redis.publish(EVENTS_CHANNEL, JSON.stringify({ agencyId, event })); } };
}

const parseCookie = (header = '', name: string) =>
  header.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);

export function attachRealtime(server: HttpServer, db: Db, redisUrl: string) {
  const io = new Server(server, { path: '/socket.io', serveClient: false, cors: { origin: false } });
  io.use(async (socket, next) => {
    const auth = await resolveSession(db, parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE) && decodeURIComponent(parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE)!));
    if (!auth) return next(new Error('unauthorized'));
    socket.data.auth = auth;
    next();
  });
  io.on('connection', socket => { void socket.join(`agency:${socket.data.auth.agencyId}`); });

  const sub = new Redis(redisUrl);
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on('message', (_ch, raw) => {
    try {
      const { agencyId, event } = JSON.parse(raw) as { agencyId: string; event: RealtimeEvent };
      io.to(`agency:${agencyId}`).emit('event', event);
    } catch { /* ignore malformed */ }
  });
  return { io, close: async () => { io.close(); sub.disconnect(); } };
}
