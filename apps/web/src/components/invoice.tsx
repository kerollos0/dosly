'use client';
import { useState } from 'react';
import { Check, Copy, ExternalLink, Landmark, Smartphone, Wallet } from 'lucide-react';
import { nf } from '@/lib/ads';
import { day, exact, invoiceState, PAYMENT_METHOD, type Invoice, type Party, type PayMethods } from '@/lib/billing';
import { cx, Pill } from './ui';

export function InvoicePill({ inv, client = false }: { inv: Invoice; client?: boolean }) {
  const s = invoiceState(inv, client);
  // On paper only "paid" and "cancelled" mean something; working states stay on screen.
  return <span className={inv.status === 'PAID' || inv.status === 'VOID' ? '' : 'print:hidden'}><Pill tone={s.tone}>{s.label}</Pill></span>;
}

function PartyBlock({ title, p }: { title: string; p: Party | null }) {
  if (!p) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-sm">
      <span className="text-xs font-semibold text-muted">{title}</span>
      <span className="text-base font-semibold">{p.name}</span>
      {p.displayName && p.displayName !== p.name && <span className="text-muted">{p.displayName}</span>}
      {p.address && <span className="text-muted">{p.address}</span>}
      {p.taxId && <span>رقم التسجيل الضريبي: <span className="num" dir="ltr">{p.taxId.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1-$2-$3')}</span></span>}
      {p.commercialReg && <span>سجل تجاري: <span className="num">{p.commercialReg}</span></span>}
      {p.phone && <span>تليفون: <span className="num" dir="ltr">{p.phone}</span></span>}
    </div>
  );
}

/**
 * The invoice itself, as the client gets it and as it prints. A draft has no frozen details yet, so
 * the caller passes the agency's and client's current ones.
 */
export function InvoiceDocument({ inv, seller, buyer, client = false }: { inv: Invoice; seller?: Party | null; buyer?: Party | null; client?: boolean }) {
  const c = inv.currency;
  const s = inv.seller ?? seller ?? null, b = inv.buyer ?? buyer ?? { name: inv.client.name, taxId: null, address: null };
  const left = inv.totalMinor - inv.paidMinor;
  const row = (label: string, value: string, strong = false) => (
    <div className={cx('flex items-center justify-between gap-4', strong && 'border-t border-line pt-2 text-lg font-bold')}><span className={strong ? '' : 'text-muted'}>{label}</span><span className="tabular-nums">{value}</span></div>
  );
  return (
    <article aria-label={inv.number ? `فاتورة ${inv.number}` : 'مسودة فاتورة'} className="relative flex flex-col gap-6 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface p-6 max-sm:p-4 print:border-0 print:p-0">
      {inv.status === 'DRAFT' && <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center font-display text-[96px] font-bold text-muted/10 -rotate-12 select-none">مسودة</span>}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <PartyBlock title="من" p={s} />
        <div className="flex flex-col items-end gap-1 text-sm max-sm:items-start">
          <h2 className="font-display text-2xl font-bold">{inv.etaUuid ? 'فاتورة ضريبية' : 'فاتورة'}</h2>
          {inv.number ? <span className="num text-base font-semibold" dir="ltr">{inv.number}</span> : <span className="text-muted">لسه ملهاش رقم (بتاخد رقم لما تتبعت)</span>}
          <InvoicePill inv={inv} client={client} />
          {inv.issueOn && <span>التاريخ: {day(inv.issueOn)}</span>}
          {inv.dueOn && inv.status !== 'VOID' && <span className={cx(inv.overdue && 'font-semibold text-danger')}>آخر ميعاد للدفع: {day(inv.dueOn)}</span>}
        </div>
      </header>
      <PartyBlock title="إلى" p={b} />
      {inv.periodFrom && inv.periodTo && <p className="text-sm">عن الفترة من <b>{day(inv.periodFrom)}</b> لـ <b>{day(inv.periodTo)}</b></p>}

      {/* On a phone each line is a small block; the table returns on wider screens and on paper. */}
      <ul className="flex flex-col divide-y divide-line/60 border-y border-line text-sm sm:hidden print:hidden">
        {inv.items.map((i, k) => (
          <li key={k} className="flex flex-col gap-1 py-2">
            <span>{i.description}</span>
            <span className="flex justify-between gap-2 tabular-nums text-muted"><span>{i.qty > 1 ? `${nf.format(i.qty)} × ${exact(i.unitMinor, c)}` : ''}</span><span className="font-semibold text-ink">{exact(i.qty * i.unitMinor, c)}</span></span>
          </li>
        ))}
      </ul>
      <div className="max-sm:hidden print:block">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-start text-muted"><th className="py-2 text-start font-semibold">البند</th><th className="py-2 text-center font-semibold">العدد</th><th className="py-2 text-end font-semibold">السعر</th><th className="py-2 text-end font-semibold">الإجمالي</th></tr></thead>
          <tbody>
            {inv.items.map((i, k) => (
              <tr key={k} className="border-b border-line/60 align-top">
                <td className="py-2 pe-3">{i.description}</td>
                <td className="py-2 text-center tabular-nums">{nf.format(i.qty)}</td>
                <td className="py-2 text-end tabular-nums whitespace-nowrap">{exact(i.unitMinor, c)}</td>
                <td className="py-2 text-end tabular-nums whitespace-nowrap">{exact(i.qty * i.unitMinor, c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 self-end text-sm sm:min-w-72 max-sm:self-stretch">
        {(inv.discountMinor > 0 || inv.vatMinor > 0) && row('المجموع', exact(inv.subtotalMinor, c))}
        {inv.discountMinor > 0 && row('خصم', `− ${exact(inv.discountMinor, c)}`)}
        {inv.vatMinor > 0 && row(`ضريبة القيمة المضافة ${nf.format(inv.vatRateBp / 100)}%`, exact(inv.vatMinor, c))}
        {row('الإجمالي', exact(inv.totalMinor, c), true)}
        {inv.paidMinor > 0 && inv.status !== 'VOID' && <>{row('اتدفع', exact(inv.paidMinor, c))}{left > 0 && row('الباقي', exact(left, c), true)}</>}
      </div>

      {inv.status === 'VOID' && <p className="rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm">الفاتورة دي اتلغت{inv.voidReason ? `: ${inv.voidReason}` : ''}. مش مطلوب دفعها.</p>}
      {inv.notes && <p className="whitespace-pre-line text-sm"><span className="font-semibold">ملاحظات: </span>{inv.notes}</p>}
      {inv.etaUuid && <p className="text-xs text-muted">رقم الفاتورة الإلكترونية في منظومة الضرائب: <span className="num [overflow-wrap:anywhere]" dir="ltr">{inv.etaUuid}</span></p>}
      {s?.vatRegistered && inv.status !== 'DRAFT' && <p className="text-xs text-muted">الفاتورة الضريبية المعتمدة هي المسجلة على منظومة الفاتورة الإلكترونية بتاعة مصلحة الضرائب.</p>}
      {inv.payments.some(p => p.state === 'CONFIRMED') && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">المدفوعات</span>
          {inv.payments.filter(p => p.state === 'CONFIRMED').map(p => <span key={p.id} className="text-muted">{day(p.paidOn)}: {exact(p.amountMinor, c)} بـ {PAYMENT_METHOD[p.method]}</span>)}
        </div>
      )}
    </article>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* clipboard blocked: the text is on screen */ } }}
      className="inline-flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary print:hidden" aria-label={`انسخ ${label}`}>
      {done ? <><Check size={16} aria-hidden className="text-success" />اتنسخ</> : <><Copy size={16} aria-hidden />انسخ</>}
    </button>
  );
}

function Method({ icon: Icon, title, value, sub, copy, children }: { icon: typeof Wallet; title: string; value?: string; sub?: string; copy?: string; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-faience-ink"><Icon size={20} aria-hidden /></span>
      <div className="min-w-[min(100%,12rem)] flex-1">
        <p className="font-semibold">{title}</p>
        {value && <p className="num text-lg [overflow-wrap:anywhere]" dir="ltr">{value}</p>}
        {sub && <p className="text-sm text-muted">{sub}</p>}
      </div>
      {(copy || children) && <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1 max-sm:[&>*]:justify-center">{copy && <CopyButton value={copy} label={title} />}{children}</div>}
    </li>
  );
}

/** How to pay, with every number one tap from the clipboard. InstaPay first: it's what most Egyptians use. */
export function PayBox({ pay, amount }: { pay: PayMethods; amount?: string }) {
  const any = pay.instapay || pay.instapayLink || pay.wallet || pay.iban || pay.paypalLink;
  if (!any) return <p className="text-muted">الوكالة لسه مكتبتش طرق الدفع. كلّمهم يقولولك تدفع إزاي.</p>;
  return (
    <div className="flex flex-col gap-3">
      {amount && <p className="text-lg">حوّل <b>{amount}</b> بأي طريقة من دول:</p>}
      <ul className="flex flex-col gap-2">
        {(pay.instapay || pay.instapayLink) && (
          <Method icon={Smartphone} title="InstaPay" value={pay.instapay ?? undefined} copy={pay.instapay ?? undefined} sub={pay.instapayLink ? 'أو دوس الزرار يفتحلك التطبيق على الحساب على طول' : undefined}>
            {pay.instapayLink && <a href={pay.instapayLink} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-[var(--radius-md)] bg-primary px-4 font-semibold text-on-primary hover:brightness-110 print:hidden"><ExternalLink size={16} aria-hidden />ادفع بـ InstaPay</a>}
          </Method>
        )}
        {pay.wallet && <Method icon={Wallet} title="فودافون كاش أو أي محفظة موبايل" value={pay.wallet} copy={pay.wallet} sub={pay.walletName ? `باسم ${pay.walletName}` : undefined} />}
        {pay.iban && <Method icon={Landmark} title={`تحويل بنكي${pay.bankName ? `: ${pay.bankName}` : ''}`} value={pay.iban} copy={pay.iban} sub={pay.bankAccountName ? `باسم ${pay.bankAccountName}` : undefined} />}
        {pay.paypalLink && (
          <Method icon={ExternalLink} title="PayPal" sub="لو بتدفع من بره مصر">
            <a href={pay.paypalLink} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-1 rounded-[var(--radius-md)] border border-line px-4 font-semibold hover:bg-surface-2 print:hidden"><ExternalLink size={16} aria-hidden />افتح PayPal</a>
          </Method>
        )}
      </ul>
      {pay.payNote && <p className="text-sm text-muted">{pay.payNote}</p>}
    </div>
  );
}
