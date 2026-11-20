'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { api, type Client } from '@/lib/api';
import { money } from '@/lib/ads';
import { day, daysUntil, fromMinor, invoiceState, PAYMENT_METHOD, toMinor, totals, type Invoice, type Package, type Payment } from '@/lib/billing';
import { count } from '@/lib/when';
import { Button, cx, ErrorText, Field, Input, Pill, Select, Textarea } from './ui';

const TABS = [
  { href: '/billing', label: 'الفواتير' },
  { href: '/billing/packages', label: 'الباقات والعملاء' },
  { href: '/billing/settings', label: 'طرق الدفع وبيانات الفاتورة' }
];

export function BillingTabs() {
  const path = usePathname();
  return (
    <nav aria-label="الفواتير" className="flex flex-wrap gap-1 border-b border-line px-8 max-md:px-4 print:hidden">
      {TABS.map(t => {
        const active = t.href === '/billing' ? path === '/billing' || path.startsWith('/billing/invoices') : path.startsWith(t.href);
        return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined} className={cx('-mb-px border-b-2 px-3 py-3 font-semibold', active ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-ink')}>{t.label}</Link>;
      })}
    </nav>
  );
}

/** "متأخرة من 5 أيام" / "آخر ميعاد بكرة" / "آخر ميعاد بعد 3 أيام". */
export function dueWords(inv: Pick<Invoice, 'status' | 'dueOn'>, today: string) {
  if (inv.status !== 'ISSUED' || !inv.dueOn) return null;
  const d = daysUntil(inv.dueOn, today);
  if (d < 0) return `متأخرة من ${count(-d, 'يوم', 'يومين', 'أيام', 'يوم')}`;
  if (d === 0) return 'آخر ميعاد للدفع النهارده';
  if (d === 1) return 'آخر ميعاد للدفع بكرة';
  return `آخر ميعاد للدفع بعد ${count(d, 'يوم', 'يومين', 'أيام', 'يوم')}`;
}

/** A payment the client says they made: the agency checks its bank or wallet and answers with one tap. */
export function PendingPayment({ p, currency, onDone }: { p: Payment; currency: string; onDone: (inv: Invoice) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function decide(d: 'confirm' | 'reject') {
    setBusy(true); setErr(null);
    try { onDone(await api<Invoice>(`/billing/payments/${p.id}/${d}`, { method: 'POST' })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-sun/60 bg-sun/10 p-3">
      <p className="text-sm">العميل قال إنه حوّل <b>{money(p.amountMinor, currency)}</b> بـ {PAYMENT_METHOD[p.method]}{p.reference ? <> · رقم العملية <span className="num" dir="ltr">{p.reference}</span></> : null} · {day(p.paidOn)}</p>
      {p.note && <p className="text-sm text-muted">«{p.note}»</p>}
      <p className="text-xs text-muted">اتأكد إن الفلوس وصلت حسابك أو محفظتك الأول.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => decide('confirm')}><Check size={16} aria-hidden />الفلوس وصلت</Button>
        <Button variant="ghost" disabled={busy} onClick={() => decide('reject')}><X size={16} aria-hidden />موصلتش</Button>
      </div>
      <ErrorText error={err} />
    </div>
  );
}

/** One invoice in the list: who, how much, and what is needed next. */
export function InvoiceRow({ inv, today, showClient, onChange }: { inv: Invoice; today: string; showClient: boolean; onChange: (inv: Invoice) => void }) {
  const st = invoiceState(inv);
  const due = dueWords(inv, today);
  const pending = inv.payments.filter(p => p.state === 'PENDING');
  return (
    <article aria-label={inv.number ? `فاتورة ${inv.number}` : 'مسودة'} className={cx('relative flex flex-col gap-2 rounded-[var(--radius-md)] border bg-surface p-4', inv.overdue ? 'border-danger/40' : pending.length ? 'border-sun/60' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/billing/invoices/${inv.id}`} className="font-semibold hover:underline after:absolute after:inset-0 after:content-['']">
          {showClient ? inv.client.name : inv.number ? <span className="num" dir="ltr">{inv.number}</span> : 'مسودة'}
        </Link>
        <Pill tone={st.tone}>{st.label}</Pill>
        <span className="ms-auto font-display text-lg font-bold tabular-nums">{money(inv.status === 'ISSUED' ? inv.totalMinor - inv.paidMinor : inv.totalMinor, inv.currency, true)}</span>
      </div>
      <p className="text-sm text-muted">
        {showClient && inv.number && <><span className="num" dir="ltr">{inv.number}</span> · </>}
        {inv.items[0]?.description}{inv.items.length > 1 ? ` و${count(inv.items.length - 1, 'بند كمان', 'بندين كمان', 'بنود كمان', 'بند كمان')}` : ''}
      </p>
      <p className={cx('text-sm', inv.overdue ? 'font-semibold text-danger' : 'text-muted')}>
        {due ?? (inv.status === 'PAID' && inv.paidAt ? `اتدفعت ${day(inv.paidAt.slice(0, 10))}` : inv.status === 'DRAFT' ? 'لسه متبعتتش للعميل' : inv.issueOn ? day(inv.issueOn) : '')}
        {inv.status === 'ISSUED' && (inv.viewedAt ? ' · العميل شافها' : ' · العميل لسه مفتحهاش')}
      </p>
      {pending.map(p => <div key={p.id} className="relative z-10"><PendingPayment p={p} currency={inv.currency} onDone={onChange} /></div>)}
    </article>
  );
}

type Line = { description: string; qty: string; price: string };

/**
 * New invoice or a draft's edit. Prices are typed in pounds; the total updates as you type and the
 * server recomputes it the same way.
 */
export function InvoiceEditor({ clients, packages, vatRateBp, vatDefault, inv, onSaved }: {
  clients: Client[]; packages: Package[]; vatRateBp: number; vatDefault: boolean; inv?: Invoice; onSaved: (inv: Invoice) => void;
}) {
  const [clientId, setClientId] = useState(inv?.clientId ?? '');
  const [lines, setLines] = useState<Line[]>(inv ? inv.items.map(i => ({ description: i.description, qty: String(i.qty), price: fromMinor(i.unitMinor) })) : [{ description: '', qty: '1', price: '' }]);
  const [discount, setDiscount] = useState(inv?.discountMinor ? fromMinor(inv.discountMinor) : '');
  const [vat, setVat] = useState(inv ? inv.vatRateBp > 0 : vatDefault);
  const [dueOn, setDueOn] = useState(inv?.dueOn ?? '');
  const [notes, setNotes] = useState(inv?.notes ?? '');
  const [currency, setCurrency] = useState(inv?.currency ?? 'EGP');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = lines.map(l => ({ description: l.description.trim(), qty: Math.max(1, Math.trunc(Number(l.qty) || 1)), unitMinor: toMinor(l.price) }));
  const valid = items.every(i => i.description && i.unitMinor !== null) && items.length > 0 && !!clientId;
  const t = totals(items.map(i => ({ ...i, unitMinor: i.unitMinor ?? 0 })), toMinor(discount) ?? 0, vat ? vatRateBp : 0);
  const set = (k: number, patch: Partial<Line>) => setLines(ls => ls.map((l, i) => (i === k ? { ...l, ...patch } : l)));
  const addPackage = (id: string) => {
    const p = packages.find(x => x.id === id);
    if (!p) return;
    if (!inv) setCurrency(p.currency);
    setLines(ls => [...ls.filter(l => l.description || l.price), { description: p.name, qty: '1', price: fromMinor(p.priceMinor) }]);
  };

  async function save(issue: boolean) {
    if (!valid) { setErr(!clientId ? 'اختار العميل' : 'كل بند محتاج وصف وسعر'); return; }
    setBusy(true); setErr(null);
    const body = { items: items.map(i => ({ ...i, unitMinor: i.unitMinor! })), discountMinor: toMinor(discount) ?? 0, vat, dueOn: dueOn || null, notes: notes.trim() || null };
    try {
      let out: Invoice;
      if (inv) {
        out = await api<Invoice>(`/billing/invoices/${inv.id}`, { method: 'PATCH', body });
        if (issue) out = await api<Invoice>(`/billing/invoices/${inv.id}/issue`, { method: 'POST' });
      } else out = await api<Invoice>('/billing/invoices', { body: { ...body, clientId, currency, issue } });
      onSaved(out);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={e => { e.preventDefault(); void save(false); }} onChange={() => err && setErr(null)} className="flex flex-col gap-4">
      {!inv && (
        <Field label="العميل" id="inv-client">
          <Select id="inv-client" value={clientId} onChange={e => setClientId(e.target.value)} required>
            <option value="">اختار العميل</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      )}
      {!!packages.length && (
        <Field label="ضيف باقة (اختياري)" id="inv-pkg">
          <Select id="inv-pkg" value="" onChange={e => addPackage(e.target.value)}>
            <option value="">اختار باقة تتضاف كبند</option>
            {packages.filter(p => !p.archivedAt && (!inv || p.currency === inv.currency)).map(p => <option key={p.id} value={p.id}>{p.name}: {money(p.priceMinor, p.currency, true)}</option>)}
          </Select>
        </Field>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-semibold">البنود</legend>
        {lines.map((l, k) => (
          <div key={k} className="grid grid-cols-[1fr_4rem_7rem_auto] items-end gap-2 max-sm:grid-cols-[4rem_1fr_auto] max-sm:rounded-[var(--radius-md)] max-sm:border max-sm:border-line max-sm:p-2">
            <label className="flex flex-col gap-1 max-sm:col-span-3">
              <span className={cx('text-xs text-muted', k > 0 && 'sm:sr-only')}>الوصف</span>
              <Input value={l.description} onChange={e => set(k, { description: e.target.value })} placeholder="مثلًا: إدارة صفحات شهر ديسمبر" maxLength={300} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={cx('text-xs text-muted', k > 0 && 'sm:sr-only')}>العدد</span>
              <Input inputMode="numeric" value={l.qty} onChange={e => set(k, { qty: e.target.value })} className="text-center" />
            </label>
            <label className="flex flex-col gap-1">
              <span className={cx('text-xs text-muted', k > 0 && 'sm:sr-only')}>سعر الواحدة</span>
              <Input inputMode="decimal" value={l.price} onChange={e => set(k, { price: e.target.value })} placeholder="0" dir="ltr" className="text-end" />
            </label>
            <button type="button" aria-label={`شيل البند ${k + 1}`} disabled={lines.length === 1} onClick={() => setLines(ls => ls.filter((_, i) => i !== k))} className="grid size-11 place-items-center rounded-[var(--radius-md)] text-muted hover:bg-surface-2 disabled:opacity-30"><Trash2 size={16} aria-hidden /></button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setLines(ls => [...ls, { description: '', qty: '1', price: '' }])} disabled={lines.length >= 30}><Plus size={15} aria-hidden />بند كمان</Button>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label="خصم (اختياري)" id="inv-discount"><Input id="inv-discount" inputMode="decimal" value={discount} onChange={e => setDiscount(e.target.value)} dir="ltr" className="text-end" placeholder="0" /></Field>
        <Field label="آخر ميعاد للدفع" id="inv-due" hint="لو سبته فاضي هيتحسب من إعداداتك لما تتبعت"><Input id="inv-due" type="date" value={dueOn} onChange={e => setDueOn(e.target.value)} /></Field>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} />ضيف ضريبة القيمة المضافة ({vatRateBp / 100}%)</label>
      <Field label="ملاحظات تظهر للعميل (اختياري)" id="inv-notes"><Textarea id="inv-notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)} maxLength={1000} /></Field>
      <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm">
        {(t.discount > 0 || t.vat > 0) && <p className="flex justify-between"><span className="text-muted">المجموع</span><span>{money(t.subtotal, currency)}</span></p>}
        {t.discount > 0 && <p className="flex justify-between"><span className="text-muted">خصم</span><span>− {money(t.discount, currency)}</span></p>}
        {t.vat > 0 && <p className="flex justify-between"><span className="text-muted">الضريبة</span><span>{money(t.vat, currency)}</span></p>}
        <p className="flex justify-between text-lg font-bold"><span>الإجمالي</span><span>{money(t.total, currency)}</span></p>
      </div>
      <ErrorText error={err} />
      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <Button type="button" size="lg" disabled={busy} onClick={() => save(true)}>احفظ وابعتها للعميل</Button>
        <Button size="lg" variant="ghost" disabled={busy}>احفظها مسودة</Button>
      </div>
      <p className="text-xs text-muted">لما تتبعت بتاخد رقم وتظهر للعميل في البوابة، ومبقاش ينفع تتعدل. لو فيها غلط بتلغيها وتعمل واحدة جديدة.</p>
    </form>
  );
}
