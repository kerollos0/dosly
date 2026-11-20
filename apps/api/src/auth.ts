import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db, Role } from '@dosly/db';
import { can, randomToken, sha256, type Permission } from '@dosly/shared';

export const SESSION_COOKIE = 'dosly_session';
const SESSION_DAYS = 30;

export type AuthContext = {
  userId: string; agencyId: string; role: Role; sessionId: string;
  /** Set when a Dosly admin is signed in as this user for support. */
  impersonatorId: string | null;
  /** Why this session can look but not change anything, or null when it can. */
  readOnly: ReadOnlyReason | null;
};

export type ReadOnlyReason = 'support' | 'suspended' | 'trial_ended' | 'unpaid';
const GRACE_DAYS = 7;

export function readOnlyReason(a: { status: string; plan: string; trialEndsAt: Date | null; paidUntil: Date | null }, impersonated: boolean, now = new Date()): ReadOnlyReason | null {
  if (impersonated) return 'support';
  if (a.status === 'SUSPENDED') return 'suspended';
  if (a.plan === 'TRIAL' && a.trialEndsAt && a.trialEndsAt < now) return 'trial_ended';
  if (a.plan !== 'TRIAL' && a.paidUntil && a.paidUntil.getTime() + GRACE_DAYS * 86400_000 < now.getTime()) return 'unpaid';
  return null;
}

declare module 'fastify' {
  interface FastifyRequest { auth?: AuthContext }
}

export async function createSession(db: Db, reply: FastifyReply, userId: string, agencyId: string, secure: boolean, impersonatorId?: string) {
  const token = randomToken();
  // Support sessions are short: an hour is enough to look at a problem.
  const expiresAt = new Date(Date.now() + (impersonatorId ? 3600_000 : SESSION_DAYS * 86400_000));
  await db.session.create({ data: { id: sha256(token), userId, agencyId, expiresAt, impersonatorId } });
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', expires: expiresAt });
}

export async function resolveSession(db: Db, token: string | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { id: sha256(token) } });
  if (!session || session.expiresAt < new Date()) return null;
  const m = await db.membership.findUnique({ where: { agencyId_userId: { agencyId: session.agencyId, userId: session.userId } }, include: { agency: { select: { status: true, plan: true, trialEndsAt: true, paidUntil: true } } } });
  if (!m) return null;
  return {
    userId: session.userId, agencyId: session.agencyId, role: m.role, sessionId: session.id,
    impersonatorId: session.impersonatorId, readOnly: readOnlyReason(m.agency, !!session.impersonatorId)
  };
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code = 'error') { super(message); }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new HttpError(401, 'سجّل الدخول الأول', 'unauthorized');
  return req.auth;
}

export function requirePermission(req: FastifyRequest, p: Permission): AuthContext {
  const auth = requireAuth(req);
  if (!can(auth.role, p)) throw new HttpError(403, 'مش مسموح لك تعمل ده', 'forbidden');
  return auth;
}

/** Client ids the user may see: all of the agency's for owners and managers, assigned ones for everyone else. */
export async function visibleClientIds(db: Db, auth: AuthContext): Promise<string[] | 'all'> {
  if (can(auth.role, 'clients:view-all')) return 'all';
  const rows = await db.clientAssignment.findMany({ where: { userId: auth.userId, client: { agencyId: auth.agencyId } }, select: { clientId: true } });
  return rows.map(r => r.clientId);
}

export async function assertClientAccess(db: Db, auth: AuthContext, clientId: string) {
  const client = await db.client.findFirst({ where: { id: clientId, agencyId: auth.agencyId } });
  if (!client) throw new HttpError(404, 'العميل مش موجود', 'not_found');
  const visible = await visibleClientIds(db, auth);
  if (visible !== 'all' && !visible.includes(clientId)) throw new HttpError(403, 'العميل ده مش متعين لك', 'forbidden');
  return client;
}

export const audit = (db: Db, auth: Pick<AuthContext, 'agencyId' | 'userId'>, action: string, entity: string, entityId?: string, meta?: object) =>
  db.auditLog.create({ data: { agencyId: auth.agencyId, userId: auth.userId, action, entity, entityId, meta: meta as any } });
