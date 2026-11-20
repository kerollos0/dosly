/** Agency billing: types and plain-Arabic labels. Money is in minor units (piastres), like the ads. */

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
export type PaymentMethod = 'INSTAPAY' | 'WALLET' | 'BANK' | 'CASH' | 'PAYPAL' | 'OTHER';
export type InvoiceItem = { description: string; qty: number; unitMinor: number };
export type Payment = {
  id: string; amountMinor: number; method: PaymentMethod; reference: string | null; paidOn: string; state: 'PENDING' | 'CONFIRMED' | 'REJECTED';
  reportedBy: 'agency' | 'client'; note: string | null; createdAt: string; decidedAt: string | null;
};
export type Party = { name: string; displayName?: string; taxId: string | null; commercialReg?: string | null; address: string | null; phone?: string | null; vatRegistered?: boolean };
export type Invoice = {
  id: string; clientId: string; subscriptionId: string | null; number: string | null; status: InvoiceStatus; currency: string;
  issueOn: string | null; dueOn: string | null; periodFrom: string | null; periodTo: string | null; items: InvoiceItem[];
  subtotalMinor: number; discountMinor: number; vatRateBp: number; vatMinor: number; totalMinor: number; paidMinor: number; notes: string | null;
  seller: Party | null; buyer: Party | null; etaUuid: string | null; issuedAt: string | null; paidAt: string | null; voidedAt: string | null; voidReason: string | null;
  viewedAt: string | null; createdAt: string; client: { name: string }; payments: Payment[]; overdue: boolean; pendingPayments: number;
};
export type PayMethods = {
  instapay: string | null; instapayLink: string | null; wallet: string | null; walletName: string | null;
  bankName: string | null; bankAccountName: string | null; iban: string | null; paypalLink: string | null; payNote: string | null;
};
export type BillingSettings = PayMethods & {
  legalName: string | null; taxId: string | null; commercialReg: string | null; address: string | null; phone: string | null;
  vatRegistered: boolean; vatRateBp: number; invoicePrefix: string; nextNumber: number; dueDays: number; autoIssue: boolean;
};
export type Package = {
  id: string; name: string; description: string | null; features: string[]; priceMinor: number; currency: string; months: number;
  postsPerMonth: number | null; archivedAt: string | null; clients: number;
};
export type Subscription = {
  id: string; clientId: string; client: { name: string }; packageId: string | null; name: string; priceMinor: number; currency: string; months: number;
  startOn: string; nextInvoiceOn: string | null; status: 'ACTIVE' | 'PAUSED' | 'ENDED'; cycles: number;
};
export type BillingClient = {
  id: string; name: string; legalName: string | null; taxId: string | null; billingAddress: string | null;
  subscriptions: Subscription[]; owed: { currency: string; minor: number; overdue: number }[];
};
export type BillingCounts = { overdue: number; unpaid: number; toCheck: number; drafts: number; owed: { currency: string; minor: number }[] };

const EXACT = new Intl.NumberFormat('ar-EG-u-nu-latn', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 0 });
const WORD: Record<string, string> = { EGP: 'جنيه', USD: 'دولار', SAR: 'ريال', AED: 'درهم', EUR: 'يورو' };
/** Money on an invoice: never rounded. "1,500.50 جنيه", or "1,500 جنيه" when there are no piastres. */
export function exact(minor: number, currency: string) {
  const v = minor / 100;
  return `\u2068${(minor % 100 ? EXACT : WHOLE).format(v)} ${WORD[currency] ?? currency}\u2069`;
}

/** The client's last report was checked and the money wasn't found (and nothing newer is waiting). */
export const lastReportRejected = (i: Pick<Invoice, 'payments' | 'status'>) => {
  const mine = i.payments.filter(p => p.reportedBy === 'client');
  return i.status === 'ISSUED' && mine.at(-1)?.state === 'REJECTED' && mine.at(-1)?.note !== 'superseded';
};

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'sun';

/** One short status for an invoice, the way the agency talks about it. */
export function invoiceState(i: Pick<Invoice, 'status' | 'overdue' | 'paidMinor' | 'pendingPayments'>, client = false): { label: string; tone: Tone } {
  if (i.status === 'DRAFT') return { label: 'مسودة', tone: 'neutral' };
  if (i.status === 'VOID') return { label: 'اتلغت', tone: 'neutral' };
  if (i.status === 'PAID') return { label: 'اتدفعت', tone: 'good' };
  if (i.pendingPayments) return { label: client ? 'الوكالة بتراجع التحويل' : 'العميل قال إنه دفع', tone: 'sun' };
  if (i.overdue) return { label: i.paidMinor ? 'متأخرة (اتدفع جزء)' : 'متأخرة', tone: 'bad' };
  return { label: i.paidMinor ? 'اتدفع جزء منها' : 'مستنية الدفع', tone: 'info' };
}

export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  INSTAPAY: 'InstaPay', WALLET: 'محفظة موبايل', BANK: 'تحويل بنكي', CASH: 'كاش', PAYPAL: 'PayPal', OTHER: 'طريقة تانية'
};

export const PERIOD: Record<number, string> = { 0: 'مرة واحدة', 1: 'كل شهر', 3: 'كل 3 شهور', 6: 'كل 6 شهور', 12: 'كل سنة' };
export const PERIOD_SHORT: Record<number, string> = { 0: '', 1: 'في الشهر', 3: 'كل 3 شهور', 6: 'كل 6 شهور', 12: 'في السنة' };

const DAY = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
/** "21 نوفمبر 2026" for a YYYY-MM-DD day. */
export const day = (d: string | null) => (d ? DAY.format(new Date(`${d}T00:00:00Z`)) : '—');

/** Whole days from today (Cairo) to a day: negative when it has passed. */
export function daysUntil(d: string, today: string) {
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Pounds typed by a person ("1,250.5" or "١٢٥٠") to piastres, or null when it isn't a number. */
export function toMinor(v: string): number | null {
  const s = v.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,،\s]/g, '').replace('٫', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
export const fromMinor = (m: number) => (m / 100).toString();

/**
 * Client-side copy of the server's rule (packages/shared/src/billing.ts) for the live total while typing:
 * the discount is spread over the lines and VAT is rounded per line. The server recomputes it.
 */
export function totals(items: InvoiceItem[], discountMinor: number, vatRateBp: number) {
  const amounts = items.map(i => i.qty * i.unitMinor);
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const discount = Math.min(Math.max(0, Math.trunc(discountMinor)), subtotal);
  let vat = 0;
  if (vatRateBp > 0) {
    const exact = amounts.map(a => (subtotal ? (a * discount) / subtotal : 0));
    const cuts = exact.map(Math.floor);
    let left = discount - cuts.reduce((s, c) => s + c, 0);
    for (const [, i] of exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1])) { if (left <= 0) break; cuts[i]!++; left--; }
    vat = amounts.reduce((s, a, k) => s + Math.floor(((a - cuts[k]!) * vatRateBp + 5000) / 10000), 0);
  }
  return { subtotal, discount, vat, total: subtotal - discount + vat };
}
