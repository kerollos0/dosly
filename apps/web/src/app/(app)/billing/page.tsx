'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { CheckCircle2, Plus } from 'lucide-react';
import { fetcher, type Client } from '@/lib/api';
import { money } from '@/lib/ads';
import type { BillingCounts, BillingSettings, Invoice, Package } from '@/lib/billing';
import { BillingTabs, InvoiceEditor, InvoiceRow } from '@/components/billing';
import { Button, cx, Empty, ErrorText, Modal, PageHeader, Select } from '@/components/ui';
import { cairoDayKey, count } from '@/lib/when';
import { useLiveRefresh } from '@/lib/realtime';

type View = 'unpaid' | 'check' | 'draft' | 'paid' | 'all';
type Page = { items: Invoice[]; nextCursor: string | null };
const VIEWS: { v: View; label: string }[] = [
  { v: 'unpaid', label: 'مستنية دفع' }, { v: 'check', label: 'العميل قال إنه دفع' }, { v: 'draft', label: 'مسودات' }, { v: 'paid', label: 'اتدفعت' }, { v: 'all', label: 'الكل' }
];

/** Money the agency is owed: one sentence on top, then the invoices that need something, the oldest debt first. */
export default function BillingPage() {
  return <Suspense><Billing /></Suspense>;
}

function Billing() {
  const router = useRouter();
  const q = useSearchParams().get('view');
  const [view, setView] = useState<View>(VIEWS.some(t => t.v === q) ? (q as View) : 'unpaid');
  const [clientId, setClientId] = useState('');
  const [creating, setCreating] = useState(false);
  const today = cairoDayKey(new Date());
  const base = `view=${view}${clientId ? `&clientId=${clientId}` : ''}`;
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const { data: packages } = useSWR<Package[]>('/billing/packages', fetcher as never);
  const { data: settings } = useSWR<BillingSettings>('/billing/settings', fetcher as never);
  const { data: counts, mutate: mutateCounts } = useSWR<BillingCounts>('/billing/counts', fetcher as never);
  const { data: pages, error, size, setSize, mutate, isLoading } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (i === 0 ? `/billing/invoices?${base}` : prev?.nextCursor ? `/billing/invoices?${base}&cursor=${prev.nextCursor}` : null),
    fetcher as never
  );
  useLiveRefresh('invoice.', () => { void mutate(); void mutateCounts(); });
  const items = pages?.flatMap(p => p.items) ?? [];
  const changed = () => { void mutate(); void mutateCounts(); };
  const tabCount = (v: View) => (v === 'unpaid' ? counts?.unpaid : v === 'check' ? counts?.toCheck : v === 'draft' ? counts?.drafts : undefined);
  const owed = counts?.owed.filter(o => o.minor > 0) ?? [];
  const noPay = settings && !settings.instapay && !settings.instapayLink && !settings.wallet && !settings.iban && !settings.paypalLink;

  return (
    <>
      <PageHeader title="الفواتير" sub="الفواتير بتوصل العميل في البوابة، ومعاها طرق الدفع. لما يحوّل بيقولك، وإنت تأكد بضغطة." action={<Button onClick={() => setCreating(true)}><Plus size={18} aria-hidden />فاتورة جديدة</Button>} />
      <BillingTabs />
      <div className="flex flex-col gap-5 p-8 max-md:p-4">
        {counts && (
          <section aria-label="الخلاصة" className={cx('flex flex-col gap-1 rounded-[var(--radius-lg)] border p-5', counts.overdue ? 'border-danger/30 bg-danger/5' : 'border-line bg-surface-2')}>
            {owed.length ? (
              <p className="text-lg">ليك عند العملاء <b>{owed.map(o => money(o.minor, o.currency, true)).join(' و')}</b>{counts.overdue ? <>، منهم <b className="text-danger">{count(counts.overdue, 'فاتورة واحدة متأخرة', 'فاتورتين متأخرين', 'فواتير متأخرة', 'فاتورة متأخرة')}</b>.</> : '، ولسه مفيش حاجة متأخرة.'}</p>
            ) : <p className="flex items-center gap-2 text-lg"><CheckCircle2 size={22} aria-hidden className="text-success" />مفيش فلوس متأخرة على حد. كله دافع.</p>}
            {!!counts.toCheck && <p>و{count(counts.toCheck, 'عميل واحد قال', 'عميلين قالوا', 'عملاء قالوا', 'عميل قال')} إنه حوّل، اتأكد إن الفلوس وصلت ودوس «الفلوس وصلت».</p>}
          </section>
        )}
        {noPay && <p role="note" className="rounded-[var(--radius-md)] border border-warning/40 bg-warning/5 p-3 text-sm">لسه مكتبتش طرق الدفع، فالعميل مش هيعرف يدفعلك إزاي. <a href="/billing/settings" className="font-semibold text-primary underline">اكتب رقم InstaPay أو المحفظة</a>.</p>}

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="اعرض" className="flex flex-wrap rounded-[var(--radius-md)] border border-line p-0.5">
            {VIEWS.map(t => (
              <button key={t.v} type="button" aria-pressed={view === t.v} onClick={() => setView(t.v)}
                className={cx('flex h-10 items-center gap-2 rounded-[calc(var(--radius-md)-2px)] px-3 font-semibold focus-visible:outline-2 focus-visible:outline-primary', view === t.v ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}>
                {t.label}
                {!!tabCount(t.v) && <span className={cx('num rounded-full px-1.5 text-xs', view === t.v ? 'bg-on-primary/20' : t.v === 'check' ? 'bg-sun text-[#0F1B2D]' : 'bg-surface-2')}>{tabCount(t.v)}</span>}
              </button>
            ))}
          </div>
          <label htmlFor="bill-client" className="sr-only">العميل</label>
          <div className="w-48 max-sm:w-full">
            <Select id="bill-client" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">كل العملاء</option>
              {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>

        {error && !pages ? <ErrorText error="مش قادرين نجيب الفواتير دلوقتي. جرّب تاني بعد شوية." />
          : isLoading && !pages ? <p role="status" className="text-muted">بيحمّل…</p>
          : !items.length ? (
            view === 'unpaid' && !clientId && counts && counts.unpaid + counts.drafts === 0
              ? <Empty title="لسه مفيش فواتير">اعمل باقة لكل عميل من «الباقات والعملاء»، والفاتورة هتطلع لوحدها كل شهر. أو دوس «فاتورة جديدة» لشغل مرة واحدة.</Empty>
              : <p className="text-muted">{view === 'check' ? 'مفيش تحويلات مستنية مراجعتك.' : view === 'draft' ? 'مفيش مسودات.' : 'مفيش فواتير هنا.'}</p>
          ) : (
            <>
              <ul className="grid gap-3 xl:grid-cols-2">{items.map(i => <li key={i.id}><InvoiceRow inv={i} today={today} showClient={!clientId} onChange={changed} /></li>)}</ul>
              {!!pages?.at(-1)?.nextCursor && <Button variant="ghost" className="self-center" onClick={() => setSize(size + 1)}>اعرض فواتير أكتر</Button>}
            </>
          )}
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="فاتورة جديدة">
        {creating && clients && settings && (
          <InvoiceEditor clients={clients} packages={packages ?? []} vatRateBp={settings.vatRateBp} vatDefault={settings.vatRegistered}
            onSaved={inv => { setCreating(false); changed(); router.push(`/billing/invoices/${inv.id}`); }} />
        )}
      </Modal>
    </>
  );
}
