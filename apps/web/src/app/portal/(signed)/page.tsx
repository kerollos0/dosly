'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Check, PencilLine } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { Button, ErrorText, Pill, Textarea } from '@/components/ui';
import { usePortalMe } from '@/lib/portal';

type PortalPost = {
  id: string; caption: string; mediaUrls: string[]; scheduledAt: string; status: string;
  clientReview: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED'; clientNote: string | null;
  platforms: { platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; published: boolean }[];
};
const PLATFORM = { FACEBOOK_PAGE: 'فيسبوك', INSTAGRAM: 'إنستجرام' };

function PostCard({ post, onChanged }: { post: PortalPost; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reviewable = post.status === 'SCHEDULED' && post.clientReview !== 'NOT_REQUIRED';
  async function act(path: string, body?: unknown) {
    setBusy(true); setError(null);
    try { await api(path, { method: 'POST', body }); setAsking(false); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <li className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
      {post.mediaUrls[0] && <img src={post.mediaUrls[0]} alt="" className="aspect-square w-full object-cover" />}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{format(new Date(post.scheduledAt), 'EEEE d MMMM · h:mm a', { locale: ar })}</span>
          {post.platforms.map(p => <Pill key={p.platform} tone="info">{PLATFORM[p.platform]}</Pill>)}
        </div>
        <p className="whitespace-pre-line">{post.caption}</p>
        {post.clientReview === 'CHANGES_REQUESTED' && post.clientNote && <p className="rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm"><span className="font-semibold">طلبت: </span>{post.clientNote}<br /><span className="text-muted">الوكالة هتعدّله وترجعهولك تاني.</span></p>}
        {post.clientReview === 'APPROVED' && post.status === 'SCHEDULED' && <p className="flex items-center gap-1 text-sm font-semibold text-success"><Check size={16} aria-hidden />وافقت عليه، وهيتنشر في ميعاده</p>}
        {reviewable && post.clientReview === 'PENDING' && !asking && (
          <div className="mt-auto flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => act(`/portal/posts/${post.id}/approve`)}><Check size={18} aria-hidden />موافق</Button>
            <Button className="flex-1" variant="ghost" disabled={busy} onClick={() => setAsking(true)}><PencilLine size={18} aria-hidden />عايز تعديل</Button>
          </div>
        )}
        {asking && (
          <form className="mt-auto flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void act(`/portal/posts/${post.id}/request-changes`, { note }); }}>
            <label htmlFor={`n-${post.id}`} className="text-sm font-semibold">إيه اللي محتاج يتغير؟</label>
            <Textarea id={`n-${post.id}`} rows={3} value={note} onChange={e => setNote(e.target.value)} required minLength={2} placeholder="مثلًا: غيّروا الصورة، أو اكتبوا السعر الجديد" />
            <div className="flex gap-2"><Button disabled={busy}>ابعت للوكالة</Button><Button type="button" variant="ghost" onClick={() => setAsking(false)}>إلغاء</Button></div>
          </form>
        )}
        <ErrorText error={error} />
      </div>
    </li>
  );
}

function Section({ title, sub, posts, onChanged }: { title: string; sub?: string; posts: PortalPost[]; onChanged: () => void }) {
  if (!posts.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <div><h2 className="font-display text-xl font-bold">{title} <span className="num text-muted">({posts.length})</span></h2>{sub && <p className="text-sm text-muted">{sub}</p>}</div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">{posts.map(p => <PostCard key={p.id} post={p} onChanged={onChanged} />)}</ul>
    </section>
  );
}

export default function PortalPosts() {
  const me = usePortalMe();
  const range = useMemo(() => { const n = Date.now(); return `from=${new Date(n - 30 * 86400_000).toISOString()}&to=${new Date(n + 31 * 86400_000).toISOString()}`; }, []);
  const { data, mutate } = useSWR<PortalPost[]>(`/portal/posts?${range}`, fetcher as never);
  if (!data) return <p className="text-muted">بيحمّل…</p>;
  const now = Date.now();
  const pending = data.filter(p => p.status === 'SCHEDULED' && p.clientReview === 'PENDING');
  const changes = data.filter(p => p.status === 'SCHEDULED' && p.clientReview === 'CHANGES_REQUESTED');
  const upcoming = data.filter(p => p.status === 'SCHEDULED' && (p.clientReview === 'APPROVED' || p.clientReview === 'NOT_REQUIRED'));
  const done = data.filter(p => ['PUBLISHED', 'PARTIAL'].includes(p.status) && new Date(p.scheduledAt).getTime() <= now).reverse();
  const refresh = () => void mutate();
  return (
    <div className="flex flex-col gap-10">
      {me.client.requiresClientApproval && !pending.length && <p className="rounded-[var(--radius-md)] border border-success/30 bg-success/5 p-4">مفيش بوستات مستنية موافقتك دلوقتي 👌</p>}
      <Section title="مستنية موافقتك" sub="مش هتتنشر غير لما توافق عليها." posts={pending} onChanged={refresh} />
      <Section title="طلبت تعديل فيها" posts={changes} onChanged={refresh} />
      <Section title="جاية قريب" posts={upcoming} onChanged={refresh} />
      <Section title="اتنشرت آخر شهر" posts={done} onChanged={refresh} />
    </div>
  );
}
