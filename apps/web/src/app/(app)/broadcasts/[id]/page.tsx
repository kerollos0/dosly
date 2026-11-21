'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import { useLiveRefresh } from '@/lib/realtime';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { audienceLabel, type Broadcast, type Recipient } from '@/lib/broadcasts';
import { Bubble, BroadcastNumbers, BroadcastPill, peopleWord, Progress } from '@/components/broadcast';
import { Button, cx, ErrorText, Pill } from '@/components/ui';
import { when } from '@/lib/when';

type Detail = { broadcast: Broadcast; recipients: Recipient[]; nextCursor: string | null };
const SHOWS = [{ v: '', label: 'الكل' }, { v: 'replied', label: 'ردّوا' }, { v: 'failed', label: 'موصلتهمش' }, { v: 'pending', label: 'لسه' }] as const;
const STATE: Record<string, { label: string; tone: 'good' | 'info' | 'neutral' | 'bad' | 'sun' }> = {
  READ: { label: 'قراها', tone: 'good' }, DELIVERED: { label: 'وصلته', tone: 'info' }, SENT: { label: 'اتبعتت', tone: 'neutral' }, QUEUED: { label: 'بتتبعت', tone: 'neutral' },
  PENDING: { label: 'لسه', tone: 'neutral' }, SKIPPED: { label: 'اتشال (طلب ميوصلوش عروض)', tone: 'neutral' }, FAILED: { label: 'موصلتهوش', tone: 'bad' }
};

export default function BroadcastPage() {
  const { id } = useParams<{ id: string }>();
  const [show, setShow] = useState('');
  const base = `/broadcasts/${id}?show=${show}`;
  const { data: pages, error, mutate, size, setSize } = useSWRInfinite<Detail>(
    (i, prev: Detail | null) => (i === 0 ? base : prev?.nextCursor ? `${base}&cursor=${prev.nextCursor}` : null), fetcher as never,
    { refreshInterval: d => {
      const b = d?.[0]?.broadcast;
      if (b?.status === 'SENDING') return 3000;
      // Delivered / read / replied keep moving for a while after the last send.
      return b?.finishedAt && Date.now() - new Date(b.finishedAt).getTime() < 2 * 3600_000 ? 15000 : 0;
    } }
  );
  useLiveRefresh('broadcast.', () => mutate());
  // Switching the people filter loads a new list: keep showing the campaign meanwhile.
  const last = useRef<Detail | null>(null);
  if (pages?.[0]) last.current = pages[0];
  const data = pages?.[0] ?? last.current;
  const listLoading = !pages;
  const recipients = pages?.flatMap(p => p.recipients) ?? [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  if (error && !data) return <p className="p-8"><ErrorText error={(error as Error).message} /></p>;
  if (!data) return <p role="status" className="p-8 text-muted">بيحمّل…</p>;
  const b = data.broadcast, s = b.stats;

  async function cancel() {
    setBusy(true); setErr(null);
    try { await api(`/broadcasts/${b.id}/cancel`, { method: 'POST' }); setStopping(false); await mutate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const headline = b.status === 'SCHEDULED' ? `هتتبعت ${when(b.scheduledAt)} لحوالي ${peopleWord(b.total)}.`
    : b.status === 'SENDING' ? 'بتتبعت دلوقتي. تقدر تقفل الصفحة، هتكمل لوحدها.'
    : b.status === 'CANCELLED' ? `اتوقفت${s.pending ? `، و${peopleWord(s.pending)} موصلهمش` : ''}.`
    : s.replied ? `${peopleWord(s.replied)} ردّوا على العرض${s.orders ? `، و${s.orders === 1 ? 'طلب واحد' : `${s.orders} طلبات`} جه من المتجر في أسبوع` : ''}.`
    : `وصلت لـ ${peopleWord(s.delivered)}. الردود بتيجي في المحادثات.`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8 max-md:p-4">
      <Link href="/broadcasts" className="flex items-center gap-1 self-start text-sm font-semibold text-primary"><ArrowRight size={16} aria-hidden />كل الحملات</Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2"><h1 className="font-display text-[28px] font-bold leading-9">{b.name}</h1><BroadcastPill b={b} /></div>
        <p className="text-muted">{b.client.name} · <bdi dir="ltr">{b.waNumber.displayPhone}</bdi> · {audienceLabel(b.audience)}{b.createdBy ? ` · بعتها ${b.createdBy.name}` : ''}</p>
        <p className="text-lg">{headline}</p>
        {(b.status === 'SCHEDULED' || b.status === 'SENDING') && (
          stopping ? (
            <div className="flex max-w-md flex-col gap-2 rounded-[var(--radius-md)] border border-line bg-surface p-3">
              <p className="text-sm">{b.status === 'SCHEDULED' ? 'الحملة مش هتتبعت خالص.' : 'اللي وصلهم خلاص مش هيتلغي، والباقي مش هيتبعتلهم.'} متأكد؟</p>
              <div className="grid grid-cols-2 gap-2"><Button variant="danger" className="h-11" disabled={busy} onClick={cancel}>أيوه، وقّفها</Button><Button variant="ghost" className="h-11" onClick={() => setStopping(false)}>رجوع</Button></div>
            </div>
          ) : <Button variant="ghost" className="h-11 self-start text-danger" onClick={() => setStopping(true)}>{b.status === 'SCHEDULED' ? 'ألغي الحملة' : 'وقّف الإرسال'}</Button>
        )}
        <ErrorText error={err} />
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-5">
          {b.status === 'SENDING' && <Progress s={s} />}
          {(b.status === 'DONE' || b.status === 'CANCELLED') && <BroadcastNumbers s={s} big />}
          {b.status !== 'SCHEDULED' && s.failed > 0 && <p className="text-sm text-muted">{peopleWord(s.failed)} موصلتهمش الرسالة. السبب جنب كل واحد في «موصلتهمش».</p>}

          {b.status !== 'SCHEDULED' && (
            <section aria-labelledby="ppl-h" className="flex flex-col gap-3">
              <h2 id="ppl-h" className="font-display text-xl font-bold">الناس</h2>
              <div role="group" aria-label="اعرض" className="flex flex-wrap gap-1 self-start rounded-[var(--radius-md)] border border-line p-0.5">
                {SHOWS.map(x => {
                  const n = x.v === 'replied' ? s.replied : x.v === 'failed' ? s.failed : x.v === 'pending' ? s.pending : s.total;
                  if (x.v === 'pending' && !n) return null;
                  return (
                    <button key={x.v} type="button" aria-pressed={show === x.v} onClick={() => setShow(x.v)}
                      className={cx('flex h-11 items-center gap-1 rounded-[calc(var(--radius-md)-2px)] px-3 font-semibold', show === x.v ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}>{x.label}<span className="num text-xs opacity-80">({n})</span></button>
                  );
                })}
              </div>
              {listLoading ? <p role="status" className="text-muted">بيحمّل…</p> : !recipients.length ? <p className="text-muted">{show === 'replied' ? 'لسه محدش رد.' : show === 'failed' ? 'كله وصله.' : 'مفيش حد هنا.'}</p> : (
                <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface">
                  {recipients.map(r => {
                    const st = STATE[r.state] ?? STATE.SENT!;
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                        <span className="font-semibold">{r.name || 'من غير اسم'}</span>
                        <bdi dir="ltr" className="num text-sm text-muted">{r.phone ? `+${r.phone}` : ''}</bdi>
                        <Pill tone={st.tone}>{st.label}</Pill>
                        {r.repliedAt && <Pill tone="sun">رد</Pill>}
                        {r.optedOut && r.state !== 'SKIPPED' && <Pill tone="neutral">طلب ميوصلوش عروض</Pill>}
                        {r.conversationId && (
                          <Link href={`/inbox?c=${r.conversationId}`} className="ms-auto inline-flex h-11 items-center gap-2 rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2"><MessageCircle size={15} aria-hidden />المحادثة</Link>
                        )}
                        {r.error && <p className="w-full text-sm text-danger">{r.error}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!!pages?.at(-1)?.nextCursor && <Button variant="ghost" className="h-11 self-center" onClick={() => setSize(size + 1)}>اعرض كمان</Button>}
            </section>
          )}
        </div>

        <aside aria-label="الرسالة" className="flex flex-col gap-3">
          <h2 className="font-semibold">الرسالة زي ما وصلت (بالاسم الأول لكل واحد)</h2>
          {b.preview && <Bubble image={b.hasHeader ? `/api/broadcasts/${b.id}/header` : null} header={b.preview.header} body={b.preview.body} footer={b.preview.footer} buttons={b.preview.buttons} />}
        </aside>
      </div>
    </div>
  );
}
