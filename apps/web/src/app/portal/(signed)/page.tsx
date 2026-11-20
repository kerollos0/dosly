'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { CalendarClock, Check, CheckCircle2, PencilLine } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { Button, ErrorText, Textarea, cx } from '@/components/ui';
import { usePortalMe } from '@/lib/portal';
import { joinAnd, when } from '@/lib/when';

type PortalPost = {
  id: string; caption: string; mediaUrls: string[]; scheduledAt: string; status: string;
  clientReview: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED'; clientNote: string | null;
  platforms: { platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; published: boolean }[];
};
const PLATFORM = { FACEBOOK_PAGE: 'فيسبوك', INSTAGRAM: 'إنستجرام' };
const where = (p: PortalPost) => joinAnd(p.platforms.map(x => PLATFORM[x.platform]));
/** How many posts a list shows before "show the rest": a short page is easier to scan. */
const FIRST = 3;

function PostCard({ post, onDone }: { post: PortalPost; onDone: (msg: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Closing the note form puts focus back on the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => { if (wasAsking.current && !asking) opener.current?.focus(); wasAsking.current = asking; }, [asking]);
  const overdue = post.status === 'SCHEDULED' && new Date(post.scheduledAt).getTime() < Date.now();
  const pending = post.status === 'SCHEDULED' && post.clientReview === 'PENDING';
  const published = ['PUBLISHED', 'PARTIAL'].includes(post.status);
  async function act(path: string, msg: string, body?: unknown) {
    setBusy(true); setError(null);
    try { await api(path, { method: 'POST', body }); setAsking(false); onDone(msg); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <li tabIndex={-1} className={cx('focus-visible:outline-2 focus-visible:outline-primary', 'flex flex-col overflow-hidden rounded-[var(--radius-lg)] border bg-surface', pending ? 'border-primary/40 shadow-sm' : 'border-line')}>
      {post.mediaUrls[0] && <img src={post.mediaUrls[0]} alt="" className="aspect-square w-full object-cover" />}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="flex items-center gap-2 font-semibold">
          <CalendarClock size={16} aria-hidden className="shrink-0 text-muted" />
          <span>{published ? 'اتنشر' : overdue ? 'كان المفروض يتنشر' : pending ? 'لو وافقت، هيتنشر' : 'هيتنشر'} {when(post.scheduledAt)} على {where(post)}</span>
        </p>
        {/* The full text while it waits for a decision; a preview once it is settled. */}
        <p className={cx('whitespace-pre-line text-[17px] leading-7', !pending && 'line-clamp-4')}>{post.caption}</p>
        {post.clientReview === 'CHANGES_REQUESTED' && post.clientNote && (
          <p className="rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm">
            <span className="font-semibold">إنت طلبت: </span>{post.clientNote}
            <span className="mt-1 block text-muted">الوكالة بتعدّله، وهيرجعلك هنا تاني تشوفه.</span>
          </p>
        )}
        {post.clientReview === 'APPROVED' && post.status === 'SCHEDULED' && !asking && (
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1 font-semibold text-success"><Check size={18} aria-hidden />وافقت عليه</p>
            {/* A mis-tap on "موافق" is undone here: the agency can still change it until it goes out. */}
            <Button ref={opener} variant="ghost" className="min-h-11" onClick={() => setAsking(true)}><PencilLine size={16} aria-hidden />غيّرت رأيك؟ اطلب تعديل</Button>
          </div>
        )}
        {pending && !asking && (
          <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
            <Button size="lg" disabled={busy} onClick={() => act(`/portal/posts/${post.id}/approve`, `تمام، وافقت. البوست هيتنشر ${when(post.scheduledAt)}. لو غيّرت رأيك تقدر تطلب تعديل من نفس البوست لحد ما يتنشر.`)}><Check size={20} aria-hidden />موافق</Button>
            <Button ref={opener} size="lg" variant="ghost" disabled={busy} onClick={() => setAsking(true)}><PencilLine size={20} aria-hidden />عايز تعديل</Button>
          </div>
        )}
        {asking && (
          <form className="mt-auto flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void act(`/portal/posts/${post.id}/request-changes`, 'وصل طلبك للوكالة. هيعدّلوا البوست ويرجعوهولك هنا.', { note }); }}>
            <label htmlFor={`n-${post.id}`} className="font-semibold">إيه اللي محتاج يتغير؟</label>
            <Textarea id={`n-${post.id}`} rows={3} autoFocus value={note} onChange={e => setNote(e.target.value)} required minLength={2} placeholder="مثلًا: غيّروا الصورة، أو اكتبوا السعر الجديد" className="text-base" />
            <div className="grid grid-cols-2 gap-2"><Button size="lg" disabled={busy}>ابعت طلب التعديل</Button><Button size="lg" type="button" variant="ghost" onClick={() => setAsking(false)}>رجوع</Button></div>
          </form>
        )}
        <ErrorText error={error} />
      </div>
    </li>
  );
}

function Section({ id, title, sub, posts, onDone, limit = true }: { id: string; title: string; sub?: string; posts: PortalPost[]; onDone: (msg: string) => void; limit?: boolean }) {
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  if (!posts.length) return null;
  // "Show the rest" disappears once pressed, so focus moves to the first card it revealed.
  const more = () => { setAll(true); requestAnimationFrame(() => (list.current?.children[FIRST] as HTMLElement | undefined)?.focus()); };
  const shown = limit && !all ? posts.slice(0, FIRST) : posts;
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="flex scroll-mt-24 flex-col gap-3">
      <div>
        <h2 id={`${id}-h`} tabIndex={-1} className="scroll-mt-24 font-display text-xl font-bold focus:outline-none">{title} <span className="tabular-nums text-muted">({posts.length})</span></h2>
        {sub && <p className="text-muted">{sub}</p>}
      </div>
      <ul ref={list} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] items-start gap-4">{shown.map(p => <PostCard key={p.id} post={p} onDone={onDone} />)}</ul>
      {shown.length < posts.length && <Button variant="ghost" size="lg" className="self-center" onClick={more}>اعرض الباقي ({posts.length - shown.length})</Button>}
    </section>
  );
}

export default function PortalPosts() {
  const me = usePortalMe();
  const range = useMemo(() => { const n = Date.now(); return `from=${new Date(n - 30 * 86400_000).toISOString()}&to=${new Date(n + 31 * 86400_000).toISOString()}`; }, []);
  const { data, error, mutate } = useSWR<PortalPost[]>(`/portal/posts?${range}`, fetcher as never);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  if (error && !data) return <ErrorText error="مش قادرين نجيب البوستات دلوقتي. جرّب تفتح الصفحة تاني بعد شوية." />;
  if (!data) return <p role="status" className="text-muted">بيحمّل…</p>;
  const now = Date.now();
  const pending = data.filter(p => p.status === 'SCHEDULED' && p.clientReview === 'PENDING');
  const changes = data.filter(p => p.status === 'SCHEDULED' && p.clientReview === 'CHANGES_REQUESTED');
  const upcoming = data.filter(p => p.status === 'SCHEDULED' && (p.clientReview === 'APPROVED' || p.clientReview === 'NOT_REQUIRED'));
  const done = data.filter(p => ['PUBLISHED', 'PARTIAL'].includes(p.status) && new Date(p.scheduledAt).getTime() <= now).reverse();
  const next = upcoming.filter(p => new Date(p.scheduledAt).getTime() > now).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
  const first = me.user.name.split(' ')[0];
  // The card that was acted on moves to another list, so focus goes to the notice. Clearing it first
  // makes a screen reader announce the same message twice in a row.
  const onDone = (msg: string) => {
    setNotice(null); void mutate();
    requestAnimationFrame(() => { setNotice(msg); requestAnimationFrame(() => noticeRef.current?.focus()); });
  };
  const review = () => { const h = document.getElementById('pending-h'); h?.scrollIntoView({ behavior: 'smooth' }); h?.focus({ preventScroll: true }); };

  return (
    <div className="flex flex-col gap-10">
      {/* One answer first: is anything needed from you? */}
      <section aria-label="الخلاصة" className={cx('flex flex-col gap-3 rounded-[var(--radius-lg)] border p-6 max-sm:p-4', pending.length ? 'border-primary/30 bg-primary/5' : 'border-success/30 bg-success/5')}>
        <h1 className="font-display text-2xl font-bold">أهلًا {first}</h1>
        {pending.length ? (
          <>
            <p className="text-lg">{pending.length === 1 ? 'فيه بوست واحد مستني رأيك' : pending.length === 2 ? 'فيه بوستين مستنيين رأيك' : `فيه ${pending.length} ${pending.length % 100 >= 3 && pending.length % 100 <= 10 ? 'بوستات مستنية' : 'بوست مستنيين'} رأيك`} قبل ما يتنشر. مش هيتنشر غير لما توافق.</p>
            <Button size="lg" className="self-start" onClick={review}>{pending.length === 1 ? 'راجع البوست' : 'راجع البوستات'}</Button>
          </>
        ) : (
          <p className="flex items-start gap-2 text-lg"><CheckCircle2 size={24} aria-hidden className="mt-0.5 shrink-0 text-success" />مفيش حاجة مطلوبة منك دلوقتي. {me.agency.name} شغالين على حساباتك.</p>
        )}
        {next && !pending.length && <p className="text-muted">البوست الجاي هيتنشر {when(next.scheduledAt)}.</p>}
      </section>

      <p ref={noticeRef} role="status" tabIndex={-1} className={cx('flex scroll-mt-24 focus:outline-none items-center gap-2 rounded-[var(--radius-md)] border border-success/30 bg-success/5 p-3 font-semibold', !notice && 'sr-only')}>
        {notice && <Check size={18} aria-hidden className="shrink-0 text-success" />}{notice}
      </p>

      <Section id="pending" title="مستنية موافقتك" sub={pending.some(p => p.mediaUrls.length) ? 'اقرا البوست وبص على الصورة، وبعدين دوس موافق أو عايز تعديل.' : 'اقرا البوست، وبعدين دوس موافق أو عايز تعديل.'} posts={pending} onDone={onDone} limit={false} />
      <Section id="changes" title="طلبت تعديل فيها" posts={changes} onDone={onDone} />
      <Section id="upcoming" title="جاية قريب" posts={upcoming} onDone={onDone} />
      <Section id="done" title="اتنشرت في آخر 30 يوم" posts={done} onDone={onDone} />
      {!data.length && <p className="text-center text-muted">لسه مفيش بوستات. أول ما الوكالة تجهّز بوستات هتلاقيها هنا.</p>}
    </div>
  );
}
