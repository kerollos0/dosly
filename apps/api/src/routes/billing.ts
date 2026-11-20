import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db, Prisma } from '@dosly/db';
import { addPayment, BillingError, billingOf, cairoToday, createDraft, cyclesToSkip, decidePayment, generateDueInvoices, issueInvoice, overdueWhere, voidInvoice } from '@dosly/core';
import {
  billingSettingsSchema, BILLING_CURRENCIES, clientBillingSchema, daySchema, invoiceItemSchema, invoiceTotals, MAX_INVOICE_MINOR, MAX_PRICE_MINOR, packagePatchSchema, packageSchema,
  PAYMENT_METHODS, subscriptionPeriod, type InvoiceItem
} from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requirePermission, type AuthContext } from '../auth.js';

export const INVOICE_SELECT = {
  id: true, clientId: true, subscriptionId: true, number: true, status: true, currency: true, issueOn: true, dueOn: true, periodFrom: true, periodTo: true,
  items: true, subtotalMinor: true, discountMinor: true, vatRateBp: true, vatMinor: true, totalMinor: true, paidMinor: true, notes: true,
  seller: true, buyer: true, etaUuid: true, issuedAt: true, paidAt: true, voidedAt: true, voidReason: true, viewedAt: true, createdAt: true,
  client: { select: { name: true } },
  payments: { orderBy: { createdAt: 'asc' }, select: { id: true, amountMinor: true, method: true, reference: true, paidOn: true, state: true, reportedBy: true, note: true, createdAt: true, decidedAt: true } }
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;
export const publicInvoice = (i: InvoiceRow, today = cairoToday()) => ({
  ...i, overdue: i.status === 'ISSUED' && !!i.dueOn && i.dueOn < today, pendingPayments: i.payments.filter(p => p.state === 'PENDING').length
});

/** Maps a billing rule broken in the core to a 409 with its Arabic message. */
export async function billing<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (e) {
    if (e instanceof BillingError) throw new HttpError(e.code === 'not_found' ? 404 : 409, e.message, e.code);
    if ((e as { code?: string }).code === 'P2025') throw new HttpError(404, 'مش موجود', 'not_found');
    throw e;
  }
}

const money = z.number().int().min(0).max(MAX_INVOICE_MINOR);
// No defaults here: an edit that leaves a field out keeps what the draft has.
const draftSchema = z.object({
  items: z.array(invoiceItemSchema).min(1, 'ضيف بند واحد على الأقل').max(30),
  discountMinor: money,
  vat: z.boolean().optional(),
  dueOn: daySchema.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});
const createInvoiceSchema = z.object({
  clientId: z.string().min(1),
  currency: z.enum(BILLING_CURRENCIES).default('EGP'),
  packageId: z.string().min(1).optional(), // bill one package once (a one-time package, or an extra month)
  items: z.array(invoiceItemSchema).max(30).optional(),
  discountMinor: money.default(0),
  vat: z.boolean().optional(),
  dueOn: daySchema.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  issue: z.boolean().default(false)
});

const checkTotal = (items: InvoiceItem[], discount: number, vatBp: number) => {
  const t = invoiceTotals(items, discount, vatBp);
  if (t.totalMinor > MAX_INVOICE_MINOR || t.subtotalMinor > MAX_INVOICE_MINOR) throw new HttpError(400, 'إجمالي الفاتورة كبير أوي. قسّمها على أكتر من فاتورة.', 'too_large');
  return t;
};

export const billingRoutes: FastifyPluginAsync = async app => {
  const { db, realtime } = app.deps;
  const pub = realtime;

  const settingsView = async (agencyId: string) => {
    const { agencyId: _a, nextNumber, updatedAt: _u, ...b } = await billingOf(db, agencyId);
    return { ...b, nextNumber };
  };

  // ---------- settings ----------

  app.get('/billing/settings', async req => {
    const auth = requirePermission(req, 'billing:manage');
    return settingsView(auth.agencyId);
  });

  app.put('/billing/settings', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const input = billingSettingsSchema.parse(req.body);
    const cur = await billingOf(db, auth.agencyId);
    const next = { ...cur, ...input };
    if (next.vatRegistered && !next.taxId) throw new HttpError(400, 'لو مسجّل في ضريبة القيمة المضافة لازم تكتب رقم التسجيل الضريبي', 'tax_id_required');
    await db.agencyBilling.update({ where: { agencyId: auth.agencyId }, data: input });
    await audit(db, auth, 'billing.settings', 'AgencyBilling', auth.agencyId, { fields: Object.keys(input) });
    return settingsView(auth.agencyId);
  });

  // ---------- packages ----------

  app.get('/billing/packages', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const rows = await db.servicePackage.findMany({
      where: { agencyId: auth.agencyId }, orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { priceMinor: 'asc' }],
      include: { _count: { select: { subscriptions: { where: { status: { not: 'ENDED' } } } } } }
    });
    return rows.map(({ _count, ...p }) => ({ ...p, clients: _count.subscriptions }));
  });

  app.post('/billing/packages', async (req, reply) => {
    const auth = requirePermission(req, 'billing:manage');
    const input = packageSchema.parse(req.body);
    if (await db.servicePackage.count({ where: { agencyId: auth.agencyId, archivedAt: null } }) >= 50) throw new HttpError(409, 'وصلت لأقصى عدد باقات (50). أرشف باقة قديمة الأول.', 'limit');
    const p = await db.servicePackage.create({ data: { ...input, agencyId: auth.agencyId } });
    await audit(db, auth, 'package.create', 'ServicePackage', p.id, { name: p.name, priceMinor: p.priceMinor });
    return reply.status(201).send({ ...p, clients: 0 });
  });

  const ownPackage = async (auth: AuthContext, id: string) => {
    const p = await db.servicePackage.findFirst({ where: { id, agencyId: auth.agencyId } });
    if (!p) throw new HttpError(404, 'الباقة مش موجودة', 'not_found');
    return p;
  };

  // Changing a package changes it for new clients only: running subscriptions keep their copied price.
  app.patch<{ Params: { id: string } }>('/billing/packages/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const p = await ownPackage(auth, req.params.id);
    const input = packagePatchSchema.parse(req.body);
    const out = await db.servicePackage.update({ where: { id: p.id }, data: input });
    await audit(db, auth, 'package.update', 'ServicePackage', p.id, input);
    return out;
  });

  app.post<{ Params: { id: string } }>('/billing/packages/:id/archive', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const p = await ownPackage(auth, req.params.id);
    const { archived } = z.object({ archived: z.boolean().default(true) }).parse(req.body ?? {});
    await db.servicePackage.update({ where: { id: p.id }, data: { archivedAt: archived ? new Date() : null } });
    await audit(db, auth, archived ? 'package.archive' : 'package.restore', 'ServicePackage', p.id);
    return { ok: true };
  });

  // ---------- clients' subscriptions and billing details ----------

  const subView = (s: Prisma.ClientSubscriptionGetPayload<{ include: { client: { select: { name: true } } } }>) => ({
    id: s.id, clientId: s.clientId, client: s.client, packageId: s.packageId, name: s.name, priceMinor: s.priceMinor, currency: s.currency, months: s.months,
    startOn: s.startOn, nextInvoiceOn: s.nextInvoiceOn, status: s.status, cycles: s.cycles, createdAt: s.createdAt
  });

  app.get('/billing/subscriptions', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const { clientId } = z.object({ clientId: z.string().optional() }).parse(req.query);
    const rows = await db.clientSubscription.findMany({
      where: { agencyId: auth.agencyId, ...(clientId && { clientId }), status: { not: 'ENDED' }, client: { archivedAt: null } },
      orderBy: { createdAt: 'asc' }, include: { client: { select: { name: true } } }
    });
    return rows.map(subView);
  });

  app.post('/billing/subscriptions', async (req, reply) => {
    const auth = requirePermission(req, 'billing:manage');
    const today = cairoToday();
    const input = z.object({
      clientId: z.string().min(1), packageId: z.string().min(1), startOn: daySchema.optional(), priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR).optional()
    }).parse(req.body);
    const cl = await assertClientAccess(db, auth, input.clientId);
    if (cl.archivedAt) throw new HttpError(409, 'العميل ده متأرشف', 'archived');
    const p = await ownPackage(auth, input.packageId);
    if (p.archivedAt) throw new HttpError(409, 'الباقة دي متأرشفة', 'archived');
    if (p.months === 0) throw new HttpError(409, 'دي باقة مرة واحدة. اعملها فاتورة على طول.', 'one_time');
    const startOn = input.startOn ?? today;
    if (startOn < addDaysStr(today, -366) || startOn > addDaysStr(today, 366)) throw new HttpError(400, 'تاريخ البداية بعيد أوي', 'bad_start');
    // A start in the past bills only the current period, not every month since.
    const cycles = startOn < today ? cyclesToSkip(startOn, p.months, 0, today) : 0;
    const sub = await db.clientSubscription.create({ data: {
      agencyId: auth.agencyId, clientId: input.clientId, packageId: p.id, name: p.name, priceMinor: input.priceMinor ?? p.priceMinor,
      currency: p.currency, months: p.months, startOn, cycles, nextInvoiceOn: subscriptionPeriod(startOn, p.months, cycles).from
    }, include: { client: { select: { name: true } } } });
    await audit(db, auth, 'subscription.start', 'ClientSubscription', sub.id, { client: sub.client.name, name: sub.name, priceMinor: sub.priceMinor });
    // The first period starts today: its invoice goes out now instead of within the hour.
    await generateDueInvoices(db, { pub, subscriptionId: sub.id });
    const fresh = await db.clientSubscription.findUniqueOrThrow({ where: { id: sub.id }, include: { client: { select: { name: true } } } });
    return reply.status(201).send(subView(fresh));
  });

  app.patch<{ Params: { id: string } }>('/billing/subscriptions/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const s = await db.clientSubscription.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId } });
    if (!s) throw new HttpError(404, 'الاشتراك مش موجود', 'not_found');
    await assertClientAccess(db, auth, s.clientId);
    const input = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(), priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR).optional() }).parse(req.body);
    if (s.status === 'ENDED') throw new HttpError(409, 'الاشتراك ده خلص. ابدأ اشتراك جديد.', 'ended');
    const data: Prisma.ClientSubscriptionUpdateInput = {};
    if (input.priceMinor !== undefined) data.priceMinor = input.priceMinor;
    if (input.status === 'PAUSED') data.status = 'PAUSED';
    if (input.status === 'ENDED') Object.assign(data, { status: 'ENDED', nextInvoiceOn: null, endedAt: new Date() });
    if (input.status === 'ACTIVE' && s.status === 'PAUSED') {
      // Resuming bills from the current period: the paused months are skipped, not charged.
      const cycles = cyclesToSkip(s.startOn, s.months, s.cycles, cairoToday());
      Object.assign(data, { status: 'ACTIVE', cycles, nextInvoiceOn: subscriptionPeriod(s.startOn, s.months, cycles).from });
    }
    // The status is part of the condition, so a pause racing the hourly run can't be lost.
    const done = await db.clientSubscription.updateMany({ where: { id: s.id, status: s.status, cycles: s.cycles }, data: data as Prisma.ClientSubscriptionUpdateManyMutationInput });
    if (!done.count) throw new HttpError(409, 'الاشتراك اتغير دلوقتي. افتح الصفحة تاني.', 'conflict');
    await audit(db, auth, 'subscription.update', 'ClientSubscription', s.id, input);
    if (data.status === 'ACTIVE') await generateDueInvoices(db, { pub, subscriptionId: s.id });
    return subView(await db.clientSubscription.findUniqueOrThrow({ where: { id: s.id }, include: { client: { select: { name: true } } } }));
  });

  app.get('/billing/clients', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const today = cairoToday();
    const clients = await db.client.findMany({
      where: { agencyId: auth.agencyId, archivedAt: null }, orderBy: { name: 'asc' },
      select: { id: true, name: true, legalName: true, taxId: true, billingAddress: true,
        subscriptions: { where: { status: { not: 'ENDED' } }, orderBy: { createdAt: 'asc' }, include: { client: { select: { name: true } } } },
        invoices: { where: { status: 'ISSUED' }, select: { totalMinor: true, paidMinor: true, currency: true, dueOn: true } } }
    });
    return clients.map(({ subscriptions, invoices, ...c }) => {
      const owed: Record<string, { minor: number; overdue: number }> = {};
      for (const i of invoices) {
        const o = (owed[i.currency] ??= { minor: 0, overdue: 0 });
        o.minor += i.totalMinor - i.paidMinor;
        if (i.dueOn && i.dueOn < today) o.overdue += i.totalMinor - i.paidMinor;
      }
      return { ...c, subscriptions: subscriptions.map(subView), owed: Object.entries(owed).map(([currency, v]) => ({ currency, ...v })) };
    });
  });

  app.put<{ Params: { id: string } }>('/billing/clients/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    await assertClientAccess(db, auth, req.params.id);
    const input = clientBillingSchema.parse(req.body);
    const c = await db.client.update({ where: { id: req.params.id }, data: input, select: { id: true, legalName: true, taxId: true, billingAddress: true } });
    await audit(db, auth, 'client.billing', 'Client', c.id);
    return c;
  });

  // ---------- invoices ----------

  const ownInvoice = async (auth: AuthContext, id: string) => {
    const inv = await db.invoice.findFirst({ where: { id, agencyId: auth.agencyId } });
    if (!inv) throw new HttpError(404, 'الفاتورة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, inv.clientId);
    return inv;
  };
  const view = async (id: string) => publicInvoice(await db.invoice.findUniqueOrThrow({ where: { id }, select: INVOICE_SELECT }));

  const VIEWS = ['unpaid', 'check', 'draft', 'paid', 'all'] as const;
  const viewWhere = (v: (typeof VIEWS)[number]): Prisma.InvoiceWhereInput =>
    v === 'unpaid' ? { status: 'ISSUED' } : v === 'check' ? { status: 'ISSUED', payments: { some: { state: 'PENDING' } } } : v === 'draft' ? { status: 'DRAFT' } : v === 'paid' ? { status: 'PAID' } : {};

  app.get('/billing/invoices', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const q = z.object({
      view: z.enum(VIEWS).default('unpaid'), clientId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30)
    }).parse(req.query);
    if (q.clientId) await assertClientAccess(db, auth, q.clientId);
    const rows = await db.invoice.findMany({
      where: { agencyId: auth.agencyId, ...(q.clientId && { clientId: q.clientId }), ...viewWhere(q.view) },
      // Unpaid: the one due first on top, so the oldest debt is chased first. Everything else: newest first.
      orderBy: q.view === 'unpaid' ? [{ dueOn: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      select: INVOICE_SELECT, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {})
    });
    const today = cairoToday();
    const items = rows.slice(0, q.limit).map(r => publicInvoice(r, today));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)!.id : null };
  });

  app.get('/billing/counts', async req => {
    const auth = requirePermission(req, 'billing:manage');
    return billingCounts(db, auth.agencyId);
  });

  app.get<{ Params: { id: string } }>('/billing/invoices/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    return view(inv.id);
  });

  app.post('/billing/invoices', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'billing:manage');
    const input = createInvoiceSchema.parse(req.body);
    const cl = await assertClientAccess(db, auth, input.clientId);
    if (cl.archivedAt) throw new HttpError(409, 'العميل ده متأرشف', 'archived');
    let items = input.items ?? [];
    let currency: string = input.currency;
    if (input.packageId) {
      const p = await ownPackage(auth, input.packageId);
      items = [{ description: p.name, qty: 1, unitMinor: p.priceMinor }, ...items];
      currency = p.currency;
    }
    if (!items.length) throw new HttpError(400, 'ضيف بند واحد على الأقل', 'empty');
    const b = await billingOf(db, auth.agencyId);
    checkTotal(items, input.discountMinor, (input.vat ?? b.vatRegistered) ? b.vatRateBp : 0);
    const inv = await billing(() => createDraft(db, { agencyId: auth.agencyId, clientId: input.clientId, items, currency, discountMinor: input.discountMinor, vat: input.vat, dueOn: input.dueOn, notes: input.notes, createdById: auth.userId }));
    await audit(db, auth, 'invoice.create', 'Invoice', inv.id, { totalMinor: inv.totalMinor });
    if (input.issue) await billing(() => issueInvoice(db, inv.id, { pub }));
    return reply.status(201).send(await view(inv.id));
  });

  /** A draft can change freely. An issued invoice is frozen except for its ETA e-invoice id. */
  app.patch<{ Params: { id: string } }>('/billing/invoices/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    if (inv.status !== 'DRAFT') {
      // People paste the share link from the ETA portal as often as the bare UUID: take the id out of it.
      const etaId = z.string().trim().max(500).transform(s => s.match(/\/documents\/([A-Za-z0-9-]+)/)?.[1] ?? s).pipe(z.string().regex(/^[A-Za-z0-9-]{20,80}$/, 'رقم الفاتورة الإلكترونية (UUID) مش مظبوط'));
      const { etaUuid } = z.object({ etaUuid: etaId.nullable() }).strict().parse(req.body);
      await db.invoice.update({ where: { id: inv.id }, data: { etaUuid } });
      await audit(db, auth, 'invoice.eta', 'Invoice', inv.id, { etaUuid });
      return view(inv.id);
    }
    const input = draftSchema.partial().parse(req.body);
    const items = input.items ?? (inv.items as InvoiceItem[]);
    const b = await billingOf(db, auth.agencyId);
    if (input.vat && !b.vatRegistered) throw new HttpError(409, 'الوكالة مش مسجلة في ضريبة القيمة المضافة. سجّل رقمك الضريبي في الإعدادات الأول.', 'not_vat_registered');
    const vatBp = input.vat === undefined ? inv.vatRateBp : input.vat ? b.vatRateBp : 0;
    const t = checkTotal(items, input.discountMinor ?? inv.discountMinor, vatBp);
    const done = await db.invoice.updateMany({ where: { id: inv.id, status: 'DRAFT' }, data: {
      items, ...t, ...(input.dueOn !== undefined && { dueOn: input.dueOn }), ...(input.notes !== undefined && { notes: input.notes })
    } });
    if (!done.count) throw new HttpError(409, 'الفاتورة اتبعتت خلاص ومبقتش مسودة', 'not_draft');
    return view(inv.id);
  });

  app.delete<{ Params: { id: string } }>('/billing/invoices/:id', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    // Only a draft goes away; an issued one is voided so its number stays accounted for.
    const done = await db.invoice.deleteMany({ where: { id: inv.id, status: 'DRAFT' } });
    if (!done.count) throw new HttpError(409, 'الفاتورة اتبعتت. تقدر تلغيها بس، مش تمسحها.', 'not_draft');
    await audit(db, auth, 'invoice.delete', 'Invoice', inv.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/billing/invoices/:id/issue', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    const out = await billing(() => issueInvoice(db, inv.id, { pub }));
    await audit(db, auth, 'invoice.issue', 'Invoice', inv.id, { number: out.number, totalMinor: out.totalMinor });
    return view(inv.id);
  });

  app.post<{ Params: { id: string } }>('/billing/invoices/:id/void', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(2, 'اكتب سبب الإلغاء').max(300) }).parse(req.body);
    await billing(() => voidInvoice(db, inv.id, reason, { pub }));
    await audit(db, auth, 'invoice.void', 'Invoice', inv.id, { number: inv.number, reason });
    return view(inv.id);
  });

  app.post<{ Params: { id: string } }>('/billing/invoices/:id/payments', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'billing:manage');
    const inv = await ownInvoice(auth, req.params.id);
    const input = z.object({
      amountMinor: z.number().int().min(1).max(MAX_INVOICE_MINOR), method: z.enum(PAYMENT_METHODS), reference: z.string().trim().max(120).nullable().optional(),
      paidOn: daySchema.optional(), note: z.string().trim().max(300).nullable().optional()
    }).parse(req.body);
    const paidOn = input.paidOn ?? cairoToday();
    if (paidOn > cairoToday()) throw new HttpError(400, 'تاريخ الدفع في المستقبل', 'bad_date');
    await billing(() => addPayment(db, { invoiceId: inv.id, ...input, paidOn, reportedBy: 'agency', recordedById: auth.userId }, { pub }));
    await audit(db, auth, 'invoice.payment', 'Invoice', inv.id, { amountMinor: input.amountMinor, method: input.method });
    return view(inv.id);
  });

  app.post<{ Params: { id: string; decision: string } }>('/billing/payments/:id/:decision', async req => {
    const auth = requirePermission(req, 'billing:manage');
    const { decision } = z.object({ decision: z.enum(['confirm', 'reject']) }).parse(req.params);
    const pay = await db.invoicePayment.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { invoiceId: true, amountMinor: true, invoice: { select: { clientId: true } } } });
    if (!pay) throw new HttpError(404, 'الدفعة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, pay.invoice.clientId);
    await billing(() => decidePayment(db, req.params.id, decision, { pub, byId: auth.userId }));
    await audit(db, auth, `invoice.payment.${decision}`, 'Invoice', pay.invoiceId, { amountMinor: pay.amountMinor });
    return view(pay.invoiceId);
  });
};

const addDaysStr = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** What needs the agency on money: overdue invoices, payments clients reported, drafts waiting. */
export async function billingCounts(db: Db, agencyId: string) {
  const today = cairoToday();
  const base = { agencyId };
  const [overdue, unpaid, toCheck, drafts, open] = await Promise.all([
    db.invoice.count({ where: { ...base, ...overdueWhere(today) } }),
    db.invoice.count({ where: { ...base, status: 'ISSUED' } }),
    db.invoicePayment.count({ where: { ...base, state: 'PENDING', invoice: { status: 'ISSUED' } } }),
    db.invoice.count({ where: { ...base, status: 'DRAFT' } }),
    db.invoice.groupBy({ by: ['currency'], where: { ...base, status: 'ISSUED' }, _sum: { totalMinor: true, paidMinor: true } })
  ]);
  return { overdue, unpaid, toCheck, drafts, owed: open.map(o => ({ currency: o.currency, minor: (o._sum.totalMinor ?? 0) - (o._sum.paidMinor ?? 0) })) };
}

