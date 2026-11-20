'use client';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { ar } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, ImagePlus } from 'lucide-react';
import { api, can, fetcher, REVIEW_LABEL, type Client, type Post } from '@/lib/api';
import { useMe } from '@/lib/me';
import { cairoDayKey, dayMonth, dayWord, timeWord, when } from '@/lib/when';
import { Button, ErrorText, Field, Modal, PageHeader, Pill, Select, Textarea, cx } from '@/components/ui';

const STATUS: Record<string, { l: string; t: 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'sun' }> = {
  DRAFT: { l: 'مسودة', t: 'neutral' }, SCHEDULED: { l: 'متجدول', t: 'sun' }, PUBLISHING: { l: 'بيتنشر', t: 'info' },
  PUBLISHED: { l: 'اتنشر', t: 'good' }, PARTIAL: { l: 'اتنشر جزئيًا', t: 'warn' }, FAILED: { l: 'منزلش', t: 'bad' }
};
const WEEK_START = 6; // Saturday, as agencies in Egypt plan their week

export default function CalendarPage() {
  const me = useMe();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [creatingOn, setCreatingOn] = useState<Date | null>(null);
  const [open, setOpen] = useState<Post | null>(null);
  // "?show=failed" etc. comes from the today screen. Read after mount: the page is prerendered without a query.
  const [show, setShow] = useState<Show | null>(null);
  useEffect(() => { const v = new URLSearchParams(window.location.search).get('show'); if (v && v in SHOW) setShow(v as Show); }, []);
  const closeShow = () => { setShow(null); history.replaceState(null, '', '/calendar'); };
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_START });
  const to = startOfDay(addDays(endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_START }), 1));
  const key = `/posts?from=${from.toISOString()}&to=${to.toISOString()}`;
  const { data: posts, mutate } = useSWR<Post[]>(key, fetcher as never);
  const days = useMemo(() => { const d: Date[] = []; for (let x = from; x < to; x = addDays(x, 1)) d.push(x); return d; }, [from.getTime(), to.getTime()]);

  return (
    <>
      <PageHeader title="جدولة البوستات" sub="البوستات بتتنشر لوحدها في ميعادها على فيسبوك وإنستجرام."
        action={<div className="flex items-center gap-2">
          <Button variant="ghost" className="size-11 px-0" onClick={() => setMonth(m => addMonths(m, -1))} aria-label="الشهر اللي فات"><ChevronRight size={18} aria-hidden /></Button>
          <span className="w-32 text-center font-semibold">{format(month, 'MMMM yyyy', { locale: ar })}</span>
          <Button variant="ghost" className="size-11 px-0" onClick={() => setMonth(m => addMonths(m, 1))} aria-label="الشهر الجاي"><ChevronLeft size={18} aria-hidden /></Button>
          {can.write(me.role) && <Button onClick={() => setCreatingOn(new Date())}>بوست جديد</Button>}
        </div>} />
      {show && <NeedsHand show={show} onOpen={setOpen} onClose={closeShow} />}
      {/* On a phone a month grid is seven slivers; a list of the days that have posts reads easier. */}
      <Agenda month={month} posts={posts} onOpen={setOpen} onNew={can.write(me.role) ? () => setCreatingOn(new Date()) : undefined} />
      <div className="overflow-x-auto p-8 max-md:hidden">
        <div className="grid min-w-[760px] grid-cols-7 border-s border-t border-line">
          {days.slice(0, 7).map(d => <div key={`h${d.toISOString()}`} className="border-e border-b border-line bg-surface-2 px-2 py-1.5 text-[13px] font-semibold">{format(d, 'EEEE', { locale: ar })}</div>)}
          {days.map(d => {
            const dayPosts = posts?.filter(p => isSameDay(new Date(p.scheduledAt ?? p.createdAt), d)) ?? [];
            return (
              <div key={d.toISOString()} className={cx('flex min-h-28 flex-col gap-1 border-e border-b border-line p-1.5', !isSameMonth(d, month) && 'bg-surface-2/50')}>
                <button className={cx('num self-start rounded px-1 text-sm', isSameDay(d, new Date()) ? 'bg-sun font-bold text-[#0F1B2D]' : 'text-muted')}
                  onClick={() => can.write(me.role) && setCreatingOn(d)} aria-label={`بوست جديد يوم ${format(d, 'd MMMM', { locale: ar })}`}>{format(d, 'd')}</button>
                {dayPosts.map(p => (
                  <button key={p.id} onClick={() => setOpen(p)} className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-line bg-surface p-1.5 text-start text-xs hover:border-faience">
                    <span className="flex items-center justify-between gap-1"><span className="num font-semibold">{p.scheduledAt ? format(new Date(p.scheduledAt), 'HH:mm') : '—'}</span><Pill tone={STATUS[p.status]?.t}>{STATUS[p.status]?.l}</Pill></span>
                    {p.status === 'SCHEDULED' && (p.clientReview === 'PENDING' || p.clientReview === 'CHANGES_REQUESTED') && <span className={cx('text-xs font-semibold', p.clientReview === 'PENDING' ? 'text-warning' : 'text-danger')}>{REVIEW_LABEL[p.clientReview]}</span>}
                    <span className="truncate text-faience-ink">{p.client.name}</span>
                    <span className="line-clamp-2 text-muted">{p.caption}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {creatingOn && <Composer day={creatingOn} onClose={() => setCreatingOn(null)} onSaved={() => { setCreatingOn(null); void mutate(); }} />}
      {open && <PostDetail post={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void mutate(); }} />}
    </>
  );
}

function Agenda({ month, posts, onOpen, onNew }: { month: Date; posts?: Post[]; onOpen: (p: Post) => void; onNew?: () => void }) {
  if (!posts) return <p role="status" className="p-4 text-muted md:hidden">بيحمّل…</p>;
  const ym = format(month, 'yyyy-MM');
  const at = (p: Post) => new Date(p.scheduledAt ?? p.createdAt);
  const inMonth = posts.filter(p => cairoDayKey(at(p)).startsWith(ym))
    .sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
  const groups = new Map<string, Post[]>();
  for (const p of inMonth) { const k = cairoDayKey(at(p)); groups.set(k, [...(groups.get(k) ?? []), p]); }
  return (
    <div className="flex flex-col gap-5 p-4 md:hidden">
      {!groups.size && <p className="text-muted">مفيش بوستات الشهر ده.{onNew && <> <button onClick={onNew} className="font-semibold text-primary underline">اعمل بوست جديد</button>.</>}</p>}
      {(() => {
        // Today and what's coming first; days already gone fold away under them.
        const todayKey = cairoDayKey(new Date());
        const all = [...groups];
        const ahead = all.filter(([k]) => k >= todayKey), past = all.filter(([k]) => k < todayKey).reverse();
        const render = ([k, list]: [string, Post[]]) => <AgendaDay key={k} k={k} list={list} onOpen={onOpen} />;
        return (
          <>
            {ahead.map(render)}
            {!ahead.length && !!past.length && <p className="text-muted">مفيش بوستات جاية الشهر ده.</p>}
            {!!past.length && (
              <details className="flex flex-col gap-5" open={!ahead.length}>
                <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-muted">اللي فات من الشهر ({past.reduce((n, [, l]) => n + l.length, 0)})</summary>
                <div className="mt-3 flex flex-col gap-5">{past.map(render)}</div>
              </details>
            )}
          </>
        );
      })()}
    </div>
  );
}

function AgendaDay({ k, list, onOpen }: { k: string; list: Post[]; onOpen: (p: Post) => void }) {
  const day = new Date(list[0]!.scheduledAt ?? list[0]!.createdAt);
  const w = dayWord(day);
  return (
    <section aria-labelledby={`ag-${k}`} className="flex flex-col gap-2">
      <h2 id={`ag-${k}`} className={cx('text-sm font-semibold', k === cairoDayKey(new Date()) ? 'text-primary' : 'text-muted')}>{w.includes(' ') ? w : `${w} · ${dayMonth(day)}`}</h2>
      <ul className="flex flex-col gap-2">
        {list.map(p => <li key={p.id}><PostRow p={p} onOpen={onOpen} /></li>)}
      </ul>
    </section>
  );
}

function PostRow({ p, onOpen, withDay = false }: { p: Post; onOpen: (p: Post) => void; withDay?: boolean }) {
  return (
    <button onClick={() => onOpen(p)} className="flex w-full flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-3 text-start focus-visible:outline-2 focus-visible:outline-primary">
              <span className="flex items-center justify-between gap-2"><span className="font-semibold">{p.client.name}</span><Pill tone={STATUS[p.status]?.t}>{STATUS[p.status]?.l}</Pill></span>
              <span className="text-sm text-muted">{p.scheduledAt ? (withDay ? when(p.scheduledAt) : timeWord(new Date(p.scheduledAt))) : 'من غير ميعاد'}</span>
              {p.status === 'SCHEDULED' && (p.clientReview === 'PENDING' || p.clientReview === 'CHANGES_REQUESTED') && <span className={cx('text-sm font-semibold', p.clientReview === 'PENDING' ? 'text-warning' : 'text-danger')}>{REVIEW_LABEL[p.clientReview]}</span>}
              <span className="line-clamp-2">{p.caption}</span>
            </button>
  );
}

/** What the "today" screen sent you here for: the posts that need a hand, above the calendar. */
const SHOW = {
  changes: { title: 'بوستات العميل طلب فيها تعديل', empty: 'مفيش بوستات مستنية تعديل.', match: (p: Post) => p.status === 'SCHEDULED' && p.clientReview === 'CHANGES_REQUESTED' },
  failed: { title: 'بوستات منزلتش', empty: 'كل البوستات نزلت.', match: (p: Post) => p.status === 'FAILED' || p.status === 'PARTIAL' },
  drafts: { title: 'مسودات مستنية موافقتك', empty: 'مفيش مسودات مستنية.', match: (p: Post) => p.status === 'DRAFT' && !!p.scheduledAt }
} as const;
type Show = keyof typeof SHOW;

function NeedsHand({ show, onOpen, onClose }: { show: Show; onOpen: (p: Post) => void; onClose: () => void }) {
  const range = useMemo(() => { const n = Date.now(); return `from=${new Date(n - 30 * 86400_000).toISOString()}&to=${new Date(n + 31 * 86400_000).toISOString()}`; }, []);
  const { data } = useSWR<Post[]>(`/posts?${range}`, fetcher as never);
  const cfg = SHOW[show];
  const list = data?.filter(cfg.match) ?? [];
  return (
    <section aria-labelledby="needs-h" className="mx-8 mt-6 flex flex-col gap-3 rounded-[var(--radius-lg)] border border-warning/40 bg-warning/5 p-4 max-md:mx-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="needs-h" className="font-display text-xl font-bold">{cfg.title}{data ? <span className="tabular-nums text-muted"> ({list.length})</span> : null}</h2>
        <Button variant="ghost" onClick={onClose}>اعرض الجدول كله</Button>
      </div>
      {!data ? <p role="status" className="text-muted">بيحمّل…</p> : !list.length ? <p className="text-muted">{cfg.empty}</p> : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-2">{list.map(p => <li key={p.id}><PostRow p={p} onOpen={onOpen} withDay /></li>)}</ul>
      )}
    </section>
  );
}

function Composer({ day, onClose, onSaved }: { day: Date; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const [clientId, setClientId] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = clients?.find(c => c.id === clientId);
  const defaultTime = format(day.getTime() < Date.now() ? new Date(Date.now() + 3600_000) : new Date(day.setHours(19, 0, 0, 0)), "yyyy-MM-dd'T'HH:mm");

  async function upload(file: File) {
    const form = new FormData(); form.append('file', file);
    setUploading(true); setError(null);
    try { setImage((await api<{ url: string }>('/uploads', { form })).url); } catch (e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const when = f.get('scheduledAt') as string;
    try {
      await api('/posts', { body: { clientId, caption: f.get('caption'), socialAccountIds: f.getAll('accounts'), mediaUrls: image ? [image] : [], scheduledAt: when ? new Date(when).toISOString() : null } });
      onSaved();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <Modal open onClose={onClose} title="بوست جديد">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="العميل" id="clientId">
          <Select id="clientId" required value={clientId} onChange={e => setClientId(e.target.value)}><option value="" disabled>اختار العميل</option>{clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
        {client && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-semibold">هيتنشر على</legend>
            {client.socialAccounts.length === 0 && <p className="text-sm text-muted">العميل ده مفيش له صفحات متربطة. اربطها من صفحة القنوات.</p>}
            {client.socialAccounts.map(s => <label key={s.id} className="flex items-center gap-2"><input type="checkbox" name="accounts" value={s.id} defaultChecked /> {s.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} · {s.name}</label>)}
          </fieldset>
        )}
        <Field label="الكلام" id="caption"><Textarea id="caption" name="caption" rows={5} maxLength={2200} required /></Field>
        <div className="flex items-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-line px-4 font-semibold hover:bg-surface-2">
            <ImagePlus size={18} />{uploading ? 'بيترفع…' : image ? 'غيّر الصورة' : 'ضيف صورة'}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          {image && <img src={image} alt="" className="h-16 w-16 rounded object-cover" />}
        </div>
        <Field label="ميعاد النشر" id="scheduledAt" hint={can.manage(me.role) ? 'سيبه فاضي عشان يتحفظ مسودة.' : 'البوست هيستنى موافقة المدير قبل ما يتجدول.'}>
          <input id="scheduledAt" name="scheduledAt" type="datetime-local" defaultValue={defaultTime} className="num h-10 rounded-[var(--radius-sm)] border border-line bg-surface px-3" />
        </Field>
        <ErrorText error={error} />
        <Button disabled={!clientId || uploading}>{can.manage(me.role) ? 'جدول' : 'ابعت للموافقة'}</Button>
      </form>
    </Modal>
  );
}

function PostDetail({ post, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const [error, setError] = useState<string | null>(null);
  async function act(path: string, method = 'POST') { try { await api(path, { method }); onChanged(); } catch (e) { setError((e as Error).message); } }
  const s = STATUS[post.status];
  return (
    <Modal open onClose={onClose} title={post.client.name}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2"><Pill tone={s?.t}>{s?.l}</Pill>{post.scheduledAt && <span className="text-sm text-muted">{when(post.scheduledAt)}</span>}<span className="text-sm text-muted">· كتبه {post.createdBy.name}</span>{post.clientReview !== 'NOT_REQUIRED' && <Pill tone={post.clientReview === 'APPROVED' ? 'good' : post.clientReview === 'PENDING' ? 'warn' : 'bad'}>{REVIEW_LABEL[post.clientReview]}</Pill>}</div>
        {post.clientReview === 'CHANGES_REQUESTED' && post.clientNote && <p className="rounded-[var(--radius-md)] border border-danger/30 bg-danger/5 p-3 text-sm"><span className="font-semibold">طلب العميل: </span>{post.clientNote}</p>}
        {post.mediaUrls[0] && <img src={post.mediaUrls[0]} alt="" className="max-h-64 rounded-[var(--radius-md)] object-cover" />}
        <p className="whitespace-pre-wrap">{post.caption}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {post.targets.map(t => <li key={t.id} className="flex items-center gap-2">{t.socialAccount.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} · {t.socialAccount.name} <Pill tone={t.status === 'PUBLISHED' ? 'good' : t.status === 'FAILED' ? 'bad' : 'neutral'}>{t.status === 'PUBLISHED' ? 'اتنشر' : t.status === 'FAILED' ? 'منزلش' : 'مستني'}</Pill>{t.error && <span className="text-danger">{t.error}</span>}</li>)}
        </ul>
        <ErrorText error={error} />
        <div className="flex flex-wrap gap-2">
          {can.manage(me.role) && post.status === 'DRAFT' && post.scheduledAt && <Button onClick={() => act(`/posts/${post.id}/approve`)}>وافق وجدول</Button>}
          {can.manage(me.role) && ['DRAFT', 'SCHEDULED', 'FAILED', 'PARTIAL'].includes(post.status) && <Button variant="ghost" onClick={() => act(`/posts/${post.id}/publish-now`)}>{post.status === 'FAILED' || post.status === 'PARTIAL' ? 'جرّب تاني' : 'انشر دلوقتي'}</Button>}
          {can.write(me.role) && post.status !== 'PUBLISHING' && <Button variant="danger" onClick={() => act(`/posts/${post.id}`, 'DELETE')}>امسح</Button>}
        </div>
      </div>
    </Modal>
  );
}
