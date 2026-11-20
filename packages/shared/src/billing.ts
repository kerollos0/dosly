import { z } from 'zod';

/**
 * Agency billing: packages an agency sells its clients, invoices and payments. Money is in minor
 * units (piastres for EGP). Days are YYYY-MM-DD strings in Cairo, like the ads and the "today" page.
 *
 * Egypt notes (research/billing.md): VAT is 14%; a VAT-registered agency must also submit every B2B
 * invoice to the Tax Authority's e-invoicing system (ETA), which needs a signing certificate. Dosly does
 * not submit to the ETA yet: the agency issues there and pastes the ETA UUID on the invoice.
 */

export const BILLING_CURRENCIES = ['EGP', 'USD', 'SAR', 'AED', 'EUR'] as const;
export const PACKAGE_PERIODS = [0, 1, 3, 6, 12] as const; // 0 = one-time
export const PAYMENT_METHODS = ['INSTAPAY', 'WALLET', 'BANK', 'CASH', 'PAYPAL', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Highest invoice total: comfortably inside a 32-bit integer of piastres (about 20 million EGP). */
export const MAX_INVOICE_MINOR = 2_000_000_000;
const MAX_UNIT_MINOR = 1_000_000_000;
/** A package or subscription price: low enough that price + VAT (at most 30%) still fits one invoice. */
export const MAX_PRICE_MINOR = 1_500_000_000;

export const invoiceItemSchema = z.object({
  description: z.string().trim().min(1, 'اكتب وصف البند').max(300),
  qty: z.number().int().min(1).max(1000),
  unitMinor: z.number().int().min(0).max(MAX_UNIT_MINOR)
});
export type InvoiceItem = z.infer<typeof invoiceItemSchema>;

export type InvoiceTotals = { subtotalMinor: number; discountMinor: number; vatRateBp: number; vatMinor: number; totalMinor: number };

/**
 * The invoice discount is spread over the lines in proportion to their amounts (largest remainder, so
 * the parts add up exactly), and VAT is computed per line on what is left and rounded half up to the
 * piastre, then summed. That is how the ETA e-invoice computes it (per-line tax, discount before tax as
 * item discounts), so re-keying the invoice on the ETA portal gives the same total.
 */
export function lineDiscounts(amounts: number[], discount: number): number[] {
  const total = amounts.reduce((s, a) => s + a, 0);
  if (!discount || !total) return amounts.map(() => 0);
  const exact = amounts.map(a => (a * discount) / total);
  const parts = exact.map(Math.floor);
  let left = discount - parts.reduce((s, p) => s + p, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; parts[i]!++; left--; }
  return parts;
}

export function invoiceTotals(items: InvoiceItem[], discountMinor = 0, vatRateBp = 0): InvoiceTotals {
  const amounts = items.map(i => i.qty * i.unitMinor);
  const subtotalMinor = amounts.reduce((s, a) => s + a, 0);
  const discount = Math.min(Math.max(0, Math.trunc(discountMinor)), subtotalMinor);
  const rate = vatRateBp > 0 ? vatRateBp : 0;
  const cuts = lineDiscounts(amounts, discount);
  const vatMinor = rate ? amounts.reduce((s, a, k) => s + Math.floor(((a - cuts[k]!) * rate + 5000) / 10000), 0) : 0;
  return { subtotalMinor, discountMinor: discount, vatRateBp: rate, vatMinor, totalMinor: subtotalMinor - discount + vatMinor };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const daySchema = z.string().regex(DAY, 'التاريخ مش مظبوط').refine(d => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'التاريخ مش مظبوط');

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Adds whole months to a day, keeping the day of month or the month's last day (Jan 31 + 1 = Feb 28). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = total % 12;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

const shiftDay = (day: string, n: number) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/**
 * The service period of a subscription's cycle (0 = the first). Always counted from the start day,
 * never from the previous period, so a client who started on the 31st stays billed at month end.
 */
export function subscriptionPeriod(startOn: string, months: number, cycle: number) {
  const from = addMonths(startOn, cycle * months);
  const to = shiftDay(addMonths(startOn, (cycle + 1) * months), -1);
  return { from, to };
}

export const dueDate = (issueOn: string, dueDays: number) => shiftDay(issueOn, dueDays);

/** INV-2026-0007: the agency's prefix, the year it was issued, and its sequence number. */
export const invoiceNumber = (prefix: string, issueOn: string, seq: number) => `${prefix}-${issueOn.slice(0, 4)}-${String(seq).padStart(4, '0')}`;

// ---------- the agency's details and payment methods ----------

const optional = (s: z.ZodString) => z.union([s, z.literal('').transform(() => null), z.null()]).optional();
const text = (max: number) => optional(z.string().trim().min(1).max(max));

/** Egyptian tax registration number: 9 digits, often written with dashes (123-456-789). */
export const egyptTaxId = z.string().trim().transform(s => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{9}$/, 'رقم التسجيل الضريبي 9 أرقام'));
/** An Egyptian mobile number: 11 digits starting 010, 011, 012 or 015; +20 and spaces are fine. */
export const egyptMobile = z.string().trim().transform(s => {
  const d = s.replace(/[^\d]/g, '');
  return d.startsWith('20') && d.length === 12 ? `0${d.slice(2)}` : d;
}).pipe(z.string().regex(/^01[0125]\d{8}$/, 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 010 أو 011 أو 012 أو 015'));
/** InstaPay: a payment address like name@instapay, or the mobile number on the account. */
export const instapayAddress = z.string().trim().toLowerCase().refine(s => /^[a-z0-9._-]{2,40}@instapay$/.test(s) || egyptMobile.safeParse(s).success, 'اكتب عنوان InstaPay زي name@instapay أو رقم الموبايل');
/** Only real InstaPay links (exactly ipn.eg), so a look-alike phishing domain can't be saved. */
export const instapayLink = z.url({ protocol: /^https$/, hostname: /^ipn\.eg$/ , error: 'لينك InstaPay لازم يبدأ بـ https://ipn.eg/' }).max(300);
export const paypalLink = z.url({ protocol: /^https$/, hostname: /^(www\.)?(paypal\.me|paypal\.com)$/, error: 'لينك PayPal لازم يكون paypal.me أو paypal.com' }).max(300);
/** Egyptian IBAN: EG + 27 digits (29 characters). Spaces are fine. */
export const egyptIban = z.string().trim().toUpperCase().transform(s => s.replace(/\s/g, '')).pipe(z.string().regex(/^EG\d{27}$/, 'الـ IBAN المصري بيبدأ بـ EG وبعده 27 رقم'));

export const billingSettingsSchema = z.object({
  legalName: text(160),
  taxId: z.union([egyptTaxId, z.literal('').transform(() => null), z.null()]).optional(),
  commercialReg: text(40),
  address: text(300),
  phone: text(30),
  vatRegistered: z.boolean().optional(),
  vatRateBp: z.number().int().min(0).max(3000).optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'البادئة من 1 لـ 8 حروف إنجليزي أو أرقام').optional(),
  dueDays: z.number().int().min(0).max(90).optional(),
  autoIssue: z.boolean().optional(),
  instapay: z.union([instapayAddress, z.literal('').transform(() => null), z.null()]).optional(),
  instapayLink: z.union([instapayLink, z.literal('').transform(() => null), z.null()]).optional(),
  wallet: z.union([egyptMobile, z.literal('').transform(() => null), z.null()]).optional(),
  walletName: text(80),
  bankName: text(80),
  bankAccountName: text(120),
  iban: z.union([egyptIban, z.literal('').transform(() => null), z.null()]).optional(),
  paypalLink: z.union([paypalLink, z.literal('').transform(() => null), z.null()]).optional(),
  payNote: text(500)
}); // "VAT needs a tax id" is checked on the saved result, since a request may change only one of them
export type BillingSettingsInput = z.infer<typeof billingSettingsSchema>;

export const clientBillingSchema = z.object({
  legalName: text(160),
  taxId: z.union([egyptTaxId, z.literal('').transform(() => null), z.null()]).optional(),
  billingAddress: text(300)
});

const periodSchema = z.union(PACKAGE_PERIODS.map(p => z.literal(p)) as unknown as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<6>, z.ZodLiteral<12>]);
/** An edit: no defaults, so a field left out keeps its saved value (zod applies defaults even inside .partial()). */
export const packagePatchSchema = z.object({
  name: z.string().trim().min(1, 'اكتب اسم الباقة').max(80),
  description: text(300),
  features: z.array(z.string().trim().min(1).max(120)).max(15),
  priceMinor: z.number().int().min(0).max(MAX_PRICE_MINOR),
  currency: z.enum(BILLING_CURRENCIES),
  months: periodSchema,
  postsPerMonth: z.number().int().min(0).max(500).nullable().optional()
}).partial();
export const packageSchema = packagePatchSchema.required({ name: true, priceMinor: true }).extend({
  features: z.array(z.string().trim().min(1).max(120)).max(15).default([]),
  currency: z.enum(BILLING_CURRENCIES).default('EGP'),
  months: periodSchema.default(1)
});

/** Payment details exactly as a client sees them, in the order Egyptians usually pay. */
export type PayMethods = {
  instapay: string | null; instapayLink: string | null; wallet: string | null; walletName: string | null;
  bankName: string | null; bankAccountName: string | null; iban: string | null; paypalLink: string | null; payNote: string | null;
};
export const hasPayMethod = (p: PayMethods) => !!(p.instapay || p.instapayLink || p.wallet || p.iban || p.paypalLink);

export const PAYMENT_METHOD_AR: Record<PaymentMethod, string> = {
  INSTAPAY: 'InstaPay', WALLET: 'محفظة موبايل (فودافون كاش وغيرها)', BANK: 'تحويل بنكي', CASH: 'كاش', PAYPAL: 'PayPal', OTHER: 'طريقة تانية'
};
