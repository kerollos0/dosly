'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { MessageCircle, Search } from 'lucide-react';
import { api, can, fetcher, type Client } from '@/lib/api';
import { money } from '@/lib/ads';
import { customerSource, sourceLabel, STAGES, stageOf, type Customer, type Stage, type Summary } from '@/lib/customers';
import { ChannelBadge } from '@/components/channel-badge';
import { cx, Empty, ErrorText, Input, PageHeader, Pill, Select } from '@/components/ui';
import { useMe } from '@/lib/me';
import { ago } from '@/lib/when';

type Page = { items: Customer[]; nextCursor: string | null };
const PERIODS = [{ v: '30', label: 'آخر 30 يوم' }, { v: '90', label: 'آخر 3 شهور' }, { v: '', label: 'أي وقت' }];
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const moneyList = (m: { currency: string; minor: number }[]) => m.map(x => money(x.minor, x.currency, true)).join(' + ');

/** Everyone who talked to the agency's clients: where they are, and which ads bring people who buy. */
export default function CustomersPage() {
  const me = useMe();
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const [clientId, setClientId] = useState('');
  const [days, setDays] = useState('90');
  const [stage, setStage] = useState<Stage | ''>('');
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState(''); // the search, a moment after typing stops
  const [rowErr, setRowErr] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim().length >= 2 ? q.trim() : ''), 300); return () => clearTimeout(t); }, [q]);
  const base = new URLSearchParams({ ...(clientId && { clientId }), ...(days && { days }) });
  const { data: sum, error: sumErr, mutate: reSum } = useSWR<Summary>(`/customers/summary?${base}`, fetcher as never, { keepPreviousData: true });
  // The tab counts follow everything chosen below them (ad, tag, search), so they match the list.
  const narrow = new URLSearchParams(base);
  if (source) narrow.set('source', source);
  if (tag) narrow.set('tag', tag);
  if (query) narrow.set('q', query);
  const narrowed = narrow.toString() !== base.toString();
  const { data: stageSum, mutate: reStageSum } = useSWR<Summary>(narrowed ? `/customers/summary?${narrow}` : null, fetcher as never, { keepPreviousData: true });
  const stages = (narrowed ? stageSum?.stages : sum?.stages) ?? {};
  const list = new URLSearchParams(narrow);
  if (stage) list.set('stage', stage);
  const { data: pages, error, size, setSize, mutate } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (i === 0 ? `/customers?${list}` : prev?.nextCursor ? `/customers?${list}&cursor=${prev.nextCursor}` : null), fetcher as never, { keepPreviousData: true }
  );
  const items = pages?.flatMap(p => p.items) ?? [];
  const total = Object.values(stages).reduce((a, b) => a + (b ?? 0), 0);
  const chosenSource = sum?.sources.find(s => s.key === source);
  const canEdit = can.reply(me?.role);
  const clearAll = () => { setStage(''); setSource(''); setTag(''); setQ(''); setQuery(''); };

  // The row stays where it is until the next refresh, so moving someone out of the open tab doesn't look like deleting them.
  async function setStageOf(c: Customer, v: Stage) {
    setRowErr(null);
    const put = (st: Stage) => mutate(ps => ps?.map(p => ({ ...p, items: p.items.map(x => (x.id === c.id ? { ...x, stage: st } : x)) })), { revalidate: false });
    await put(v);
    try {
      await api(`/customers/${c.id}`, { method: 'PATCH', body: { stage: v } });
      await Promise.all([reSum(), reStageSum()]);
    } catch {
      await put(c.stage);
      setRowErr(`مقدرناش نغيّر مرحلة ${c.name || 'الزبون ده'}. جرّب تاني.`);
    }
  }

  return (
    <>
      <PageHeader title="الزباين" sub="كل اللي كلّموا عملاءك: وصلوا لفين، وجم منين. كده تعرف أنهي إعلان بيجيب ناس بتشتري فعلًا." />
      <div className="flex flex-col gap-6 p-8 max-md:p-4">
        <div className="flex flex-wrap gap-3">
          {!!clients && clients.length > 1 && (
            <div className="w-56 max-sm:w-full">
              <label htmlFor="cu-client" className="sr-only">العميل</label>
              <Select id="cu-client" className="h-11" value={clientId} onChange={e => { setClientId(e.target.value); setSource(''); setTag(''); }}>
                <option value="">كل العملاء</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2 max-sm:w-full">
            <label htmlFor="cu-days" className="text-sm whitespace-nowrap text-muted" title="أول مرة كلّموا العميل، أو رجعوا من إعلان">وصلوا في:</label>
            <div className="w-40 max-sm:flex-1">
              <Select id="cu-days" className="h-11" value={days} onChange={e => { setDays(e.target.value); setSource(''); }}>
                {PERIODS.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
              </Select>
            </div>
          </div>
        </div>

        <section aria-labelledby="src-h" className="flex flex-col gap-3">
          <h2 id="src-h" className="font-display text-xl font-bold">منين بيجوا الزباين</h2>
          {sumErr ? <ErrorText error="مش قادرين نجيب الأرقام دلوقتي." /> : !sum ? <p role="status" className="text-muted">بيحمّل…</p> : !sum.sources.length ? <p className="text-muted">لسه محدش كلّم العملاء في الفترة دي.</p> : (
            <>
            <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface sm:hidden">
              {sum.sources.map(r => (
                <li key={r.key}>
                  <button type="button" onClick={() => setSource(source === r.key ? '' : r.key)} aria-pressed={source === r.key}
                    className={cx('flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-start', source === r.key && 'bg-primary/8')}>
                    <span className="font-semibold">{sourceLabel(r)}</span>
                    <span className="text-sm text-muted">
                      كلّموا <span className="num">{r.people}</span> · طلبوا <span className="num">{r.ordered}</span> · اشتروا <span className="num">{r.buyers}</span> ({pct(r.buyers, r.people)}){r.sales.length ? <> · <span className="num">{moneyList(r.sales)}</span></> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-line bg-surface max-sm:hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line text-start text-muted">
                  <th scope="col" className="px-4 py-3 text-start font-semibold">جم منين</th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">كلّموا</th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">طلبوا</th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">اشتروا</th>
                  <th scope="col" className="px-4 py-3 text-start font-semibold">مبيعات</th>
                </tr></thead>
                <tbody>
                  {sum.sources.map(r => (
                    <tr key={r.key} className={cx('border-b border-line last:border-0', source === r.key && 'bg-primary/8')}>
                      <th scope="row" className="px-4 py-2 text-start font-normal">
                        <button type="button" onClick={() => setSource(source === r.key ? '' : r.key)} aria-pressed={source === r.key} className="min-h-11 text-start font-semibold hover:text-primary">{sourceLabel(r)}</button>
                      </th>
                      <td className="num px-4 py-2">{r.people}</td>
                      <td className="num px-4 py-2">{r.ordered}</td>
                      <td className="px-4 py-2"><span className="num">{r.buyers}</span> <span className="text-muted">({pct(r.buyers, r.people)})</span></td>
                      <td className="num px-4 py-2">{r.sales.length ? moneyList(r.sales) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
          <p className="text-sm text-muted">«طلبوا» = عملوا طلب من المتجر (أو الفريق حطّهم في «طلب» أو «اشترى»). «اشتروا» = الطلب وصلهم أو الفريق حطّهم في «اشترى»، والرقم اللي بين القوسين نسبتهم من اللي كلّموا. دوس على أي سطر عشان تشوف الناس دول.</p>
        </section>

        <section aria-labelledby="ppl-h" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="ppl-h" className="font-display text-xl font-bold">قايمة الزباين</h2>
            {source && <span className="flex items-center gap-1"><Pill tone="info">{chosenSource ? sourceLabel(chosenSource) : 'الإعلان اللي اخترته'}</Pill><button type="button" onClick={() => setSource('')} className="min-h-11 px-2 text-sm font-semibold text-primary">اعرض كل الزباين</button></span>}
          </div>
          <div role="group" aria-label="المرحلة" className="flex flex-wrap gap-1 self-start rounded-[var(--radius-md)] border border-line p-0.5">
            {[{ v: '' as const, label: 'الكل', n: total }, ...STAGES.map(s => ({ v: s.v, label: s.label, n: stages[s.v] ?? 0 }))].map(x => (
              <button key={x.v} type="button" aria-pressed={stage === x.v} onClick={() => setStage(x.v)}
                className={cx('flex h-11 items-center gap-1 rounded-[calc(var(--radius-md)-2px)] px-3 font-semibold', stage === x.v ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}>
                {x.label}<span className="num text-xs opacity-80">({x.n})</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="relative w-72 max-sm:w-full">
              <label htmlFor="cu-q" className="sr-only">دوّر باسم أو رقم</label>
              <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input id="cu-q" className="h-11 ps-9" value={q} onChange={e => setQ(e.target.value)} placeholder="دوّر باسم أو رقم" />
            </div>
            {!!sum?.tags.length && (
              <div className="w-48 max-sm:w-full">
                <label htmlFor="cu-tag" className="sr-only">العلامة</label>
                <Select id="cu-tag" className="h-11" value={tag} onChange={e => setTag(e.target.value)}>
                  <option value="">كل العلامات</option>
                  {sum.tags.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
              </div>
            )}
          </div>

          <ErrorText error={rowErr} />
          {error && !pages ? <ErrorText error="مش قادرين نجيب الزباين دلوقتي." />
            : !pages ? <p role="status" className="text-muted">بيحمّل…</p>
            : !items.length ? (total || source || tag || query || stage ? (
              <div className="flex flex-wrap items-center gap-3"><p className="text-muted">مفيش زباين بالاختيارات دي.</p><button type="button" onClick={clearAll} className="min-h-11 px-2 font-semibold text-primary">امسح الاختيارات</button></div>
            ) : <Empty title="لسه مفيش زباين">أول ما حد يكلّم عميل من عملاءك على واتساب أو ماسنجر أو إنستجرام، هيظهر هنا ومعاه جه منين.</Empty>)
            : (
              <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface">
                {items.map(c => {
                  const st = stageOf(c.stage);
                  const label = c.name || (c.username ? `@${c.username}` : c.waId ? `+${c.waId}` : 'من غير اسم');
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="flex min-w-48 flex-1 flex-col gap-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold" dir="auto">{label}</span>
                          {c.conversation && <ChannelBadge channel={c.conversation.channel} />}
                          {c.tags.map(t => <Pill key={t}>{t}</Pill>)}
                        </p>
                        <p className="text-sm text-muted">
                          {customerSource(c)}{!clientId && clients && clients.length > 1 ? ` · ${c.client.name}` : ''}{c.conversation ? ` · آخر رسالة ${ago(c.conversation.lastMessageAt)}` : ''}
                        </p>
                        {c.note && <p className="text-sm">{c.note}</p>}
                      </div>
                      {!!c.orders.length && <p className="text-sm"><span className="text-muted">طلباته: </span><span className="num font-semibold">{moneyList(c.orders)}</span></p>}
                      {canEdit ? (
                        <div className="w-36">
                          <label htmlFor={`st-${c.id}`} className="sr-only">{`مرحلة ${label}`}</label>
                          <Select id={`st-${c.id}`} className="h-11" value={c.stage} onChange={e => void setStageOf(c, e.target.value as Stage)}>
                            {STAGES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                          </Select>
                        </div>
                      ) : <Pill tone={st.tone}>{st.label}</Pill>}
                      {c.conversation && (
                        <Link href={`/inbox?c=${c.conversation.id}`} className="inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2"><MessageCircle size={15} aria-hidden />المحادثة</Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          {!!pages?.at(-1)?.nextCursor && <button type="button" onClick={() => setSize(size + 1)} className="min-h-11 self-center font-semibold text-primary">اعرض كمان</button>}
        </section>
      </div>
    </>
  );
}
