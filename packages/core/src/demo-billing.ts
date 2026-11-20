import type { Db, Prisma } from '@dosly/db';
import { addMonths, dueDate, invoiceNumber, invoiceTotals, subscriptionPeriod, type PaymentMethod } from '@dosly/shared';
import { addPayment, cairoToday, periodLine } from './billing.js';
import type { Publisher } from './events.js';

/**
 * Demo billing: the agency's packages, each client on one, three months of paid invoices, and this
 * month's in four different states (paid, waiting, overdue, and a transfer the client reported).
 */

type Kind = 'cafe' | 'perfume' | 'clinic' | 'academy';
type Input = { agencyId: string; agencyName: string; ownerId: string; clients: { id: string; kind: Kind; name: string }[]; now: Date };

const PACKAGES = [
  { key: 'basic', name: 'الأساسية', priceMinor: 450_000, postsPerMonth: 8, description: 'للبيزنس اللي لسه بادئ على السوشيال', features: ['8 بوستات في الشهر', 'الرد على رسايل واتساب وماسنجر', 'تقرير شهري'] },
  { key: 'growth', name: 'النمو', priceMinor: 750_000, postsPerMonth: 12, description: 'الأكتر طلبًا', features: ['12 بوست + 4 ريلز في الشهر', 'الرد على الرسايل والكومنتات', 'إدارة إعلانات لحد 20 ألف جنيه', 'تقرير شهري'] },
  { key: 'full', name: 'الشاملة', priceMinor: 1_200_000, postsPerMonth: 20, description: 'كل حاجة علينا', features: ['20 بوست + 8 ريلز في الشهر', 'الرد على الرسايل والكومنتات طول اليوم', 'إدارة إعلانات من غير حد', 'متابعة طلبات المتجر بالتليفون', 'تقرير شهري ومكالمة متابعة'] },
  { key: 'shoot', name: 'جلسة تصوير منتجات', priceMinor: 350_000, postsPerMonth: null, description: 'مرة واحدة: 30 صورة متعدلة', features: ['30 صورة منتجات متعدلة', 'خلفية بيضا + صور لايف ستايل'], months: 0 }
] as const;

const CLIENT_SETUP: Record<Kind, { pkg: 'basic' | 'growth' | 'full'; daysAgo: number; now: 'paid' | 'open' | 'overdue' | 'reported'; legalName?: string; taxId?: string; address?: string }> = {
  cafe: { pkg: 'growth', daysAgo: 20, now: 'paid', legalName: 'شركة نسمة للمأكولات ش.ذ.م.م', taxId: '512345678', address: 'التجمع الخامس، القاهرة الجديدة' },
  perfume: { pkg: 'full', daysAgo: 2, now: 'open', legalName: 'لمسة للتجارة', taxId: '498765432', address: 'مدينة نصر، القاهرة' },
  clinic: { pkg: 'basic', daysAgo: 12, now: 'overdue' },
  academy: { pkg: 'growth', daysAgo: 4, now: 'reported', legalName: 'أكاديمية خطوة للتدريب', taxId: '301234567', address: 'سموحة، الإسكندرية' }
};

const METHODS: PaymentMethod[] = ['INSTAPAY', 'WALLET', 'BANK', 'INSTAPAY'];
const ref = () => String(Math.floor(1e11 + Math.random() * 9e11));
const at = (day: string, hour: number) => new Date(`${day}T${String(hour - 2).padStart(2, '0')}:00:00Z`); // Cairo hour (UTC+2) as an instant

export async function seedDemoBilling(tx: Prisma.TransactionClient, o: Input) {
  const today = cairoToday(o.now);
  const prefix = 'NOON';
  await tx.agencyBilling.create({ data: {
    agencyId: o.agencyId, legalName: 'نون للتسويق الرقمي ش.ذ.م.م', taxId: '123456789', commercialReg: '187654', address: 'شارع التسعين، التجمع الخامس، القاهرة', phone: '01001234567',
    vatRegistered: true, vatRateBp: 1400, invoicePrefix: prefix, dueDays: 7,
    instapay: 'noon.agency@instapay', instapayLink: 'https://ipn.eg/S/noon.agency/instapay/demo01', wallet: '01001234567', walletName: 'نادر سامي',
    bankName: 'البنك الأهلي المصري', bankAccountName: 'نون للتسويق الرقمي', iban: 'EG380003000100000000123456789',
    payNote: 'بعد ما تحوّل دوس "أنا حوّلت الفلوس" واكتب رقم العملية، وهنأكدلك خلال يوم عمل.'
  } });
  const pkgIds: Record<string, string> = {};
  for (const p of PACKAGES) {
    const { key, ...data } = p;
    const row = await tx.servicePackage.create({ data: { agencyId: o.agencyId, ...data, features: [...data.features], months: 'months' in p ? p.months : 1, createdAt: new Date(o.now.getTime() - 100 * 86400_000) } });
    pkgIds[key] = row.id;
  }

  type Draft = Omit<Prisma.InvoiceCreateManyInput, 'seq' | 'number'> & { _pay?: { method: PaymentMethod; paidOn: string; state: 'CONFIRMED' | 'PENDING'; reportedBy: 'agency' | 'client'; createdAt: Date } };
  const invoices: Draft[] = [];
  const seller = { name: 'نون للتسويق الرقمي ش.ذ.م.م', taxId: '123456789', commercialReg: '187654', address: 'شارع التسعين، التجمع الخامس، القاهرة', phone: '01001234567', vatRegistered: true };

  for (const c of o.clients) {
    const s = CLIENT_SETUP[c.kind];
    const pkg = PACKAGES.find(p => p.key === s.pkg)!;
    await tx.client.update({ where: { id: c.id }, data: { legalName: s.legalName ?? null, taxId: s.taxId ?? null, billingAddress: s.address ?? null } });
    // Started three periods before the current one, on the day the current period began.
    const currentFrom = addDaysStr(today, -s.daysAgo);
    const startOn = addMonths(currentFrom, -3);
    const sub = await tx.clientSubscription.create({ data: {
      agencyId: o.agencyId, clientId: c.id, packageId: pkgIds[s.pkg]!, name: `باقة ${pkg.name}`, priceMinor: pkg.priceMinor, currency: 'EGP', months: 1,
      startOn, cycles: 4, nextInvoiceOn: subscriptionPeriod(startOn, 1, 4).from, createdAt: at(startOn, 11)
    } });
    const buyer = { name: s.legalName ?? c.name, displayName: c.name, taxId: s.taxId ?? null, address: s.address ?? null };
    for (let cycle = 0; cycle < 4; cycle++) {
      const period = subscriptionPeriod(startOn, 1, cycle);
      const items = [{ description: periodLine(`باقة ${pkg.name}`, period.from, period.to), qty: 1, unitMinor: pkg.priceMinor }];
      const t = invoiceTotals(items, 0, 1400);
      const current = cycle === 3;
      const state = current ? s.now : 'paid';
      const paidOn = addDaysStr(period.from, 2 + (cycle % 3));
      invoices.push({
        agencyId: o.agencyId, clientId: c.id, subscriptionId: sub.id, status: state === 'paid' ? 'PAID' : 'ISSUED', currency: 'EGP',
        issueOn: period.from, dueOn: dueDate(period.from, 7), periodFrom: period.from, periodTo: period.to, items, ...t,
        paidMinor: state === 'paid' ? t.totalMinor : 0, seller, buyer, issuedAt: at(period.from, 9), paidAt: state === 'paid' ? at(paidOn, 14) : null,
        viewedAt: state === 'open' && c.kind === 'perfume' ? new Date(o.now.getTime() - 20 * 3600_000) : at(period.from, 13),
        etaUuid: state === 'paid' && cycle < 2 && s.taxId ? `${ref()}${ref()}${ref()}`.slice(0, 32).toUpperCase() : null,
        createdAt: at(period.from, 9),
        _pay: state === 'paid' ? { method: METHODS[cycle % METHODS.length]!, paidOn, state: 'CONFIRMED', reportedBy: cycle % 2 ? 'client' : 'agency', createdAt: at(paidOn, 14) }
          : state === 'reported' ? { method: 'INSTAPAY', paidOn: today, state: 'PENDING', reportedBy: 'client', createdAt: new Date(o.now.getTime() - 50 * 60_000) } : undefined
      });
    }
  }

  // Numbered in the order they were issued, like the real counter would have.
  invoices.sort((a, b) => String(a.issueOn).localeCompare(String(b.issueOn)));
  let seq = 0;
  for (const { _pay, ...inv } of invoices) {
    seq++;
    const row = await tx.invoice.create({ data: { ...inv, seq, number: invoiceNumber(prefix, inv.issueOn!, seq) } as Prisma.InvoiceUncheckedCreateInput });
    if (_pay) await tx.invoicePayment.create({ data: {
      agencyId: o.agencyId, invoiceId: row.id, amountMinor: inv.totalMinor, method: _pay.method, reference: _pay.method === 'CASH' ? null : ref(), paidOn: _pay.paidOn,
      state: _pay.state, reportedBy: _pay.reportedBy, recordedById: _pay.state === 'CONFIRMED' ? o.ownerId : null, decidedAt: _pay.state === 'CONFIRMED' ? _pay.createdAt : null, createdAt: _pay.createdAt
    } });
  }
  await tx.agencyBilling.update({ where: { agencyId: o.agencyId }, data: { nextNumber: seq + 1 } });

  // A one-time photo shoot for the perfume shop, still a draft.
  const perfume = o.clients.find(c => c.kind === 'perfume');
  if (perfume) {
    const items = [{ description: 'جلسة تصوير منتجات: 30 صورة متعدلة', qty: 1, unitMinor: 350_000 }];
    await tx.invoice.create({ data: { agencyId: o.agencyId, clientId: perfume.id, status: 'DRAFT', currency: 'EGP', items, ...invoiceTotals(items, 0, 1400), createdById: o.ownerId, notes: 'التصوير يوم الخميس الجاي في المقر.' } });
  }
}

const addDaysStr = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Demo: a client says they paid one of their open invoices by InstaPay, as if they pressed "أنا دفعت" in the portal. */
export async function simulateClientPayment(db: Db, pub: Publisher, agencyId: string) {
  const open = await db.invoice.findMany({ where: { agencyId, status: 'ISSUED', payments: { none: { state: 'PENDING' } } }, orderBy: { dueOn: 'asc' }, select: { id: true, totalMinor: true, paidMinor: true }, take: 5 });
  const inv = open[Math.floor(Math.random() * open.length)];
  if (!inv) return null;
  const user = await db.clientUser.findFirst({ where: { agencyId, client: { invoices: { some: { id: inv.id } } } }, select: { id: true } });
  await addPayment(db, { invoiceId: inv.id, amountMinor: inv.totalMinor - inv.paidMinor, method: Math.random() < 0.7 ? 'INSTAPAY' : 'WALLET', reference: ref(), paidOn: cairoToday(), reportedBy: 'client', clientUserId: user?.id ?? null }, { pub });
  return inv.id;
}
