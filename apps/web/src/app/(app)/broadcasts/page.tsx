'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { Plus } from 'lucide-react';
import { fetcher, type Client } from '@/lib/api';
import { audienceLabel, type Broadcast } from '@/lib/broadcasts';
import { BroadcastNumbers, BroadcastPill, peopleWord, Progress } from '@/components/broadcast';
import { Empty, ErrorText, PageHeader, Select } from '@/components/ui';
import { useLiveRefresh } from '@/lib/realtime';
import { when } from '@/lib/when';

type Page = { items: Broadcast[]; nextCursor: string | null };

/** Offers sent on WhatsApp to many customers at once, newest first, each with whether it worked. */
export default function BroadcastsPage() {
  const [clientId, setClientId] = useState('');
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const q = clientId ? `?clientId=${clientId}` : '';
  const { data: pages, error, size, setSize, mutate } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (i === 0 ? `/broadcasts${q}` : prev?.nextCursor ? `/broadcasts${q}${q ? '&' : '?'}cursor=${prev.nextCursor}` : null), fetcher as never
  );
  useLiveRefresh('broadcast.', () => mutate());
  const items = pages?.flatMap(p => p.items) ?? [];

  return (
    <>
      <PageHeader title="حملات واتساب" sub="ابعت عرض لكل عملاء البيزنس مرة واحدة، وكل واحد يوصله باسمه. الردود بتيجي في المحادثات."
        action={<Link href="/broadcasts/new" className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] bg-primary px-4 font-semibold text-on-primary hover:brightness-110"><Plus size={18} aria-hidden />حملة جديدة</Link>} />
      <div className="flex flex-col gap-5 p-8 max-md:p-4">
        {!!clients && clients.length > 1 && (
          <div className="w-56 max-sm:w-full">
            <label htmlFor="bc-client" className="sr-only">العميل</label>
            <Select id="bc-client" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">كل العملاء</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        )}
        {error && !pages ? <ErrorText error="مش قادرين نجيب الحملات دلوقتي. جرّب تاني بعد شوية." />
          : !pages ? <p role="status" className="text-muted">بيحمّل…</p>
          : !items.length ? (
            <Empty title="لسه مفيش حملات">
              اختار قالب متوافق عليه من ميتا، واختار مين يوصله (مثلًا اللي كلّموكم آخر شهر)، ودوسلي يبعت لكل واحد باسمه ويقولك مين قرا ومين رد ومين طلب.
              <Link href="/broadcasts/new" className="mt-4 inline-flex h-12 items-center gap-2 rounded-[var(--radius-md)] bg-primary px-5 font-semibold text-on-primary"><Plus size={18} aria-hidden />أول حملة</Link>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map(b => (
                <li key={b.id}>
                  <article className="relative flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4 hover:border-primary/40">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/broadcasts/${b.id}`} className="text-lg font-semibold after:absolute after:inset-0 after:content-['']">{b.name}</Link>
                      <BroadcastPill b={b} />
                      <span className="ms-auto text-sm text-muted">{b.client.name}</span>
                    </div>
                    <p className="text-sm text-muted">
                      {b.status === 'SCHEDULED' ? `هتوصل لحوالي ${peopleWord(b.total)}` : `اتبعتت لـ ${peopleWord(b.stats.total)}`} · {audienceLabel(b.audience)}
                      {b.status !== 'SCHEDULED' && b.startedAt ? ` · ${when(b.startedAt)}` : ''}
                    </p>
                    {b.status === 'SENDING' && <Progress s={b.stats} />}
                    {(b.status === 'DONE' || b.status === 'CANCELLED') && <BroadcastNumbers s={b.stats} />}
                  </article>
                </li>
              ))}
            </ul>
          )}
        {!!pages?.at(-1)?.nextCursor && <button type="button" onClick={() => setSize(size + 1)} className="min-h-11 self-center font-semibold text-primary">اعرض حملات أقدم</button>}
      </div>
    </>
  );
}
