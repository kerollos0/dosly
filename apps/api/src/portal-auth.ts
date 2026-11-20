import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@dosly/db';
import { randomToken, sha256 } from '@dosly/shared';
import { HttpError } from './auth.js';

/**
 * Client portal sessions are a separate kind from agency sessions: their own cookie, table and
 * request field. A portal cookie can never reach an agency route and the other way round.
 */
export const PORTAL_COOKIE = 'dosly_portal';
const PORTAL_SESSION_DAYS = 30;
export const PORTAL_LINK_DAYS = 7;

export type PortalContext = { clientUserId: string; clientId: string; agencyId: string; sessionId: string; name: string };

declare module 'fastify' {
  interface FastifyRequest { portal?: PortalContext }
}

export async function createPortalSession(db: Db, reply: FastifyReply, clientUserId: string, secure: boolean) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_DAYS * 86400_000);
  await db.clientSession.create({ data: { id: sha256(token), clientUserId, expiresAt } });
  await db.clientUser.update({ where: { id: clientUserId }, data: { lastLoginAt: new Date() } });
  reply.setCookie(PORTAL_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}

export async function resolvePortalSession(db: Db, token: string | undefined): Promise<PortalContext | null> {
  if (!token) return null;
  const s = await db.clientSession.findUnique({ where: { id: sha256(token) }, include: { clientUser: { include: { client: true } } } });
  if (!s || s.expiresAt < new Date() || s.clientUser.client.archivedAt) return null;
  return { clientUserId: s.clientUserId, clientId: s.clientUser.clientId, agencyId: s.clientUser.agencyId, sessionId: s.id, name: s.clientUser.name };
}

export function requirePortal(req: FastifyRequest): PortalContext {
  if (!req.portal) throw new HttpError(401, 'اللينك انتهى أو مش صحيح. اطلب لينك جديد من الوكالة.', 'unauthorized');
  return req.portal;
}

/** A one-time sign-in link. Only its hash is stored, like every other token in Dosly. */
export async function createLoginLink(db: Db, clientUserId: string, publicUrl: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + PORTAL_LINK_DAYS * 86400_000);
  await db.clientLoginToken.create({ data: { id: sha256(token), clientUserId, expiresAt } });
  return { url: `${publicUrl.replace(/\/$/, '')}/portal/login#${token}`, expiresAt };
}
