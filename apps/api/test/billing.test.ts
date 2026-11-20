import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addPayment, cairoToday, generateDueInvoices, issueInvoice } from '@dosly/core';
import { addMonths, subscriptionPeriod } from '@dosly/shared';
import { db, makeApp, owner, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

type App = Awaited<ReturnType<typeof makeApp>>['app'];

async function setup() {
  const { app, calls } = await makeApp();
  const own = await owner(app);
  const client = (await own('POST', '/api/clients', { name: 'كافيه نسمة' })).json();
  const settings = await own('PUT', '/api/billing/settings', { legalName: 'نون للتسويق', taxId: '123-456-789', vatRegistered: true, invoicePrefix: 'noon', instapay: 'Noon@InstaPay', wallet: '+20 100 123 4567' });
  if (settings.statusCode !== 200) throw new Error(settings.body);
  const pkg = (await own('POST', '/api/billing/packages', { name: 'النمو', priceMinor: 750_000, months: 1, features: ['12 بوست', 'إدارة الإعلانات'] })).json();
  // A paying agency, so runs "months later" aren't stopped by the 14-day trial ending.
  await db.agency.updateMany({ data: { plan: 'GROWTH', paidUntil: new Date(Date.now() + 400 * 86400_000) } });
  return { app, calls, own, client, pkg };
}

async function portalAs(app: App, own: Awaited<ReturnType<typeof owner>>, clientId: string) {
  const invite = (await own('POST', `/api/clients/${clientId}/portal/users`, { name: 'طارق', email: `t${Math.random()}@cafe.eg` })).json();
  const res = await app.inject({ method: 'POST', url: '/api/portal/auth/consume', payload: { token: invite.link.url.split('#')[1] } });
  const cookie = res.cookies.find(c => c.name === 'dosly_portal')!.value;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, cookies: { dosly_portal: cookie } });
}

const draft = (own: Awaited<ReturnType<typeof owner>>, clientId: string, unitMinor = 100_000, extra: object = {}) =>
  own('POST', '/api/billing/invoices', { clientId, items: [{ description: 'تصوير', qty: 1, unitMinor }], ...extra });

describe('agency billing settings', () => {
  it('validates Egyptian payment details and needs a tax id before VAT', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    expect((await own('PUT', '/api/billing/settings', { vatRegistered: true })).statusCode).toBe(400);
    expect((await own('PUT', '/api/billing/settings', { instapayLink: 'https://ipn.eg.evil.com/S/x' })).statusCode).toBe(400); // look-alike domain
    expect((await own('PUT', '/api/billing/settings', { wallet: '0100' })).statusCode).toBe(400);
    expect((await own('PUT', '/api/billing/settings', { iban: 'EG12' })).statusCode).toBe(400);
    const ok = await own('PUT', '/api/billing/settings', { taxId: '123 456 789', instapayLink: 'https://ipn.eg/S/noon/instapay/AbC', wallet: '+201001234567', iban: 'EG38 0003 0001 0000 0000 1234 5678 9' });
    expect(ok.json()).toMatchObject({ taxId: '123456789', wallet: '01001234567', iban: 'EG380003000100000000123456789', vatRegistered: false, vatRateBp: 1400 });
    // now that a tax id is saved, turning VAT on alone is fine; clearing the tax id with VAT on is not
    expect((await own('PUT', '/api/billing/settings', { vatRegistered: true })).statusCode).toBe(200);
    expect((await own('PUT', '/api/billing/settings', { taxId: '' })).statusCode).toBe(400);
  });

  it('is for owners and managers only, and never crosses agencies', async () => {
    const { app, own, client } = await setup();
    const link = (await own('POST', '/api/team/invites', { email: 'mod@test.eg', role: 'MODERATOR' })).json().link as string;
    const acc = await app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'منى', password: 'moderator-pass-1' } });
    const mod = session(app, acc.cookies.find(c => c.name === 'dosly_session')!.value);
    expect((await mod('GET', '/api/billing/invoices')).statusCode).toBe(403);
    expect((await mod('GET', '/api/today')).json().billing).toBeNull();
    const inv = (await draft(own, client.id)).json();
    const other = await owner(app, 'وكالة تانية');
    expect((await other('GET', `/api/billing/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await other('POST', `/api/billing/invoices/${inv.id}/issue`)).statusCode).toBe(404);
    expect((await other('POST', '/api/billing/invoices', { clientId: client.id, items: [{ description: 'x', qty: 1, unitMinor: 1 }] })).statusCode).toBe(404);
  });
});

describe('invoices', () => {
  it('numbers invoices at issue, adds 14% VAT after the discount, and freezes them', async () => {
    const { own, client } = await setup();
    const d = (await draft(own, client.id, 600_000, { discountMinor: 50_000 })).json();
    expect(d).toMatchObject({ status: 'DRAFT', number: null, subtotalMinor: 600_000, discountMinor: 50_000, vatRateBp: 1400, vatMinor: 77_000, totalMinor: 627_000 });
    // a draft changes freely
    const edited = (await own('PATCH', `/api/billing/invoices/${d.id}`, { items: [{ description: 'تصوير', qty: 2, unitMinor: 300_000 }], vat: false })).json();
    expect(edited).toMatchObject({ subtotalMinor: 600_000, vatMinor: 0, totalMinor: 550_000 });
    const issued = (await own('POST', `/api/billing/invoices/${d.id}/issue`)).json();
    const today = cairoToday();
    expect(issued).toMatchObject({ status: 'ISSUED', number: `NOON-${today.slice(0, 4)}-0001`, issueOn: today, seller: { name: 'نون للتسويق', taxId: '123456789' }, buyer: { name: 'كافيه نسمة' } });
    expect(issued.dueOn > today).toBe(true);
    // frozen: items can't change, only the ETA id; it can't be deleted or issued again
    expect((await own('PATCH', `/api/billing/invoices/${d.id}`, { items: [{ description: 'x', qty: 1, unitMinor: 1 }] })).statusCode).toBe(400);
    expect((await own('PATCH', `/api/billing/invoices/${d.id}`, { etaUuid: 'ABCDEF0123456789ABCDEF0123456789' })).json().etaUuid).toBe('ABCDEF0123456789ABCDEF0123456789');
    expect((await own('DELETE', `/api/billing/invoices/${d.id}`)).statusCode).toBe(409);
    expect((await own('POST', `/api/billing/invoices/${d.id}/issue`)).statusCode).toBe(409);
    // the client's details changing later doesn't change an issued invoice
    await own('PUT', `/api/billing/clients/${client.id}`, { legalName: 'شركة نسمة ش.ذ.م.م', taxId: '512345678' });
    expect((await own('GET', `/api/billing/invoices/${d.id}`)).json().buyer.name).toBe('كافيه نسمة');
    expect((await draft(own, client.id, 1, { issue: true })).json()).toMatchObject({ buyer: { name: 'شركة نسمة ش.ذ.م.م', taxId: '512345678' } });
  });

  it('gives drafts issued at the same time unique numbers with no holes', async () => {
    const { own, client } = await setup();
    const ids = await Promise.all(Array.from({ length: 8 }, () => draft(own, client.id).then(r => r.json().id as string)));
    const results = await Promise.all([...ids, ids[0]!, ids[1]!].map(id => own('POST', `/api/billing/invoices/${id}/issue`)));
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(8); // issuing one twice works once
    const seqs = (await db.invoice.findMany({ select: { seq: true } })).map(r => r.seq).sort((a, b) => a! - b!);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await db.agencyBilling.findFirstOrThrow()).nextNumber).toBe(9);
  });

  it('takes partial payments, refuses overpaying, and applies parallel payments without losing one', async () => {
    const { own, client } = await setup();
    const inv = (await draft(own, client.id, 100_000, { vat: false, issue: true })).json();
    const pay = (amountMinor: number) => own('POST', `/api/billing/invoices/${inv.id}/payments`, { amountMinor, method: 'INSTAPAY', reference: '123' });
    expect((await pay(30_000)).json()).toMatchObject({ status: 'ISSUED', paidMinor: 30_000 });
    expect((await pay(80_000)).statusCode).toBe(409);
    const both = await Promise.all([pay(35_000), pay(35_000)]);
    expect(both.map(r => r.statusCode)).toEqual([200, 200]);
    expect((await own('GET', `/api/billing/invoices/${inv.id}`)).json()).toMatchObject({ status: 'PAID', paidMinor: 100_000 });
    expect((await pay(1)).statusCode).toBe(409);
    expect((await own('POST', `/api/billing/invoices/${inv.id}/void`, { reason: 'غلط' })).statusCode).toBe(409); // paid can't be voided
  });

  it('voids an unpaid invoice but keeps its number', async () => {
    const { own, client } = await setup();
    const inv = (await draft(own, client.id, 100_000, { issue: true })).json();
    expect((await own('POST', `/api/billing/invoices/${inv.id}/void`, { reason: '' })).statusCode).toBe(400);
    const v = (await own('POST', `/api/billing/invoices/${inv.id}/void`, { reason: 'اتفقنا نأجلها' })).json();
    expect(v).toMatchObject({ status: 'VOID', number: inv.number, voidReason: 'اتفقنا نأجلها' });
    expect((await draft(own, client.id, 1, { issue: true })).json().number).toMatch(/-0002$/);
  });
});

describe('packages and recurring invoices', () => {
  it('invoices the first period as soon as a client starts a package, then once per period', async () => {
    const { own, client, pkg, calls } = await setup();
    const sub = (await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id })).json();
    const today = cairoToday();
    expect(sub).toMatchObject({ status: 'ACTIVE', cycles: 1, nextInvoiceOn: addMonths(today, 1), priceMinor: 750_000 });
    const [inv] = await db.invoice.findMany();
    expect(inv).toMatchObject({ status: 'ISSUED', subscriptionId: sub.id, periodFrom: today, totalMinor: 855_000, number: `NOON-${today.slice(0, 4)}-0001` });
    expect((inv!.items as { description: string }[])[0]!.description).toContain('النمو');
    expect(calls.events.some(e => e.type === 'invoice.updated')).toBe(true);

    // The package price changing later doesn't touch the running subscription.
    await own('PATCH', `/api/billing/packages/${pkg.id}`, { priceMinor: 900_000 });
    // A month later, two runs at once still make one invoice for the new period.
    const later = new Date(Date.now() + 32 * 86400_000);
    const runs = await Promise.all([generateDueInvoices(db, { now: later }), generateDueInvoices(db, { now: later }), generateDueInvoices(db, { now: later })]);
    expect(runs.reduce((s, r) => s + r.created, 0)).toBe(1);
    const second = await db.invoice.findFirstOrThrow({ where: { periodFrom: addMonths(today, 1) } });
    expect(second.subtotalMinor).toBe(750_000);
    expect(await db.invoice.count()).toBe(2);
  });

  it('keeps month-end starts at month end and skips paused months', async () => {
    expect(subscriptionPeriod('2026-01-31', 1, 1)).toEqual({ from: '2026-02-28', to: '2026-03-30' });
    expect(subscriptionPeriod('2026-01-31', 1, 2).from).toBe('2026-03-31');
    expect(subscriptionPeriod('2026-11-15', 3, 1)).toEqual({ from: '2027-02-15', to: '2027-05-14' });

    const { own, client, pkg } = await setup();
    const sub = (await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id })).json();
    expect((await own('PATCH', `/api/billing/subscriptions/${sub.id}`, { status: 'PAUSED' })).json().status).toBe('PAUSED');
    expect((await generateDueInvoices(db, { now: new Date(Date.now() + 95 * 86400_000) })).created).toBe(0);
    // pretend three months passed while paused, then resume: only the current period is billed
    const s = await db.clientSubscription.findUniqueOrThrow({ where: { id: sub.id } });
    const back = addMonths(s.startOn, -3);
    await db.clientSubscription.update({ where: { id: sub.id }, data: { startOn: back, nextInvoiceOn: addMonths(back, 1) } });
    await db.invoice.updateMany({ data: { periodFrom: back } });
    const resumed = (await own('PATCH', `/api/billing/subscriptions/${sub.id}`, { status: 'ACTIVE' })).json();
    expect(resumed.cycles).toBe(4);
    expect(await db.invoice.count()).toBe(2); // the first one and the current period, nothing for the paused months
    expect((await own('PATCH', `/api/billing/subscriptions/${sub.id}`, { status: 'ENDED' })).json()).toMatchObject({ status: 'ENDED', nextInvoiceOn: null });
  });

  it('bills a one-time package as an invoice, not a subscription', async () => {
    const { own, client } = await setup();
    const shoot = (await own('POST', '/api/billing/packages', { name: 'تصوير', priceMinor: 350_000, months: 0 })).json();
    expect((await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: shoot.id })).statusCode).toBe(409);
    const inv = (await own('POST', '/api/billing/invoices', { clientId: client.id, packageId: shoot.id })).json();
    expect(inv).toMatchObject({ status: 'DRAFT', subtotalMinor: 350_000, items: [{ description: 'تصوير', qty: 1, unitMinor: 350_000 }] });
  });
});

describe('invoices in the client portal', () => {
  it('shows only issued invoices of that client, takes "I paid", and the agency confirms or rejects', async () => {
    const { app, own, client, pkg } = await setup();
    const other = (await own('POST', '/api/clients', { name: 'عميل تاني' })).json();
    await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id });
    const hidden = (await draft(own, client.id)).json(); // a draft stays with the agency
    const otherInv = (await draft(own, other.id, 100, { issue: true })).json();
    const as = await portalAs(app, own, client.id);

    const b = (await as('GET', '/api/portal/billing')).json();
    expect(b.invoices).toHaveLength(1);
    expect(b.due).toEqual([{ currency: 'EGP', minor: 855_000 }]);
    expect(b.pay).toMatchObject({ instapay: 'noon@instapay', wallet: '01001234567' });
    expect(b.subscriptions[0]).toMatchObject({ name: 'النمو', features: ['12 بوست', 'إدارة الإعلانات'] });
    expect((await as('GET', `/api/portal/invoices/${hidden.id}`)).statusCode).toBe(404);
    expect((await as('GET', `/api/portal/invoices/${otherInv.id}`)).statusCode).toBe(404);
    expect((await as('POST', `/api/portal/invoices/${otherInv.id}/paid`, { method: 'INSTAPAY' })).statusCode).toBe(404);

    const inv = b.invoices[0];
    await as('GET', `/api/portal/invoices/${inv.id}`);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).viewedAt).not.toBeNull();
    expect((await as('POST', `/api/portal/invoices/${inv.id}/paid`, { method: 'CASH' })).statusCode).toBe(400);
    const r = (await as('POST', `/api/portal/invoices/${inv.id}/paid`, { method: 'INSTAPAY', reference: '998877' })).json();
    expect(r.invoice).toMatchObject({ status: 'ISSUED', paidMinor: 0, pendingPayments: 1 });
    expect((await own('GET', '/api/today')).json().billing).toMatchObject({ toCheck: 1, drafts: 1 });
    expect((await own('GET', '/api/billing/invoices?view=check')).json().items.map((i: { id: string }) => i.id)).toEqual([inv.id]);

    // rejected: nothing counts and the client can report again
    const p1 = (await db.invoicePayment.findFirstOrThrow({ where: { state: 'PENDING' } })).id;
    expect((await own('POST', `/api/billing/payments/${p1}/reject`)).json()).toMatchObject({ status: 'ISSUED', paidMinor: 0 });
    expect((await own('POST', `/api/billing/payments/${p1}/confirm`)).statusCode).toBe(409);
    await as('POST', `/api/portal/invoices/${inv.id}/paid`, { method: 'WALLET', reference: '01001112222' });
    const p2 = (await db.invoicePayment.findFirstOrThrow({ where: { state: 'PENDING' } })).id;
    expect((await own('POST', `/api/billing/payments/${p2}/confirm`)).json()).toMatchObject({ status: 'PAID', paidMinor: 855_000 });
    expect((await as('GET', '/api/portal/billing')).json().due).toEqual([]);
    expect((await as('POST', `/api/portal/invoices/${inv.id}/paid`, { method: 'INSTAPAY' })).statusCode).toBe(409);
  });

  it('counts overdue invoices on the today page', async () => {
    const { own, client } = await setup();
    const inv = (await draft(own, client.id, 100_000, { issue: true })).json();
    await db.invoice.update({ where: { id: inv.id }, data: { dueOn: '2020-01-01' } });
    expect((await own('GET', '/api/today')).json().billing).toMatchObject({ overdue: 1 });
    expect((await own('GET', '/api/billing/invoices')).json().items[0].overdue).toBe(true);
    expect((await own('GET', '/api/billing/counts')).json()).toMatchObject({ overdue: 1, unpaid: 1, owed: [{ currency: 'EGP', minor: 114_000 }] });
  });

  it('core: client payments wait for the agency; issuing an empty draft is refused', async () => {
    const { own, client } = await setup();
    const inv = (await draft(own, client.id, 100_000, { issue: true })).json();
    const { invoice } = await addPayment(db, { invoiceId: inv.id, amountMinor: 50_000, method: 'BANK', paidOn: cairoToday(), reportedBy: 'client' });
    expect(invoice.paidMinor).toBe(0);
    const empty = await db.invoice.create({ data: { agencyId: invoice.agencyId, clientId: client.id, items: [], subtotalMinor: 0, totalMinor: 0 } });
    await expect(issueInvoice(db, empty.id)).rejects.toThrow('فاضية');
  });
});

describe('VAT per line', () => {
  it('spreads the discount over lines and rounds VAT per line, like the ETA', async () => {
    const { invoiceTotals, lineDiscounts } = await import('@dosly/shared');
    expect(lineDiscounts([100, 200, 300], 100)).toEqual([17, 33, 50]);
    expect(lineDiscounts([1, 1, 1], 2).reduce((s, x) => s + x, 0)).toBe(2);
    // three lines of 0.35 EGP at 14%: per line 4.9 -> 5 piastres each (15), not round(14.7) = 15... and 0.03 discount
    const t = invoiceTotals([{ description: 'a', qty: 1, unitMinor: 35 }, { description: 'b', qty: 1, unitMinor: 35 }, { description: 'c', qty: 1, unitMinor: 35 }], 0, 1400);
    expect(t.vatMinor).toBe(15);
    expect(invoiceTotals([{ description: 'a', qty: 1, unitMinor: 600_000 }], 50_000, 1400)).toMatchObject({ vatMinor: 77_000, totalMinor: 627_000 });
  });
  it('accepts an ETA share link and keeps just the UUID', async () => {
    const { own, client } = await setup();
    const inv = (await draft(own, client.id, 100, { issue: true })).json();
    const uuid = 'A'.repeat(64);
    const r = await own('PATCH', `/api/billing/invoices/${inv.id}`, { etaUuid: `https://invoicing.eta.gov.eg/documents/${uuid}/share/XYZ` });
    expect(r.json().etaUuid).toBe(uuid);
  });
});

describe('review fixes', () => {
  it('editing one field of a package keeps the rest', async () => {
    const { own } = await setup();
    const p = (await own('POST', '/api/billing/packages', { name: 'ربع سنوي', priceMinor: 100, months: 3, currency: 'USD', features: ['a', 'b'] })).json();
    expect((await own('PATCH', `/api/billing/packages/${p.id}`, { name: 'Q2' })).json()).toMatchObject({ name: 'Q2', months: 3, currency: 'USD', features: ['a', 'b'] });
  });

  it('creates the billing row once under parallel first requests', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const res = await Promise.all(Array.from({ length: 10 }, () => own('GET', '/api/billing/settings')));
    expect(res.map(r => r.statusCode)).toEqual(Array(10).fill(200));
  });

  it('refuses prices and totals that would not fit, without breaking the hourly run', async () => {
    const { own, client, pkg } = await setup();
    expect((await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id, priceMinor: 2_000_000_000 })).statusCode).toBe(400);
    expect((await own('POST', '/api/billing/invoices', { clientId: client.id, items: [{ description: 'x', qty: 3, unitMinor: 1_000_000_000 }], discountMinor: 2_000_000_000, vat: false })).statusCode).toBe(400);
    const errors: string[] = [];
    const sub = (await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id })).json();
    await db.clientSubscription.update({ where: { id: sub.id }, data: { priceMinor: 2_000_000_000 } }); // bad row written behind the API's back
    const r = await generateDueInvoices(db, { now: new Date(Date.now() + 32 * 86400_000), onError: id => errors.push(id) });
    expect(r.created).toBe(0);
    expect(errors).toEqual([sub.id]);
  });

  it('stops recurring invoices once the agency trial is over', async () => {
    const { own, client, pkg } = await setup();
    await db.agency.updateMany({ data: { plan: 'TRIAL', trialEndsAt: new Date(Date.now() + 86400_000) } });
    await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id });
    expect((await generateDueInvoices(db, { now: new Date(Date.now() + 40 * 86400_000) })).created).toBe(0);
  });

  it('bills only the current period after the agency was suspended for months', async () => {
    const { own, client, pkg } = await setup();
    const sub = (await own('POST', '/api/billing/subscriptions', { clientId: client.id, packageId: pkg.id })).json();
    await db.agency.updateMany({ data: { status: 'SUSPENDED' } });
    const later = new Date(Date.now() + 200 * 86400_000);
    expect((await generateDueInvoices(db, { now: later })).created).toBe(0);
    await db.agency.updateMany({ data: { status: 'ACTIVE' } });
    for (let i = 0; i < 3; i++) await generateDueInvoices(db, { now: later });
    expect(await db.invoice.count({ where: { subscriptionId: sub.id } })).toBe(2);
  });

  it('closes a client report once the agency records the full payment itself', async () => {
    const { app, own, client } = await setup();
    const inv = (await draft(own, client.id, 100_000, { issue: true })).json();
    const as = await portalAs(app, own, client.id);
    await as('POST', `/api/portal/invoices/${inv.id}/paid`, { method: 'INSTAPAY' });
    await own('POST', `/api/billing/invoices/${inv.id}/payments`, { amountMinor: inv.totalMinor, method: 'INSTAPAY', note: 'داخلي' });
    expect((await own('GET', '/api/billing/invoices?view=check')).json().items).toEqual([]);
    expect(await db.invoicePayment.count({ where: { state: 'PENDING' } })).toBe(0);
    const seen = (await as('GET', `/api/portal/invoices/${inv.id}`)).json();
    expect(seen.invoice.payments.find((p: { reportedBy: string }) => p.reportedBy === 'agency').note).toBeNull();
  });

  it('adds VAT only for a VAT-registered agency', async () => {
    const { app } = await makeApp();
    const own = await owner(app);
    const client = (await own('POST', '/api/clients', { name: 'x' })).json();
    expect((await draft(own, client.id, 100, { vat: true })).statusCode).toBe(409);
  });
});
