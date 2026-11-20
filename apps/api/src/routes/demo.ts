import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encrypt, hashPassword, newTotpSecret, randomToken, ROLES } from '@dosly/shared';
import { simulateClientPayment, syncAdAccount, seedDemoAgency, simulateComment, simulateInbound, simulateOrder, simulateSocialMessage } from '@dosly/core';
import { audit, createSession, HttpError, requireAuth, SESSION_COOKIE } from '../auth.js';
import { createPortalSession } from '../portal-auth.js';
import { createAdminSession } from '../admin-auth.js';

/** Registered only when DEMO_MODE=true. Lets anyone open a private sandbox agency with one click. */
export const demoRoutes: FastifyPluginAsync = async app => {
  const { db, key, env, realtime } = app.deps;
  const secure = env.PUBLIC_URL.startsWith('https://');
  const roleSchema = z.object({ role: z.enum(ROLES).default('OWNER') });

  const sandboxOf = async (req: FastifyRequest) => {
    const auth = requireAuth(req);
    const agency = await db.agency.findUniqueOrThrow({ where: { id: auth.agencyId } });
    if (!agency.demoExpiresAt) throw new HttpError(403, 'الأداة دي للديمو بس', 'not_demo');
    return { auth, agency };
  };

  const signInAs = async (req: FastifyRequest, reply: Parameters<typeof createSession>[1], agencyId: string, role: (typeof ROLES)[number]) => {
    const m = await db.membership.findFirst({ where: { agencyId, role }, orderBy: { createdAt: 'asc' } });
    if (!m) throw new HttpError(404, 'مفيش حد بالدور ده في الديمو', 'not_found');
    if (req.auth) await db.session.delete({ where: { id: req.auth.sessionId } }).catch(() => {});
    await createSession(db, reply, m.userId, agencyId, secure);
  };

  app.get('/demo/info', async () => ({ demo: true, roles: ROLES }));

  // Seeding costs a few hundred rows, so it is rate limited harder than login.
  app.post('/demo/start', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { role } = roleSchema.parse(req.body ?? {});
    let agencyId: string | undefined;
    if (req.auth) {
      const current = await db.agency.findUnique({ where: { id: req.auth.agencyId } });
      if (current?.demoExpiresAt && current.demoExpiresAt > new Date()) agencyId = current.id; // keep the visitor's own sandbox
    }
    if (!agencyId) {
      const seeded = await seedDemoAgency(db, key);
      agencyId = seeded.agencyId;
      for (const id of seeded.mediaMessageIds) await app.deps.queues.fetchMedia(id);
      // Ads numbers come from the simulated Marketing API through the real sync, so the ads page is full on arrival.
      await Promise.all(seeded.adAccountIds.map(id => syncAdAccount({ db, key, pub: realtime, fetch: app.deps.fetch }, id).catch(err => req.log.warn({ err }, 'Demo ads sync failed'))));
    }
    await signInAs(req, reply, agencyId, role);
    return { ok: true };
  });

  app.post('/demo/switch', async (req, reply) => {
    const { agency } = await sandboxOf(req);
    const { role } = roleSchema.parse(req.body ?? {});
    await signInAs(req, reply, agency.id, role);
    return { ok: true };
  });

  app.post('/demo/inbound', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { auth } = await sandboxOf(req);
    const { clientId, media } = z.object({ clientId: z.string().optional(), media: z.enum(['photo', 'voice', 'pricelist', 'random']).optional() }).parse(req.body ?? {});
    await simulateInbound(db, realtime, { agencyId: auth.agencyId, clientId, media: media ?? 'random' }, { onMedia: id => app.deps.queues.fetchMedia(id) });
    return { ok: true };
  });

  // A new comment on a published post, or a Messenger/Instagram message, as Meta would deliver it.
  app.post('/demo/social', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { auth } = await sandboxOf(req);
    const o = z.object({ kind: z.enum(['comment', 'message']), clientId: z.string().optional(), platform: z.enum(['FACEBOOK_PAGE', 'INSTAGRAM']).optional(), media: z.enum(['photo', 'voice', 'pricelist']).optional() }).parse(req.body ?? {});
    const ok = o.kind === 'comment'
      ? await simulateComment(db, realtime, { agencyId: auth.agencyId, clientId: o.clientId, platform: o.platform })
      : await simulateSocialMessage(db, realtime, { agencyId: auth.agencyId, clientId: o.clientId, platform: o.platform, media: o.media }, { onMedia: id => app.deps.queues.fetchMedia(id) });
    if (!ok) throw new HttpError(404, 'مفيش صفحة أو بوست منشور للعميل ده', 'not_found');
    return { ok: true };
  });

  // A new cash-on-delivery order on one of the demo stores; its WhatsApp confirmation goes out like a real one.
  app.post('/demo/order', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { auth } = await sandboxOf(req);
    const { clientId } = z.object({ clientId: z.string().optional() }).parse(req.body ?? {});
    const orderId = await simulateOrder({ db, pub: realtime, onSend: id => app.deps.queues.sendMessage(id) }, { agencyId: auth.agencyId, clientId });
    if (!orderId) throw new HttpError(404, 'مفيش متجر مربوط للعميل ده', 'not_found');
    return { ok: true, orderId };
  });

  // A client reports a transfer on one of their open invoices, as if they pressed "أنا دفعت" in the portal.
  app.post('/demo/client-pays', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const { auth } = await sandboxOf(req);
    const invoiceId = await simulateClientPayment(db, realtime, auth.agencyId);
    if (!invoiceId) throw new HttpError(404, 'مفيش فواتير مفتوحة مستنية دفع', 'not_found');
    return { ok: true, invoiceId };
  });

  // Opens the client portal as that client's owner, in the same browser, without a sign-in link.
  app.post('/demo/portal', async (req, reply) => {
    const { auth } = await sandboxOf(req);
    const { clientId } = z.object({ clientId: z.string() }).parse(req.body ?? {});
    const user = await db.clientUser.findFirst({ where: { clientId, agencyId: auth.agencyId }, orderBy: { createdAt: 'asc' } });
    if (!user) throw new HttpError(404, 'العميل ده مالوش حد على البوابة', 'not_found');
    await createPortalSession(db, reply, user.id, secure);
    return { ok: true };
  });

  // A read-only tour of Dosly's own back office. It lists only demo sandboxes, which hold made-up data.
  app.post('/demo/admin', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    await sandboxOf(req);
    const email = 'demo-admin@demo.dosly.invalid';
    const admin = await db.adminUser.findUnique({ where: { email } })
      ?? await db.adminUser.create({ data: { email, name: 'زائر الديمو', passwordHash: await hashPassword(randomToken()), totpSecretEnc: encrypt(newTotpSecret(), key) } });
    await createAdminSession(db, reply, admin.id, secure, true);
    return { ok: true };
  });

  app.post('/demo/end', async (req, reply) => {
    const { auth, agency } = await sandboxOf(req);
    await audit(db, auth, 'demo.end', 'Agency', agency.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    await db.agency.update({ where: { id: agency.id }, data: { demoExpiresAt: new Date() } }); // the worker sweeps it
    return { ok: true };
  });
};
