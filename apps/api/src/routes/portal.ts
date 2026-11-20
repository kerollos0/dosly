import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sha256 } from '@dosly/shared';
import { addPayment, billingOf, cairoToday, clientReport, monthRange } from '@dosly/core';
import { PAYMENT_METHODS } from '@dosly/shared';
import { billing, INVOICE_SELECT, publicInvoice } from './billing.js';
import { HttpError } from '../auth.js';
import { createPortalSession, PORTAL_COOKIE, requirePortal, resolvePortalSession } from '../portal-auth.js';

// Drafts are the agency's internal work; the client only sees posts the agency has scheduled.
const REVIEWABLE = ['SCHEDULED'] as const;

/** The client portal API, for business owners. Mounted at /api/portal. */
export const portalRoutes: FastifyPluginAsync = async app => {
  const { db, env, realtime } = app.deps;
  const secure = env.PUBLIC_URL.startsWith('https://');

  app.addHook('onRequest', async req => {
    const ctx = await resolvePortalSession(db, req.cookies[PORTAL_COOKIE]);
    if (ctx) req.portal = ctx;
  });

  const log = (p: { agencyId: string; clientUserId: string; name: string }, action: string, entityId: string, meta?: object) =>
    db.auditLog.create({ data: { agencyId: p.agencyId, userId: null, action, entity: 'Post', entityId, meta: { by: 'client', clientUserId: p.clientUserId, name: p.name, ...meta } } });

  app.post('/auth/consume', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    // Single use: the update only matches an unused, unexpired token, so two tabs cannot both use it.
    const id = sha256(token);
    const used = await db.clientLoginToken.updateMany({ where: { id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (!used.count) throw new HttpError(401, 'اللينك ده اتستخدم قبل كده أو انتهى. اطلب لينك جديد من الوكالة.', 'link_invalid');
    const t = await db.clientLoginToken.findUniqueOrThrow({ where: { id } });
    if (req.portal) await db.clientSession.delete({ where: { id: req.portal.sessionId } }).catch(() => {});
    await createPortalSession(db, reply, t.clientUserId, secure);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.portal) await db.clientSession.delete({ where: { id: req.portal.sessionId } }).catch(() => {});
    reply.clearCookie(PORTAL_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async req => {
    const p = requirePortal(req);
    const client = await db.client.findUniqueOrThrow({ where: { id: p.clientId }, select: { name: true, requiresClientApproval: true, agency: { select: { name: true, demoExpiresAt: true } }, socialAccounts: { select: { platform: true, name: true } } } });
    return { user: { name: p.name }, client: { name: client.name, requiresClientApproval: client.requiresClientApproval, accounts: client.socialAccounts }, agency: { name: client.agency.name }, demo: client.agency.demoExpiresAt !== null };
  });

  // Only what a business owner needs: no author names, tokens, errors or internal notes.
  app.get('/posts', async req => {
    const p = requirePortal(req);
    const q = z.object({ from: z.coerce.date(), to: z.coerce.date() }).parse(req.query);
    if (q.to.getTime() - q.from.getTime() > 62 * 86400_000) throw new HttpError(400, 'أقصى مدة شهرين', 'range_too_long');
    const posts = await db.post.findMany({
      where: { clientId: p.clientId, status: { not: 'DRAFT' }, scheduledAt: { gte: q.from, lt: q.to } },
      orderBy: { scheduledAt: 'asc' },
      select: { id: true, caption: true, mediaUrls: true, scheduledAt: true, status: true, clientReview: true, clientNote: true, reviewedAt: true, targets: { select: { status: true, socialAccount: { select: { platform: true } } } } }
    });
    return posts.map(({ targets, ...post }) => ({ ...post, platforms: targets.map(t => ({ platform: t.socialAccount.platform, published: t.status === 'PUBLISHED' })) }));
  });

  const reviewable = async (clientId: string, postId: string) => {
    const post = await db.post.findFirst({ where: { id: postId, clientId } });
    if (!post) throw new HttpError(404, 'البوست مش موجود', 'not_found');
    if (!(REVIEWABLE as readonly string[]).includes(post.status)) throw new HttpError(409, 'البوست ده اتنشر خلاص', 'locked');
    return post;
  };

  app.post<{ Params: { id: string } }>('/posts/:id/approve', async req => {
    const p = requirePortal(req);
    const post = await reviewable(p.clientId, req.params.id);
    const updated = await db.post.update({ where: { id: post.id }, data: { clientReview: 'APPROVED', clientNote: null, reviewedAt: new Date() }, select: { id: true, clientReview: true } });
    await log(p, 'post.client_approve', post.id);
    await realtime.publish(p.agencyId, { type: 'post.updated', postId: post.id, status: post.status });
    return updated;
  });

  app.post<{ Params: { id: string } }>('/posts/:id/request-changes', async req => {
    const p = requirePortal(req);
    const { note } = z.object({ note: z.string().trim().min(2, 'اكتب التعديل المطلوب').max(1000) }).parse(req.body);
    const post = await reviewable(p.clientId, req.params.id);
    const updated = await db.post.update({ where: { id: post.id }, data: { clientReview: 'CHANGES_REQUESTED', clientNote: note, reviewedAt: new Date() }, select: { id: true, clientReview: true } });
    await log(p, 'post.client_changes', post.id, { note });
    await realtime.publish(p.agencyId, { type: 'post.updated', postId: post.id, status: post.status });
    return updated;
  });

  app.get('/report', async req => {
    const p = requirePortal(req);
    const now = new Date();
    const q = z.object({ year: z.coerce.number().int().min(2024).max(2100).default(now.getFullYear()), month: z.coerce.number().int().min(1).max(12).default(now.getMonth() + 1) }).parse(req.query);
    const [from, to] = monthRange(q.year, q.month);
    return clientReport(db, p.clientId, from, to);
  });

  // ---------- billing: the client's package, invoices and how to pay ----------

  const PORTAL_STATUSES = ['ISSUED', 'PAID', 'VOID'] as const; // drafts are the agency's work in progress
  const payMethods = async (agencyId: string) => {
    const b = await billingOf(db, agencyId);
    return { instapay: b.instapay, instapayLink: b.instapayLink, wallet: b.wallet, walletName: b.walletName, bankName: b.bankName, bankAccountName: b.bankAccountName, iban: b.iban, paypalLink: b.paypalLink, payNote: b.payNote };
  };

  app.get('/billing', async req => {
    const p = requirePortal(req);
    const today = cairoToday();
    const [subs, invoices, pay] = await Promise.all([
      db.clientSubscription.findMany({ where: { clientId: p.clientId, status: { in: ['ACTIVE', 'PAUSED'] } }, orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, priceMinor: true, currency: true, months: true, status: true, nextInvoiceOn: true, package: { select: { description: true, features: true, postsPerMonth: true } } } }),
      db.invoice.findMany({ where: { clientId: p.clientId, status: { in: [...PORTAL_STATUSES] } }, orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], take: 36, select: INVOICE_SELECT }),
      payMethods(p.agencyId)
    ]);
    const open = invoices.filter(i => i.status === 'ISSUED');
    const due: Record<string, number> = {};
    for (const i of open) due[i.currency] = (due[i.currency] ?? 0) + i.totalMinor - i.paidMinor;
    return {
      subscriptions: subs.map(({ package: pk, ...s }) => ({ ...s, description: pk?.description ?? null, features: pk?.features ?? [], postsPerMonth: pk?.postsPerMonth ?? null })),
      invoices: invoices.map(i => forClient(publicInvoice(i, today))),
      due: Object.entries(due).map(([currency, minor]) => ({ currency, minor })),
      pay
    };
  });

  // The agency's own notes on payments it recorded are internal; the client keeps only its own.
  const forClient = <T extends { payments: { note: string | null; reportedBy: string }[] }>(i: T): T => ({ ...i, payments: i.payments.map(x => ({ ...x, note: x.reportedBy === 'client' ? x.note : null })) });
  const portalInvoice = async (clientId: string, id: string) => {
    const inv = await db.invoice.findFirst({ where: { id, clientId, status: { in: [...PORTAL_STATUSES] } }, select: INVOICE_SELECT });
    if (!inv) throw new HttpError(404, 'الفاتورة مش موجودة', 'not_found');
    return inv;
  };

  app.get<{ Params: { id: string } }>('/invoices/:id', async req => {
    const p = requirePortal(req);
    const inv = await portalInvoice(p.clientId, req.params.id);
    // The agency sees when the client first opened it ("شاف الفاتورة").
    if (!inv.viewedAt) await db.invoice.updateMany({ where: { id: inv.id, viewedAt: null }, data: { viewedAt: new Date() } });
    return { invoice: forClient(publicInvoice(inv)), pay: await payMethods(p.agencyId) };
  });

  /** "I paid": the agency gets it to check against its bank or wallet before it counts. */
  app.post<{ Params: { id: string } }>('/invoices/:id/paid', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const p = requirePortal(req);
    const inv = await portalInvoice(p.clientId, req.params.id);
    const input = z.object({
      method: z.enum(PAYMENT_METHODS).exclude(['CASH']), reference: z.string().trim().max(120).optional(),
      amountMinor: z.number().int().min(1).optional(), note: z.string().trim().max(300).optional()
    }).parse(req.body);
    const amountMinor = input.amountMinor ?? inv.totalMinor - inv.paidMinor;
    await billing(() => addPayment(db, {
      invoiceId: inv.id, amountMinor, method: input.method, reference: input.reference || null, note: input.note || null, paidOn: cairoToday(),
      reportedBy: 'client', clientUserId: p.clientUserId
    }, { pub: realtime }));
    await db.auditLog.create({ data: { agencyId: p.agencyId, userId: null, action: 'invoice.client_paid', entity: 'Invoice', entityId: inv.id, meta: { by: 'client', clientUserId: p.clientUserId, name: p.name, amountMinor, method: input.method } } });
    return { invoice: forClient(publicInvoice(await portalInvoice(p.clientId, inv.id))) };
  });
};
