import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@dosly/db';
import { autoRuleSchema, type AutoRuleInput } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requirePermission, visibleClientIds, type AuthContext } from '../auth.js';

const MAX_RULES_PER_CLIENT = 60;

/** The columns a rule's input fills; the ones a kind does not use are cleared. */
function columns(r: AutoRuleInput) {
  return {
    kind: r.kind,
    name: 'name' in r ? r.name || null : null,
    channels: 'channels' in r ? [...new Set(r.channels)] : [],
    platforms: 'platforms' in r ? [...new Set(r.platforms)] : [],
    keywords: 'keywords' in r ? [...new Set(r.keywords.map(k => k.trim()).filter(Boolean))] : [],
    postExternalId: r.kind === 'COMMENT' ? r.postExternalId || null : null,
    postLabel: r.kind === 'COMMENT' && r.postExternalId ? r.postLabel || null : null,
    reply: r.reply || null,
    publicReplies: r.kind === 'COMMENT' ? r.publicReplies : [],
    hours: r.kind === 'AWAY' ? (r.hours as Prisma.InputJsonValue) : undefined
  };
}

/**
 * Automatic replies per client: welcome, away (outside working hours), keyword replies in chats,
 * and comment rules (public reply under the post and/or one private message).
 */
export const automationRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;

  async function ruleFor(auth: AuthContext, id: string) {
    const r = await db.autoRule.findFirst({ where: { id, agencyId: auth.agencyId } });
    if (!r) throw new HttpError(404, 'الرد ده مش موجود', 'not_found');
    await assertClientAccess(db, auth, r.clientId);
    return r;
  }

  /** The clients this person manages, with what each one has connected. */
  app.get('/automations/options', async req => {
    const auth = requirePermission(req, 'automations:manage');
    const visible = await visibleClientIds(db, auth);
    const clients = await db.client.findMany({
      where: { agencyId: auth.agencyId, archivedAt: null, ...(visible !== 'all' && { id: { in: visible } }) }, orderBy: { name: 'asc' },
      select: { id: true, name: true, waNumbers: { where: { status: 'CONNECTED' }, select: { id: true } }, socialAccounts: { where: { status: 'CONNECTED' }, select: { platform: true } }, _count: { select: { autoRules: { where: { enabled: true } } } } }
    });
    return clients.map(c => {
      const platforms = [...new Set(c.socialAccounts.map(a => a.platform))];
      const channels = [...(c.waNumbers.length ? ['WHATSAPP'] : []), ...(platforms.includes('FACEBOOK_PAGE') ? ['MESSENGER'] : []), ...(platforms.includes('INSTAGRAM') ? ['INSTAGRAM'] : [])];
      return { id: c.id, name: c.name, channels, platforms, active: c._count.autoRules };
    });
  });

  /** A client's rules, and its recent posts to pick from for a comment rule. */
  app.get<{ Querystring: { clientId?: string } }>('/automations', async req => {
    const auth = requirePermission(req, 'automations:manage');
    const clientId = z.string().min(1).parse(req.query.clientId);
    await assertClientAccess(db, auth, clientId);
    const [rules, targets] = await Promise.all([
      db.autoRule.findMany({ where: { agencyId: auth.agencyId, clientId }, orderBy: { createdAt: 'asc' } }),
      db.postTarget.findMany({
        where: { status: 'PUBLISHED', externalPostId: { not: null }, socialAccount: { clientId, agencyId: auth.agencyId } }, orderBy: { publishedAt: 'desc' }, take: 20,
        select: { externalPostId: true, publishedAt: true, socialAccount: { select: { platform: true } }, post: { select: { caption: true, mediaUrls: true } } }
      })
    ]);
    const posts = targets.map(t => ({ externalId: t.externalPostId!, platform: t.socialAccount.platform, caption: t.post.caption.slice(0, 120), image: t.post.mediaUrls[0] ?? null, publishedAt: t.publishedAt }));
    return { rules: rules.map(({ agencyId, createdById, ...r }) => r), posts };
  });

  app.post('/automations', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'automations:manage');
    const body = z.object({ clientId: z.string().min(1) }).and(autoRuleSchema).parse(req.body);
    await assertClientAccess(db, auth, body.clientId);
    const data = columns(body);
    // One welcome and one away message per client: saving again changes it.
    if (body.kind === 'WELCOME' || body.kind === 'AWAY') {
      const existing = await db.autoRule.findFirst({ where: { clientId: body.clientId, kind: body.kind } });
      if (existing) {
        const r = await db.autoRule.update({ where: { id: existing.id }, data: { ...data, enabled: true, lastError: null } });
        await audit(db, auth, 'automation.update', 'AutoRule', r.id, { kind: r.kind });
        return reply.status(200).send({ id: r.id });
      }
    }
    if (await db.autoRule.count({ where: { clientId: body.clientId } }) >= MAX_RULES_PER_CLIENT) throw new HttpError(409, `وصلت لأقصى عدد ردود للعميل ده (${MAX_RULES_PER_CLIENT})`, 'too_many');
    const r = await db.autoRule.create({ data: { ...data, agencyId: auth.agencyId, clientId: body.clientId, createdById: auth.userId } });
    await audit(db, auth, 'automation.create', 'AutoRule', r.id, { kind: r.kind });
    return reply.status(201).send({ id: r.id });
  });

  // Edit a rule (the same fields as creating it) or just switch it on or off.
  app.patch<{ Params: { id: string } }>('/automations/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'automations:manage');
    const r = await ruleFor(auth, req.params.id);
    const toggle = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (toggle.success) {
      await db.autoRule.update({ where: { id: r.id }, data: { enabled: toggle.data.enabled, ...(toggle.data.enabled ? { lastError: null } : {}) } });
      await audit(db, auth, toggle.data.enabled ? 'automation.enable' : 'automation.disable', 'AutoRule', r.id);
      return { ok: true };
    }
    const body = autoRuleSchema.parse(req.body);
    if (body.kind !== r.kind) throw new HttpError(400, 'نوع الرد ماينفعش يتغير', 'kind_changed');
    await db.autoRule.update({ where: { id: r.id }, data: { ...columns(body), lastError: null } });
    await audit(db, auth, 'automation.update', 'AutoRule', r.id, { kind: r.kind });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/automations/:id', async req => {
    const auth = requirePermission(req, 'automations:manage');
    const r = await ruleFor(auth, req.params.id);
    await db.autoRule.delete({ where: { id: r.id } });
    await audit(db, auth, 'automation.delete', 'AutoRule', r.id, { kind: r.kind });
    return { ok: true };
  });
};
