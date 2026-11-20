import type { Db, Prisma } from '@dosly/db';
import { dayIn, dueDate, invoiceNumber, invoiceTotals, MAX_INVOICE_MINOR, subscriptionPeriod, type InvoiceItem, type PaymentMethod } from '@dosly/shared';
import type { Publisher } from './events.js';

/**
 * Agency billing: invoices from an agency to its clients, recurring package invoices and payments.
 * Invoice numbers come from a per-agency counter that only moves inside the issuing transaction, so
 * they are unique and have no holes (a voided invoice keeps its number).
 */

export const BILLING_TZ = 'Africa/Cairo';
export const cairoToday = (at = new Date()) => dayIn(BILLING_TZ, at);

export class BillingError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type Tx = Prisma.TransactionClient;

/** The agency's billing row, created with defaults the first time anyone needs it. */
export async function billingOf(db: Db | Tx, agencyId: string) {
  // createMany + skipDuplicates is ON CONFLICT DO NOTHING: safe when several requests arrive at once.
  const found = await db.agencyBilling.findUnique({ where: { agencyId } });
  if (found) return found;
  await db.agencyBilling.createMany({ data: [{ agencyId }], skipDuplicates: true });
  return db.agencyBilling.findUniqueOrThrow({ where: { agencyId } });
}

const DAY_AR = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const dayAr = (day: string) => DAY_AR.format(new Date(`${day}T00:00:00Z`));

/** "باقة النمو: من 1 ديسمبر 2026 لـ 31 ديسمبر 2026" */
export const periodLine = (name: string, from: string, to: string) => `${name}: من ${dayAr(from)} لـ ${dayAr(to)}`;

async function lockInvoice(tx: Tx, id: string) {
  // Payments on one invoice are applied one at a time, so two at once can't both miss each other.
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
}

/**
 * Numbers a draft and freezes it: both parties' details are copied in, and from now on the client
 * sees it in the portal. Safe to call twice: only one call can move a draft.
 */
export async function issueInvoice(db: Db, invoiceId: string, opts: { now?: Date; pub?: Publisher } = {}) {
  const now = opts.now ?? new Date();
  const today = cairoToday(now);
  const draft = await db.invoice.findUnique({ where: { id: invoiceId }, select: { agencyId: true } });
  if (!draft) throw new BillingError('not_found', 'الفاتورة مش موجودة');
  await billingOf(db, draft.agencyId);
  const issued = await db.$transaction(async tx => {
    await lockInvoice(tx, invoiceId);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { client: true, agency: { select: { name: true } } } });
    if (inv.status !== 'DRAFT') throw new BillingError('not_draft', 'الفاتورة دي اتبعتت قبل كده');
    const items = inv.items as InvoiceItem[];
    if (!items.length || inv.totalMinor <= 0) throw new BillingError('empty', 'الفاتورة فاضية. ضيف بند بمبلغ الأول.');
    // The counter row is locked by this update until the transaction ends, so numbers never repeat.
    const b = await tx.agencyBilling.update({ where: { agencyId: inv.agencyId }, data: { nextNumber: { increment: 1 } } });
    const seq = b.nextNumber - 1;
    const dueOn = inv.dueOn && inv.dueOn >= today ? inv.dueOn : dueDate(today, b.dueDays);
    const seller = { name: b.legalName ?? inv.agency.name, taxId: b.taxId, commercialReg: b.commercialReg, address: b.address, phone: b.phone, vatRegistered: b.vatRegistered };
    const buyer = { name: inv.client.legalName ?? inv.client.name, displayName: inv.client.name, taxId: inv.client.taxId, address: inv.client.billingAddress };
    return tx.invoice.update({ where: { id: inv.id }, data: {
      status: 'ISSUED', seq, number: invoiceNumber(b.invoicePrefix, today, seq), issueOn: today, dueOn, issuedAt: now, seller, buyer
    } });
  });
  await opts.pub?.publish(issued.agencyId, { type: 'invoice.updated', invoiceId: issued.id, clientId: issued.clientId });
  return issued;
}

export type DraftInput = {
  agencyId: string; clientId: string; items: InvoiceItem[]; currency: string; discountMinor?: number; vat?: boolean;
  dueOn?: string | null; notes?: string | null; createdById?: string | null; subscriptionId?: string | null; periodFrom?: string | null; periodTo?: string | null;
};

/** A new draft. VAT follows the agency's settings unless the caller says otherwise. */
export async function createDraft(db: Db | Tx, input: DraftInput) {
  const b = await billingOf(db, input.agencyId);
  if (input.vat && !b.vatRegistered) throw new BillingError('not_vat_registered', 'الوكالة مش مسجلة في ضريبة القيمة المضافة. سجّل رقمك الضريبي في الإعدادات الأول.');
  const vat = input.vat ?? b.vatRegistered;
  const t = invoiceTotals(input.items, input.discountMinor ?? 0, vat ? b.vatRateBp : 0);
  if (t.subtotalMinor > MAX_INVOICE_MINOR || t.totalMinor > MAX_INVOICE_MINOR) throw new BillingError('too_large', 'إجمالي الفاتورة كبير أوي. قسّمها على أكتر من فاتورة.');
  return db.invoice.create({ data: {
    agencyId: input.agencyId, clientId: input.clientId, currency: input.currency, items: input.items, ...t,
    dueOn: input.dueOn ?? null, notes: input.notes ?? null, createdById: input.createdById ?? null,
    subscriptionId: input.subscriptionId ?? null, periodFrom: input.periodFrom ?? null, periodTo: input.periodTo ?? null
  } });
}

/**
 * Recurring package invoices. Each active subscription whose next period has started gets one invoice
 * for it: the subscription is claimed by moving its cycle counter (a second run, or a second worker,
 * finds the counter already moved), and the invoice is unique per subscription and period. Runs hourly;
 * a subscription behind by several periods catches up one period per run.
 */
export async function generateDueInvoices(db: Db, opts: { now?: Date; pub?: Publisher; limit?: number; subscriptionId?: string; onError?: (subscriptionId: string, err: unknown) => void } = {}) {
  const now = opts.now ?? new Date();
  const today = cairoToday(now);
  const due = await db.clientSubscription.findMany({
    where: {
      ...(opts.subscriptionId && { id: opts.subscriptionId }), status: 'ACTIVE', nextInvoiceOn: { lte: today }, client: { archivedAt: null },
      // Only agencies that can work: not suspended, trial not over, Dosly subscription not lapsed past its grace week.
      agency: { status: 'ACTIVE', OR: [
        { plan: 'TRIAL', OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: now } }] },
        { plan: { not: 'TRIAL' }, OR: [{ paidUntil: null }, { paidUntil: { gt: new Date(now.getTime() - 7 * 86400_000) } }] }
      ] }
    },
    orderBy: { nextInvoiceOn: 'asc' }, take: opts.limit ?? 200
  });
  let created = 0, issued = 0;
  for (const s of due) {
    // Periods that ended entirely while nothing ran (the agency was suspended, the worker was down) are
    // skipped, not billed in a burst: only the current period gets an invoice.
    const cycle = cyclesToSkip(s.startOn, s.months, s.cycles, today);
    const period = subscriptionPeriod(s.startOn, s.months, cycle);
    let invoice;
    try { invoice = await db.$transaction(async tx => {
      const claimed = await tx.clientSubscription.updateMany({
        where: { id: s.id, cycles: s.cycles, status: 'ACTIVE' },
        data: { cycles: cycle + 1, nextInvoiceOn: subscriptionPeriod(s.startOn, s.months, cycle + 1).from }
      });
      if (!claimed.count) return null;
      const exists = await tx.invoice.findFirst({ where: { subscriptionId: s.id, periodFrom: period.from }, select: { id: true } });
      if (exists) return null;
      return createDraft(tx, {
        agencyId: s.agencyId, clientId: s.clientId, currency: s.currency, subscriptionId: s.id, periodFrom: period.from, periodTo: period.to,
        items: [{ description: periodLine(s.name, period.from, period.to), qty: 1, unitMinor: s.priceMinor }]
      });
    }); } catch (err) {
      // One bad subscription never stops the others; it is retried next run.
      opts.onError?.(s.id, err);
      continue;
    }
    if (!invoice) continue;
    created++;
    const b = await billingOf(db, s.agencyId);
    if (b.autoIssue && invoice.totalMinor > 0) {
      try { await issueInvoice(db, invoice.id, { now, pub: opts.pub }); issued++; } catch { /* stays a draft for the agency to look at */ }
    } else await opts.pub?.publish(s.agencyId, { type: 'invoice.updated', invoiceId: invoice.id, clientId: s.clientId });
  }
  return { created, issued };
}

/** Moves a paused subscription past the periods it was paused for, so resuming never bills them. */
export function cyclesToSkip(startOn: string, months: number, cycles: number, today: string) {
  let c = cycles;
  while (subscriptionPeriod(startOn, months, c).to < today) c++;
  return c;
}

/** Recomputes what was paid from the confirmed payments and settles the status. Caller holds the lock. */
async function settle(tx: Tx, invoiceId: string, now: Date) {
  const sum = await tx.invoicePayment.aggregate({ where: { invoiceId, state: 'CONFIRMED' }, _sum: { amountMinor: true } });
  const paid = sum._sum.amountMinor ?? 0;
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const full = paid >= inv.totalMinor;
  // Fully paid: transfers the client reported and nobody checked are no longer needed.
  if (full) await tx.invoicePayment.updateMany({ where: { invoiceId, state: 'PENDING' }, data: { state: 'REJECTED', decidedAt: now, note: 'superseded' } });
  return tx.invoice.update({ where: { id: invoiceId }, data: {
    paidMinor: paid,
    ...(inv.status === 'ISSUED' && full ? { status: 'PAID', paidAt: now } : {}),
    ...(inv.status === 'PAID' && !full ? { status: 'ISSUED', paidAt: null } : {})
  } });
}

export type PaymentInput = {
  invoiceId: string; amountMinor: number; method: PaymentMethod; reference?: string | null; paidOn: string; note?: string | null;
  reportedBy: 'agency' | 'client'; recordedById?: string | null; clientUserId?: string | null;
};

/**
 * Records money against an issued invoice. From the agency it counts at once; from the client it waits
 * as PENDING until the agency checks its bank or wallet and confirms it.
 */
export async function addPayment(db: Db, p: PaymentInput, opts: { now?: Date; pub?: Publisher } = {}) {
  const now = opts.now ?? new Date();
  const out = await db.$transaction(async tx => {
    await lockInvoice(tx, p.invoiceId);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: p.invoiceId } });
    if (inv.status !== 'ISSUED') throw new BillingError('not_open', inv.status === 'PAID' ? 'الفاتورة دي اتدفعت بالكامل' : 'الفاتورة دي مش مستنية دفع');
    const left = inv.totalMinor - inv.paidMinor;
    if (p.amountMinor <= 0 || p.amountMinor > left) throw new BillingError('bad_amount', 'المبلغ أكبر من الباقي على الفاتورة');
    if (p.reportedBy === 'client' && await tx.invoicePayment.count({ where: { invoiceId: inv.id, state: 'PENDING' } }) >= 3) {
      throw new BillingError('too_many', 'فيه تحويلات لسه الوكالة بتراجعها. استنى ردهم الأول.');
    }
    const payment = await tx.invoicePayment.create({ data: {
      agencyId: inv.agencyId, invoiceId: inv.id, amountMinor: p.amountMinor, method: p.method, reference: p.reference ?? null, paidOn: p.paidOn,
      note: p.note ?? null, reportedBy: p.reportedBy, state: p.reportedBy === 'agency' ? 'CONFIRMED' : 'PENDING',
      recordedById: p.recordedById ?? null, clientUserId: p.clientUserId ?? null, decidedAt: p.reportedBy === 'agency' ? now : null
    } });
    const invoice = p.reportedBy === 'agency' ? await settle(tx, inv.id, now) : inv;
    return { payment, invoice };
  });
  await opts.pub?.publish(out.invoice.agencyId, { type: 'invoice.updated', invoiceId: out.invoice.id, clientId: out.invoice.clientId });
  return out;
}

/** The agency checked a payment the client reported: it arrived (confirm) or it didn't (reject). */
export async function decidePayment(db: Db, paymentId: string, decision: 'confirm' | 'reject', opts: { now?: Date; pub?: Publisher; byId?: string } = {}) {
  const now = opts.now ?? new Date();
  const found = await db.invoicePayment.findUnique({ where: { id: paymentId }, select: { invoiceId: true } });
  if (!found) throw new BillingError('not_found', 'الدفعة مش موجودة');
  const invoice = await db.$transaction(async tx => {
    await lockInvoice(tx, found.invoiceId);
    const pay = await tx.invoicePayment.findUniqueOrThrow({ where: { id: paymentId }, include: { invoice: true } });
    if (pay.state !== 'PENDING') throw new BillingError('decided', 'الدفعة دي اتراجعت قبل كده');
    if (decision === 'confirm') {
      if (pay.invoice.status !== 'ISSUED') throw new BillingError('not_open', 'الفاتورة دي مش مستنية دفع');
      if (pay.amountMinor > pay.invoice.totalMinor - pay.invoice.paidMinor) throw new BillingError('bad_amount', 'المبلغ أكبر من الباقي على الفاتورة. سجّل المبلغ الصح يدوي.');
    }
    await tx.invoicePayment.update({ where: { id: pay.id }, data: { state: decision === 'confirm' ? 'CONFIRMED' : 'REJECTED', decidedAt: now, recordedById: opts.byId ?? null } });
    return settle(tx, pay.invoiceId, now);
  });
  await opts.pub?.publish(invoice.agencyId, { type: 'invoice.updated', invoiceId: invoice.id, clientId: invoice.clientId });
  return invoice;
}

/** Cancels an issued invoice. It keeps its number; confirmed money stays recorded against it. */
export async function voidInvoice(db: Db, invoiceId: string, reason: string, opts: { now?: Date; pub?: Publisher } = {}) {
  const now = opts.now ?? new Date();
  const inv = await db.$transaction(async tx => {
    await lockInvoice(tx, invoiceId);
    const cur = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    if (cur.status !== 'ISSUED') throw new BillingError('not_open', cur.status === 'PAID' ? 'الفاتورة اتدفعت، مينفعش تتلغي' : 'الفاتورة دي مش مفتوحة');
    if (cur.paidMinor > 0) throw new BillingError('has_payments', 'على الفاتورة دي فلوس اتدفعت. رجّع الفلوس للعميل الأول أو سيبها مفتوحة.');
    await tx.invoicePayment.updateMany({ where: { invoiceId, state: 'PENDING' }, data: { state: 'REJECTED', decidedAt: now } });
    return tx.invoice.update({ where: { id: invoiceId }, data: { status: 'VOID', voidedAt: now, voidReason: reason } });
  });
  await opts.pub?.publish(inv.agencyId, { type: 'invoice.updated', invoiceId: inv.id, clientId: inv.clientId });
  return inv;
}

/** Unpaid issued invoices whose due day has passed (Cairo). */
export const overdueWhere = (today: string) => ({ status: 'ISSUED' as const, dueOn: { lt: today } });
