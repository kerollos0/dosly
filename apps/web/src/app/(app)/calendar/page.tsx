'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { ar } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, ImagePlus } from 'lucide-react';
import { api, can, fetcher, REVIEW_LABEL, type Client, type Post } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, ErrorText, Field, Modal, PageHeader, Pill, Select, Textarea, cx } from '@/components/ui';

const STATUS: Record<string, { l: string; t: 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'sun' }> = {
  DRAFT: { l: 'مسودة', t: 'neutral' }, SCHEDULED: { l: 'متجدول', t: 'sun' }, PUBLISHING: { l: 'بيتنشر', t: 'info' },
  PUBLISHED: { l: 'اتنشر', t: 'good' }, PARTIAL: { l: 'اتنشر جزئيًا', t: 'warn' }, FAILED: { l: 'فشل', t: 'bad' }
};
const WEEK_START = 6; // Saturday, as agencies in Egypt plan their week

export default function CalendarPage() {
  const me = useMe();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [creatingOn, setCreatingOn] = useState<Date | null>(null);
  const [open, setOpen] = useState<Post | null>(null);
  const from = startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_START });
  const to = startOfDay(addDays(endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_START }), 1));
  const key = `/posts?from=${from.toISOString()}&to=${to.toISOString()}`;
  const { data: posts, mutate } = useSWR<Post[]>(key, fetcher as never);
  const days = useMemo(() => { const d: Date[] = []; for (let x = from; x < to; x = addDays(x, 1)) d.push(x); return d; }, [from.getTime(), to.getTime()]);

  return (
    <>
      <PageHeader title="جدولة البوستات" sub="البوستات بتتنشر لوحدها في ميعادها على فيسبوك وإنستجرام."
        action={<div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setMonth(m => addMonths(m, -1))} aria-label="الشهر اللي فات"><ChevronRight size={18} /></Button>
          <span className="w-32 text-center font-semibold">{format(month, 'MMMM yyyy', { locale: ar })}</span>
          <Button variant="ghost" size="sm" onClick={() => setMonth(m => addMonths(m, 1))} aria-label="الشهر الجاي"><ChevronLeft size={18} /></Button>
          {can.write(me.role) && <Button onClick={() => setCreatingOn(new Date())}>بوست جديد</Button>}
        </div>} />
      <div className="overflow-x-auto p-8 max-md:p-4">
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
        <div className="flex flex-wrap items-center gap-2"><Pill tone={s?.t}>{s?.l}</Pill>{post.scheduledAt && <span className="num text-sm text-muted">{format(new Date(post.scheduledAt), 'yyyy-MM-dd HH:mm')}</span>}<span className="text-sm text-muted">· كتبه {post.createdBy.name}</span>{post.clientReview !== 'NOT_REQUIRED' && <Pill tone={post.clientReview === 'APPROVED' ? 'good' : post.clientReview === 'PENDING' ? 'warn' : 'bad'}>{REVIEW_LABEL[post.clientReview]}</Pill>}</div>
        {post.clientReview === 'CHANGES_REQUESTED' && post.clientNote && <p className="rounded-[var(--radius-md)] border border-danger/30 bg-danger/5 p-3 text-sm"><span className="font-semibold">طلب العميل: </span>{post.clientNote}</p>}
        {post.mediaUrls[0] && <img src={post.mediaUrls[0]} alt="" className="max-h-64 rounded-[var(--radius-md)] object-cover" />}
        <p className="whitespace-pre-wrap">{post.caption}</p>
        <ul className="flex flex-col gap-1 text-sm">
          {post.targets.map(t => <li key={t.id} className="flex items-center gap-2">{t.socialAccount.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} · {t.socialAccount.name} <Pill tone={t.status === 'PUBLISHED' ? 'good' : t.status === 'FAILED' ? 'bad' : 'neutral'}>{t.status === 'PUBLISHED' ? 'اتنشر' : t.status === 'FAILED' ? 'فشل' : 'مستني'}</Pill>{t.error && <span className="text-danger">{t.error}</span>}</li>)}
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
