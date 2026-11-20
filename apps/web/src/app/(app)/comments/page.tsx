'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { formatDistanceToNowStrict } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Check, EyeOff, Eye, Lock, MessageCircleReply, RotateCcw, Send, Trash2 } from 'lucide-react';
import { api, can, fetcher, type Client, type CommentThread } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, Empty, Pill, Select, Textarea, cx } from '@/components/ui';
import { ChannelBadge } from '@/components/channel-badge';

const STATUS = [{ v: 'OPEN', l: 'محتاجة رد' }, { v: 'DONE', l: 'خلصانة' }, { v: 'ALL', l: 'الكل' }] as const;
const PAGE = 30;
const ago = (d: string) => formatDistanceToNowStrict(new Date(d), { locale: ar });
const igByteLimit = (s: string) => new TextEncoder().encode(s).length > 1000;
type Page = { items: CommentThread[]; openCount: number; nextCursor: string | null };
type Notice = { text: string; link?: { href: string; label: string }; undo?: () => Promise<void> };

/** Comments on every client's Facebook and Instagram posts, answered from one place. */
export default function CommentsPage() {
  const me = useMe();
  const [status, setStatus] = useState<'OPEN' | 'DONE' | 'ALL'>('OPEN');
  const [clientId, setClientId] = useState('');
  const [platform, setPlatform] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  // Threads someone is typing in stay on screen even if a teammate closes them meanwhile.
  const [editing, setEditing] = useState<Record<string, CommentThread>>({});
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const base = new URLSearchParams({ status, limit: String(PAGE), ...(clientId ? { clientId } : {}), ...(platform ? { platform } : {}) });
  const { data, error, size, setSize, mutate, isValidating, isLoading } = useSWRInfinite<Page>(
    (i, prev: Page | null) => (i === 0 ? `/comments?${base}` : prev?.nextCursor ? `/comments?${base}&cursor=${prev.nextCursor}` : null),
    fetcher as never, { refreshInterval: 60_000 }
  );
  const loaded = data?.flatMap(p => p.items) ?? [];
  const missing = Object.values(editing).filter(t => !loaded.some(x => x.id === t.id));
  const items = [...loaded, ...missing];
  const last = data?.at(-1);

  /** After an action the thread may leave the list: focus moves to its neighbour so keyboard users keep their place. */
  function afterAction(id: string, n: Notice) {
    const idx = items.findIndex(t => t.id === id);
    const neighbour = items[idx + 1]?.id ?? items[idx - 1]?.id;
    setNotice(n);
    void mutate().then(() => requestAnimationFrame(() => {
      const el = document.getElementById(`thread-${id}`) ?? (neighbour ? document.getElementById(`thread-${neighbour}`) : null);
      (el ?? document.getElementById('comments-title'))?.focus();
    }));
  }
  const reset = () => { void setSize(1); setNotice(null); };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6 max-md:p-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 id="comments-title" tabIndex={-1} className="font-display text-[22px] font-semibold outline-none">الكومنتات</h1>
        {!!data?.[0]?.openCount && <Pill tone="sun"><span className="num">{data[0].openCount}</span> محتاجة رد</Pill>}
      </header>
      <p className="text-sm text-muted">كومنتات بوستات فيسبوك وإنستجرام لكل العملاء. رد علني تحت الكومنت، أو ابعت رد في الخاص (ميتا بتسمح برسالة خاصة واحدة لكل كومنت خلال 7 أيام).</p>
      <div className="grid grid-cols-[1fr_auto] gap-2 max-sm:grid-cols-1">
        <Select aria-label="العميل" value={clientId} onChange={e => { setClientId(e.target.value); reset(); }}>
          <option value="">كل العملاء</option>
          {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select aria-label="المنصة" value={platform} onChange={e => { setPlatform(e.target.value); reset(); }} className="sm:w-40">
          <option value="">كل المنصات</option>
          <option value="FACEBOOK_PAGE">فيسبوك</option>
          <option value="INSTAGRAM">إنستجرام</option>
        </Select>
      </div>
      <div role="tablist" aria-label="حالة الكومنتات" className="flex gap-1 self-start rounded-[var(--radius-md)] bg-surface-2 p-1">
        {STATUS.map(s => (
          <button key={s.v} role="tab" aria-selected={status === s.v} onClick={() => { setStatus(s.v); reset(); }}
            className={cx('rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-semibold', status === s.v ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{s.l}</button>
        ))}
      </div>
      <div role="status" aria-live="polite">
        {notice && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] bg-success/12 px-3 py-2 text-sm text-success">
            <span>{notice.text}</span>
            {notice.link && <Link href={notice.link.href} className="font-semibold underline">{notice.link.label}</Link>}
            {notice.undo && <button type="button" className="font-semibold underline" onClick={() => { const u = notice.undo!; setNotice(null); void u().then(() => mutate()); }}>تراجع</button>}
            <button type="button" className="ms-auto px-1 text-muted" onClick={() => setNotice(null)} aria-label="اقفل الرسالة">×</button>
          </p>
        )}
      </div>
      {error && !data ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-[var(--radius-md)] bg-danger/10 p-4 text-sm text-danger">
          <p>{(error as Error).message || 'مش قادرين نجيب الكومنتات.'}</p>
          <Button size="sm" variant="ghost" type="button" onClick={() => void mutate()}>جرّب تاني</Button>
        </div>
      ) : isLoading || !data ? <p className="text-muted">بيحمّل…</p> : items.length === 0 ? (
        <Empty title={status === 'OPEN' ? 'مفيش كومنتات مستنية رد' : 'مفيش كومنتات هنا'}>الكومنتات الجديدة على بوستات العملاء بتوصل هنا أول بأول.</Empty>
      ) : (
        <ul className="flex flex-col gap-3" aria-busy={isValidating}>
          {items.map(t => (
            <li key={t.id}>
              <Thread t={t} canReply={can.reply(me.role)} stale={missing.includes(t)}
                onEditing={on => setEditing(e => { if (!!e[t.id] === on) return e; const n = { ...e }; if (on) n[t.id] = t; else delete n[t.id]; return n; })}
                onDone={n => afterAction(t.id, n)} />
            </li>
          ))}
        </ul>
      )}
      {last?.nextCursor && <Button variant="ghost" type="button" disabled={isValidating} onClick={() => void setSize(size + 1)}>اعرض أكتر</Button>}
    </div>
  );
}

function Thread({ t, canReply, stale, onEditing, onDone }: { t: CommentThread; canReply: boolean; stale: boolean; onEditing: (on: boolean) => void; onDone: (n: Notice) => void }) {
  const [mode, setMode] = useState<'public' | 'private' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const ig = t.platform === 'INSTAGRAM';
  const author = ig && t.authorName ? `@${t.authorName}` : t.authorName ?? 'حد';
  const titleId = `thread-${t.id}-author`;
  const hintId = `thread-${t.id}-hint`;
  useEffect(() => { onEditing(!!mode || !!text); }, [mode, text]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>, notice: Notice) {
    setBusy(true); setError(null);
    try { await fn(); onDone(notice); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function open(m: 'public' | 'private', btn: HTMLButtonElement) { opener.current = btn; setMode(m); }
  function close() { setMode(null); requestAnimationFrame(() => opener.current?.focus()); }
  const tooLong = mode === 'private' && ig && igByteLimit(text) ? 'الرسالة طويلة على إنستجرام (أقصى حاجة حوالي 500 حرف عربي)' : null;
  async function send() {
    if (!text.trim() || !mode || tooLong) return;
    const m = mode;
    setBusy(true); setError(null);
    try {
      const r = await api<{ conversationId?: string | null }>(`/comments/${t.id}/${m === 'public' ? 'reply' : 'private-reply'}`, { body: { text } });
      setText(''); setMode(null);
      onDone(m === 'public'
        ? { text: `الرد اتنشر تحت كومنت ${author}` }
        : { text: `الرسالة الخاصة وصلت لـ ${author}`, ...(r.conversationId ? { link: { href: `/inbox?c=${r.conversationId}`, label: 'افتح المحادثة' } } : {}) });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const privateHint = t.privateReplyAt ? 'اتبعت رد خاص على الكومنت ده قبل كده' : !t.canPrivateReply ? 'عدّى أكتر من 7 أيام على الكومنت، فميتا مش بتسمح برد خاص' : null;

  return (
    <article id={`thread-${t.id}`} tabIndex={-1} aria-labelledby={titleId}
      className={cx('flex flex-col gap-3 rounded-[var(--radius-md)] border bg-surface p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary', t.status === 'OPEN' ? 'border-line' : 'border-line/60')}>
      {stale && <p className="rounded-[var(--radius-sm)] bg-warning/12 px-3 py-1.5 text-xs text-warning">زميلك اتعامل مع الكومنت ده. ردك لسه هنا لو عايز تكمله.</p>}
      <div className="flex items-center gap-3 text-sm text-muted">
        {t.post?.image ? <img src={t.post.image} alt="" className="size-10 shrink-0 rounded-[var(--radius-sm)] object-cover" /> : null}
        <p className="line-clamp-2 min-w-0 flex-1" dir="auto">{t.post ? <>على بوست: {t.post.caption}</> : 'على بوست اتنشر من برّه دوسلي'}</p>
      </div>
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <bdi id={titleId} className="font-semibold" dir={ig ? 'ltr' : 'auto'}>{author}</bdi>
          <ChannelBadge channel={t.platform} />
          <span className="text-xs text-faience-ink">{t.client.name}</span>
          <span className="text-xs text-muted">· {ago(t.createdAt)}</span>
          {t.isHidden && <Pill tone="neutral"><EyeOff size={12} aria-hidden />مخفي</Pill>}
          {t.status === 'DONE' && !t.isHidden && <Pill tone="good"><Check size={12} aria-hidden />خلصان</Pill>}
        </p>
        <p className={cx('whitespace-pre-wrap break-words', t.isHidden && 'text-muted line-through decoration-muted/40')} dir="auto">{t.body}</p>
      </div>
      {t.replies.length > 0 && (
        <ol className="flex flex-col gap-2 border-s-2 border-line ps-3" aria-label="الردود">
          {t.replies.map(r => (
            <li key={r.id} className={cx('rounded-[var(--radius-sm)] px-3 py-2 text-sm', r.fromPage ? 'bg-primary/8' : 'bg-surface-2')}>
              <p className="text-xs text-muted">
                {r.fromPage ? <>رد الصفحة{r.sentBy ? ` · ${r.sentBy.name}` : ''}</> : <bdi dir={ig ? 'ltr' : 'auto'}>{ig && r.authorName ? `@${r.authorName}` : r.authorName ?? 'حد'}</bdi>} · {ago(r.createdAt)}{r.isHidden ? ' · مخفي' : ''}
              </p>
              <p className={cx('whitespace-pre-wrap break-words', r.deleted && 'italic text-muted')} dir="auto">{r.deleted ? 'اتمسح' : r.body}</p>
            </li>
          ))}
        </ol>
      )}
      {t.privateConversationId && <p className="text-sm text-muted">اتبعتله رد في الخاص. <Link href={`/inbox?c=${t.privateConversationId}`} className="font-semibold text-faience-ink underline">افتح المحادثة</Link></p>}
      {canReply && (
        <>
          {mode && (
            <div className="flex flex-col gap-2">
              <Textarea autoFocus rows={2} value={text} onChange={e => setText(e.target.value)} maxLength={mode === 'public' ? (ig ? 2200 : 8000) : 1999} dir="auto"
                aria-label={mode === 'public' ? `رد علني على ${author}` : `رد في الخاص لـ ${author}`} aria-invalid={!!tooLong}
                placeholder={mode === 'public' ? 'ردك هيظهر للكل تحت الكومنت' : 'رسالة في الخاص، هتظهر في الإنبوكس بتاعه'}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape') close(); }} />
              {tooLong && <p className="text-xs text-danger">{tooLong}</p>}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" type="button" onClick={close}>إلغاء</Button>
                <Button size="sm" type="button" onClick={send} disabled={busy || !text.trim() || !!tooLong}><Send size={14} className="-scale-x-100" aria-hidden />{mode === 'public' ? 'رد علني' : 'ابعت في الخاص'}</Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" type="button" onClick={e => open('public', e.currentTarget)} disabled={busy || (ig && t.isHidden)} aria-label={`رد على ${author}`}><MessageCircleReply size={14} aria-hidden />رد</Button>
            <Button size="sm" variant="ghost" type="button" onClick={e => open('private', e.currentTarget)} disabled={busy || !t.canPrivateReply} aria-label={`رد في الخاص لـ ${author}`} aria-describedby={privateHint ? hintId : undefined}>
              <Lock size={14} aria-hidden />{t.privateReplyAt ? 'اتبعت في الخاص' : 'رد في الخاص'}
            </Button>
            <Button size="sm" variant="ghost" type="button" disabled={busy}
              onClick={() => run(() => api(`/comments/${t.id}/hide`, { body: { hidden: !t.isHidden } }), t.isHidden
                ? { text: `كومنت ${author} رجع يظهر` }
                : { text: `كومنت ${author} اتخفى عن الناس`, undo: () => api(`/comments/${t.id}/hide`, { body: { hidden: false } }).then(() => undefined) })}>
              {t.isHidden ? <><Eye size={14} aria-hidden />إظهار</> : <><EyeOff size={14} aria-hidden />إخفاء</>}
            </Button>
            {t.status === 'OPEN'
              ? <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => run(() => api(`/comments/${t.id}`, { method: 'PATCH', body: { status: 'DONE' } }), { text: 'اتعلّم إنه خلصان', undo: () => api(`/comments/${t.id}`, { method: 'PATCH', body: { status: 'OPEN' } }).then(() => undefined) })}><Check size={14} aria-hidden />خلصت</Button>
              : <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => run(() => api(`/comments/${t.id}`, { method: 'PATCH', body: { status: 'OPEN' } }), { text: 'رجع لـ «محتاجة رد»' })}><RotateCcw size={14} aria-hidden />رجّعها</Button>}
            {confirmDelete ? (
              <span className="inline-flex flex-wrap items-center gap-1 text-sm">
                <span className="text-danger">هيتمسح من {ig ? 'إنستجرام' : 'فيسبوك'} نهائي.</span>
                <Button size="sm" variant="danger" type="button" disabled={busy} onClick={() => run(() => api(`/comments/${t.id}`, { method: 'DELETE' }), { text: `كومنت ${author} اتمسح` })}>امسح</Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setConfirmDelete(false)}>لا</Button>
              </span>
            ) : <Button size="sm" variant="danger" type="button" disabled={busy} onClick={() => setConfirmDelete(true)} aria-label={`امسح كومنت ${author}`}><Trash2 size={14} aria-hidden />مسح</Button>}
          </div>
          {privateHint && <p id={hintId} className="text-xs text-muted">{privateHint}</p>}
        </>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </article>
  );
}
