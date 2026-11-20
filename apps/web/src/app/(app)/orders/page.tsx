'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { CheckCircle2, Search } from 'lucide-react';
import { fetcher, type Client } from '@/lib/api';
import { useMe } from '@/lib/me';
import type { Order } from '@/lib/orders';
import { OrderCard } from '@/components/orders';
import { Button, cx, Empty, ErrorText, Input, PageHeader, Select } from '@/components/ui';
import { count } from '@/lib/when';
import { useLiveRefresh } from '@/lib/realtime';

type View = 'followup' | 'waiting' | 'all';
type Page = { items: Order[]; nextCursor: string | null };
type Counts = { followUp: number; waiting: number; stores: number };

const VIEWS: { v: View; label: string }[] = [
  { v: 'followup', label: 'محتاجة مكالمة' },
  { v: 'waiting', label: 'مستنية العميل يأكد' },
  { v: 'all', label: 'كل الطلبات' }
];

/**
 * Store orders. The first tab answers "who do I call?": cash-on-delivery orders nobody confirmed
 * on WhatsApp, oldest first, each with one-tap buttons for what the customer said on the phone.
 */
export default function OrdersPage() {
  const me = useMe();
  const [view, setView] = useState<View>('followup');
  const [clientId, setClientId] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const base = `view=${view}${clientId ? `&clientId=${clientId}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}`;
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const { data: counts, mutate: mutateCounts } = useSWR<Counts>(`/orders/counts${clientId ? `?clientId=${clientId}` : ''}`, fetcher as never);
  const { data: pages, error, size, setSize, mutate, isLoading } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (i === 0 ? `/orders?${base}` : prev?.nextCursor ? `/orders?${base}&cursor=${prev.nextCursor}` : null),
    fetcher as never
  );
  useLiveRefresh('order.', () => mutate());
  const items = pages?.flatMap(p => p.items) ?? [];
  const more = !!pages?.at(-1)?.nextCursor;
  const manage = me.role === 'OWNER' || me.role === 'MANAGER';

  // A handled order leaves the follow-up list at once; the counts catch up.
  const changed = (o: Order) => {
    void mutate(ps => ps?.map(p => ({ ...p, items: view === 'followup' && (o.followUpDoneAt || o.confirm === 'SENT') ? p.items.filter(x => x.id !== o.id) : p.items.map(x => (x.id === o.id ? o : x)) })), { revalidate: true });
    void mutateCounts();
  };

  if (counts && counts.stores === 0 && !clientId) {
    return (
      <>
        <PageHeader title="الطلبات" />
        <Empty title="لسه مفيش متجر مربوط">
          {manage
            ? <>اربط متجر العميل على EasyOrders أو Shopify من <Link href="/channels#stores" className="font-semibold text-primary underline">صفحة القنوات</Link>. بعدها كل طلب دفع عند الاستلام هيوصله تأكيد على واتساب لوحده، واللي ميأكدش هيظهر هنا عشان تكلمه.</>
            : 'لما المدير يربط متجر العميل، الطلبات اللي محتاجة تأكيد هتظهر هنا.'}
        </Empty>
      </>
    );
  }

  const tabCount = (v: View) => (v === 'followup' ? counts?.followUp : v === 'waiting' ? counts?.waiting : undefined);
  return (
    <>
      <PageHeader title="الطلبات" sub="كل طلب دفع عند الاستلام بيوصل صاحبه رسالة تأكيد على واتساب. اللي ميردش أو يلغي بيظهر هنا عشان حد يكلمه." />
      <div className="flex flex-col gap-4 p-8 max-md:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="اعرض" className="flex flex-wrap rounded-[var(--radius-md)] border border-line p-0.5">
            {VIEWS.map(t => (
              <button key={t.v} type="button" aria-pressed={view === t.v} onClick={() => setView(t.v)}
                className={cx('flex h-10 items-center gap-2 rounded-[calc(var(--radius-md)-2px)] px-4 font-semibold focus-visible:outline-2 focus-visible:outline-primary', view === t.v ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}>
                {t.label}
                {!!tabCount(t.v) && <span className={cx('num rounded-full px-1.5 text-xs', view === t.v ? 'bg-on-primary/20' : t.v === 'followup' ? 'bg-warning text-white' : 'bg-surface-2')}>{tabCount(t.v)}</span>}
              </button>
            ))}
          </div>
          <label htmlFor="orders-client" className="sr-only">العميل</label>
          <Select id="orders-client" value={clientId} onChange={e => setClientId(e.target.value)} className="w-48">
            <option value="">كل العملاء</option>
            {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <form role="search" onSubmit={e => { e.preventDefault(); setSearch(q.trim()); }} className="flex items-center gap-2 max-sm:w-full">
            <label htmlFor="orders-q" className="sr-only">دوّر برقم الطلب أو الموبايل أو الاسم</label>
            <Input id="orders-q" value={q} onChange={e => { setQ(e.target.value); if (!e.target.value) setSearch(''); }} placeholder="رقم الطلب أو الموبايل أو الاسم" className="w-64 max-sm:flex-1" />
            <Button variant="ghost" aria-label="دوّر"><Search size={16} aria-hidden /></Button>
          </form>
        </div>

        {error && !pages ? <ErrorText error="مش قادرين نجيب الطلبات دلوقتي. جرّب تاني بعد شوية." />
          : isLoading && !pages ? <p role="status" className="text-muted">بيحمّل…</p>
          : !items.length ? (
            view === 'followup' && !search
              ? <p role="status" className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-success/30 bg-success/5 p-5 text-lg"><CheckCircle2 size={24} aria-hidden className="text-success" />كله تمام. مفيش طلب محتاج مكالمة دلوقتي.</p>
              : <p className="text-muted">{search ? 'مفيش طلبات بالبحث ده.' : counts?.stores === 0 ? 'العميل ده لسه ملوش متجر مربوط.' : view === 'waiting' ? 'مفيش طلبات مستنية تأكيد.' : 'لسه مفيش طلبات.'}</p>
          ) : (
            <>
              {view === 'followup' && !search && <p className="text-muted">{count(counts?.followUp ?? items.length, 'طلب واحد محتاج', 'طلبين محتاجين', 'طلبات محتاجة', 'طلب محتاج')} مكالمة. ابدأ بالأقدم.</p>}
              <ul className="grid gap-3 xl:grid-cols-2">
                {items.map(o => <li key={o.id}><OrderCard o={o} showClient={!clientId} onChange={changed} /></li>)}
              </ul>
              {more && <Button variant="ghost" className="self-center" onClick={() => setSize(size + 1)}>اعرض طلبات أكتر</Button>}
            </>
          )}
      </div>
    </>
  );
}
