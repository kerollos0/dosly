import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@dosly/db';
import { randomToken, sha256 } from '@dosly/shared';
import { HttpError } from './auth.js';

/** Dosly staff sessions: their own cookie and table, 12 hours, never shared with agency or portal sessions. */
export const ADMIN_COOKIE = 'dosly_admin';
const ADMIN_SESSION_HOURS = 12;

export type AdminContext = { adminId: string; name: string; sessionId: string; readOnly: boolean };

declare module 'fastify' {
  interface FastifyRequest { admin?: AdminContext }
}

export async function createAdminSession(db: Db, reply: FastifyReply, adminId: string, secure: boolean, readOnly = false) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_HOURS * 3600_000);
  await db.adminSession.create({ data: { id: sha256(token), adminId, expiresAt, readOnly } });
  reply.setCookie(ADMIN_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', expires: expiresAt });
}

export async function resolveAdminSession(db: Db, token: string | undefined): Promise<AdminContext | null> {
  if (!token) return null;
  const s = await db.adminSession.findUnique({ where: { id: sha256(token) }, include: { admin: { select: { name: true } } } });
  if (!s || s.expiresAt < new Date()) return null;
  return { adminId: s.adminId, name: s.admin.name, sessionId: s.id, readOnly: s.readOnly };
}

export function requireAdmin(req: FastifyRequest, write = false): AdminContext {
  if (!req.admin) throw new HttpError(401, 'سجّل دخول الأدمن الأول', 'unauthorized');
  if (write && req.admin.readOnly) throw new HttpError(403, 'دي نسخة ديمو من لوحة الأدمن، للعرض بس', 'read_only');
  return req.admin;
}
