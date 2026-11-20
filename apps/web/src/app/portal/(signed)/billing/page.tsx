'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { Check, CheckCircle2, ChevronLeft } from 'lucide-react';
import { fetcher } from '@/lib/api';
import { money } from '@/lib/ads';
import { day, daysUntil, PERIOD_SHORT, type Invoice, type PayMethods } from '@/lib/billing';
import { InvoicePill, PayBox } from '@/components/invoice';
import { ReportPaid } from '@/components/portal-billing';
import { cx, ErrorText } from '@/components/ui';
import { cairoDayKey, count } from '@/lib/when';
import { usePortalMe } from '@/lib/portal';

type Sub = { id: string; name: string; priceMinor: number; currency: string; months: number; status: 'ACTIVE' | 'PAUSED'; nextInvoiceOn: string | null; description: string | null; features: string[]; postsPerMonth: number | null };
type Billing = { subscriptions: Sub[]; invoices: Invoice[]; due: { currency: string; minor: number }[]; pay: PayMethods };

/** "What do I owe, and how do I pay?" answered first, in big plain words; the rest underneath. */
export default function PortalBilling() {
  const me = usePortalMe();
  const { data, error, mutate } = useSWR<Billing>('/portal/billing', fetcher as never);
  if (error && !data) return <ErrorText error="مش قادرين نجيب الفواتير دلوقتي. جرّب تفتح الصفحة تاني بعد شوية." />;
  if (!data) return <p role="status" className="text-muted">بيحمّل…</p>;
  const today = cairoDayKey(new Date());
  const open = data.invoices.filter(i => i.status === 'ISSUED').sort((a, b) => String(a.dueOn).localeCompare(String(b.dueOn)));
  const past = data.invoices.filter(i => i.status !== 'ISSUED');
  const late = open.filter(i => i.overdue);
  const first = open[0];
  const toPay = open.filter(i => !i.pendingPayments);
  const allReported = !toPay.length;
  const total = data.due.map(d => money(d.minor, d.currency, true)).join(' و');
  const next = data.subscriptions.filter(s => s.status === 'ACTIVE' && s.nextInvoiceOn).map(s => s.nextInvoiceOn!).sort()[0];
  const update = () => mutate();

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="الخلاصة" className={cx('flex flex-col gap-3 rounded-[var(--radius-lg)] border p-6 max-sm:p-4', late.length ? 'border-danger/30 bg-danger/5' : open.length ? 'border-primary/30 bg-primary/5' : 'border-success/30 bg-success/5')}>
        <h1 className="font-display text-2xl font-bold">الفواتير</h1>
        {open.length ? (
          <>
            <p className="text-2xl font-bold">عليك {total}</p>
            <p className="text-lg">
              {late.length ? <span className="font-semibold text-danger">{count(late.length, 'فاتورة واحدة عدّى ميعادها', 'فاتورتين عدّى ميعادهم', 'فواتير عدّى ميعادها', 'فاتورة عدّى ميعادها')}.</span>
                : first?.dueOn ? (daysUntil(first.dueOn, today) === 0 ? 'آخر ميعاد للدفع النهارده.' : `آخر ميعاد للدفع ${day(first.dueOn)}.`) : null}
              {' '}{allReported ? 'وصلنا إنك دفعت، والوكالة بتتأكد إن الفلوس وصلت.' : 'طرق الدفع تحت.'}
            </p>
          </>
        ) : (
          <p className="flex items-start gap-2 text-lg"><CheckCircle2 size={24} aria-hidden className="mt-0.5 shrink-0 text-success" />مفيش عليك فلوس دلوقتي. شكرًا يا {me.user.name.split(' ')[0]}.{next ? ` الفاتورة الجاية ${day(next)}.` : ''}</p>
        )}
      </section>

      {!allReported && (
        <section aria-labelledby="pay-h" className="flex flex-col gap-3">
          <h2 id="pay-h" className="font-display text-xl font-bold">تدفع إزاي</h2>
          <PayBox pay={data.pay} amount={toPay.length === 1 ? money(toPay[0]!.totalMinor - toPay[0]!.paidMinor, toPay[0]!.currency, true) : total} />
          {!data.pay.payNote && <p className="text-sm text-muted">بعد ما تحوّل، دوس «أنا حوّلت الفلوس» على الفاتورة واكتب رقم العملية.</p>}
        </section>
      )}

      {!!open.length && (
        <section aria-labelledby="open-h" className="flex flex-col gap-3">
          <h2 id="open-h" className="font-display text-xl font-bold">مستنية الدفع</h2>
          <ul className="flex flex-col gap-3">
            {open.map(i => (
              <li key={i.id} className={cx('flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-surface p-4', i.overdue ? 'border-danger/40' : 'border-line')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-2xl font-bold tabular-nums">{money(i.totalMinor - i.paidMinor, i.currency, true)}</span>
                  <InvoicePill inv={i} client />
                </div>
                <p className="text-muted">{i.items[0]?.description}{i.dueOn ? ` · آخر ميعاد ${day(i.dueOn)}` : ''}</p>
                <ReportPaid inv={i} pay={data.pay} onDone={update} />
                <Link href={`/portal/invoices/${i.id}`} className="flex items-center gap-1 self-start font-semibold text-primary">شوف الفاتورة كاملة<ChevronLeft size={16} aria-hidden /></Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!data.subscriptions.length && (
        <section aria-labelledby="pkg-h" className="flex flex-col gap-3">
          <h2 id="pkg-h" className="font-display text-xl font-bold">{data.subscriptions.length === 1 ? 'باقتك' : 'باقاتك'}</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {data.subscriptions.map(s => (
              <li key={s.id} className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
                <p className="text-lg font-semibold">{s.name}</p>
                <p className="font-display text-xl font-bold tabular-nums">{money(s.priceMinor, s.currency, true)} <span className="text-base font-normal text-muted">{PERIOD_SHORT[s.months]}</span></p>
                {!!s.features.length && <ul className="flex flex-col gap-1">{s.features.map(f => <li key={f} className="flex items-start gap-2"><Check size={16} aria-hidden className="mt-1 shrink-0 text-success" />{f}</li>)}</ul>}
                <p className="text-sm text-muted">{s.status === 'PAUSED' ? 'متوقفة مؤقتًا' : s.nextInvoiceOn ? `الفاتورة الجاية ${day(s.nextInvoiceOn)}` : ''}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!past.length && (
        <section aria-labelledby="past-h" className="flex flex-col gap-3">
          <h2 id="past-h" className="font-display text-xl font-bold">فواتير قديمة</h2>
          <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface">
            {past.map(i => (
              <li key={i.id}>
                <Link href={`/portal/invoices/${i.id}`} className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2">
                  <span className="font-semibold">{i.issueOn ? day(i.issueOn) : ''}</span>
                  <InvoicePill inv={i} client />
                  <span className="ms-auto tabular-nums">{money(i.totalMinor, i.currency, true)}</span>
                  <ChevronLeft size={16} aria-hidden className="text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!data.invoices.length && !data.subscriptions.length && <p className="text-center text-muted">لسه مفيش فواتير. أول ما الوكالة تبعتلك فاتورة هتلاقيها هنا.</p>}
    </div>
  );
}
