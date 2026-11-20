'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR, { useSWRConfig } from 'swr';
import { formatDistanceToNowStrict, format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Check, CheckCheck, Clock, AlertCircle, Send, Paperclip, Mic, Trash2, X, FileText, Bell, BellOff, MessageSquareText, Download } from 'lucide-react';
import { api, can, fetcher, type Client, type Conversation, type Member, type Message } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, Empty, Input, Pill, Select, Textarea, cx } from '@/components/ui';
import { MessageMedia, Retry, clock, fileSize, mediaUrl } from '@/components/inbox/message-media';
import { TemplatePicker } from '@/components/inbox/template-picker';
import { ACCEPT, MAX_UPLOAD, uploadWithProgress } from '@/components/inbox/upload';
import { useVoiceRecorder } from '@/components/inbox/voice-recorder';
import { setOpenConversation, useNotifyPrefs } from '@/lib/notify';
import { ChannelBadge, CHANNEL_LABEL } from '@/components/channel-badge';

const CHANNELS = [{ v: '', l: 'كل القنوات' }, { v: 'WHATSAPP', l: 'واتساب' }, { v: 'MESSENGER', l: 'ماسنجر' }, { v: 'INSTAGRAM', l: 'إنستجرام' }] as const;
const MB = 1024 * 1024;
const contactLabel = (c: Conversation['contact']) => c.name ?? (c.username ? `@${c.username}` : c.waId ? `+${c.waId}` : 'عميل');

const STATUS = [{ v: 'OPEN', l: 'مفتوحة' }, { v: 'PENDING', l: 'مستنية العميل' }, { v: 'CLOSED', l: 'خلصت' }] as const;

export default function InboxPage() {
  // useSearchParams needs a Suspense boundary so the page can still be prerendered.
  return <Suspense><Inbox /></Suspense>;
}

function Inbox() {
  const me = useMe();
  const [clientId, setClientId] = useState('');
  const [status, setStatus] = useState<'OPEN' | 'PENDING' | 'CLOSED'>('OPEN');
  const [mine, setMine] = useState(false);
  const [channel, setChannel] = useState('');
  const params = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get('c'));
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const qs = new URLSearchParams({ status, ...(clientId ? { clientId } : {}), ...(mine ? { mine: 'true' } : {}), ...(channel ? { channel } : {}) });
  const { data: list } = useSWR<{ items: Conversation[]; nextCursor: string | null }>(`/conversations?${qs}`, fetcher as never, { refreshInterval: 30_000 });
  // A conversation opened from a notification may be outside the current filter, so it is fetched on its own.
  const { data: linked } = useSWR<Conversation>(selected && list && !list.items.some(c => c.id === selected) ? `/conversations/${selected}` : null, fetcher as never);
  const current = list?.items.find(c => c.id === selected) ?? (linked && 'client' in linked && linked.id === selected ? linked : null);

  if (clients && clients.length === 0) {
    return <Empty title="لسه مفيش عملاء">{can.manage(me.role) ? 'ابدأ بإضافة عميل من صفحة العملاء، وبعدين اربط رقم الواتساب بتاعه من صفحة القنوات.' : 'اطلب من مدير الوكالة يعيّنك على عميل.'}</Empty>;
  }

  return (
    <div className="grid h-full grid-cols-[340px_1fr] max-lg:grid-cols-1">
      <section aria-label="المحادثات" className={cx('flex min-h-0 flex-col border-e border-line', current && 'max-lg:hidden')}>
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="font-display text-[22px] font-semibold">المحادثات</h1>
            <NotifySwitch />
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select aria-label="العميل" value={clientId} onChange={e => setClientId(e.target.value)}>
              <option value="">كل العملاء</option>
              {clients?.map(c => <option key={c.id} value={c.id}>{c.name}{c.unreadConversations ? ` (${c.unreadConversations})` : ''}</option>)}
            </Select>
            <Select aria-label="القناة" value={channel} onChange={e => setChannel(e.target.value)} className="w-32">
              {CHANNELS.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
            </Select>
          </div>
          <div role="tablist" className="flex gap-1 rounded-[var(--radius-md)] bg-surface-2 p-1">
            {STATUS.map(s => (
              <button key={s.v} role="tab" aria-selected={status === s.v} onClick={() => setStatus(s.v)}
                className={cx('flex-1 rounded-[var(--radius-sm)] py-1.5 text-sm font-semibold', status === s.v ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{s.l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> بتاعتي بس</label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {list?.items.length === 0 && <li className="p-6 text-center text-muted">مفيش محادثات هنا.</li>}
          {list?.items.map(c => (
            <li key={c.id}>
              <button onClick={() => setSelected(c.id)} aria-current={c.id === selected}
                className={cx('flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-start hover:bg-surface-2', c.id === selected && 'bg-surface-2')}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold" dir="auto">{contactLabel(c.contact)}</span>
                  <span className="shrink-0 text-xs text-muted">{formatDistanceToNowStrict(new Date(c.lastMessageAt), { locale: ar })}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-muted">{c.lastPreview}</span>
                  {c.unreadCount > 0 && <Pill tone="sun"><span className="num">{c.unreadCount}</span></Pill>}
                </span>
                <span className="flex items-center gap-2 text-xs"><ChannelBadge channel={c.channel ?? 'WHATSAPP'} /><span className="truncate text-faience-ink">{c.client.name}{c.assignee ? ` · ${c.assignee.name}` : ''}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {current ? <Thread key={current.id} conv={current} onBack={() => setSelected(null)} /> : <div className="max-lg:hidden"><Empty title="اختار محادثة">الرسايل الجديدة من كل أرقام العملاء بتوصل هنا أول بأول.</Empty></div>}
    </div>
  );
}

function StatusIcon({ s }: { s: string }) {
  if (s === 'READ') return <CheckCheck size={14} className="text-sun" aria-label="اتقرت" />;
  if (s === 'DELIVERED') return <CheckCheck size={14} aria-label="وصلت" />;
  if (s === 'SENT') return <Check size={14} aria-label="اتبعتت" />;
  if (s === 'FAILED') return <AlertCircle size={14} className="text-danger" aria-label="فشلت" />;
  return <Clock size={14} aria-label="في الطريق" />;
}

function NotifySwitch() {
  const { prefs, permission, enableDesktop, toggleSound } = useNotifyPrefs();
  if (permission === 'default' || permission === 'unsupported') {
    return <Button size="sm" variant="ghost" type="button" onClick={permission === 'default' ? enableDesktop : toggleSound} title="صوت وإشعار لما رسالة توصل">
      {prefs.sound ? <Bell size={14} aria-hidden /> : <BellOff size={14} aria-hidden />}{permission === 'default' ? 'فعّل التنبيهات' : prefs.sound ? 'الصوت شغال' : 'الصوت مقفول'}
    </Button>;
  }
  return (
    <button type="button" onClick={toggleSound} aria-pressed={prefs.sound} className="rounded-[var(--radius-md)] p-2 text-muted hover:bg-surface-2" title={prefs.sound ? 'اقفل صوت التنبيه' : 'شغّل صوت التنبيه'}>
      {prefs.sound ? <Bell size={18} aria-label="التنبيهات شغالة" /> : <BellOff size={18} aria-label="صوت التنبيهات مقفول" />}
    </button>
  );
}

type Pending = { id: string; name: string; size: number; progress: number; error?: string; abort: AbortController };

function Thread({ conv, onBack }: { conv: Conversation; onBack: () => void }) {
  const me = useMe();
  const { data, mutate } = useSWR<{ items: Message[] }>(`/conversations/${conv.id}/messages`, fetcher as never);
  const { data: team } = useSWR<{ members: Member[] }>('/team', fetcher as never);
  const { data: quick } = useSWR<{ id: string; shortcut: string; body: string }[]>('/quick-replies', fetcher as never);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [uploads, setUploads] = useState<Pending[]>([]);
  const [viewer, setViewer] = useState<Message | null>(null);
  const [templates, setTemplates] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const voice = useVoiceRecorder();
  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer]);

  const { mutate: mutateAll } = useSWRConfig();
  useEffect(() => { setOpenConversation(conv.id); return () => setOpenConversation(null); }, [conv.id]);
  // Opening a thread, or a new message landing in the open one, clears its unread badge in the list too.
  useEffect(() => {
    void api(`/conversations/${conv.id}/read`, { method: 'POST' })
      .then(() => mutateAll(k => typeof k === 'string' && k.startsWith('/conversations?')));
  }, [conv.id, data?.items.length, mutateAll]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.items.length, uploads.length]);

  const suggestions = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    return m ? (quick ?? []).filter(q => q.shortcut.startsWith(m[1]!)).slice(0, 5) : [];
  }, [text, quick]);
  const filePreview = useMemo(() => (file?.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (filePreview) URL.revokeObjectURL(filePreview); }, [filePreview]);

  const social = (conv.channel ?? 'WHATSAPP') !== 'WHATSAPP';
  const maxUpload = social ? 25 * MB : MAX_UPLOAD;
  const tooBig = social ? 'الملف أكبر من 25 ميجا، وده أقصى حجم في ماسنجر وإنستجرام' : 'الملف أكبر من 100 ميجا، وده أقصى حجم في واتساب';
  const textProblem = conv.channel === 'INSTAGRAM' && new TextEncoder().encode(text).length > 1000
    ? 'الرسالة طويلة على إنستجرام (أقصى حاجة حوالي 500 حرف عربي). قصّرها أو قسّمها على رسالتين.'
    : conv.channel === 'MESSENGER' && text.length > 1999 ? 'الرسالة أطول من 1999 حرف، وده أقصى طول في ماسنجر' : null;
  async function send() {
    if (!text.trim() || textProblem) return;
    setSending(true); setError(null);
    try {
      await api(`/conversations/${conv.id}/messages`, { body: { body: text } });
      setText('');
      await mutate();
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }

  /** Uploads one attachment; it shows as a bubble with a progress bar until the server has it. */
  const upload = useCallback(async (f: Blob, name: string, opts: { caption?: string; voice?: boolean } = {}) => {
    if (f.size > maxUpload) { setError(tooBig); return; }
    const id = Math.random().toString(36).slice(2);
    const abort = new AbortController();
    setUploads(u => [...u, { id, name, size: f.size, progress: 0, abort }]);
    const form = new FormData();
    if (opts.caption?.trim()) form.set('caption', opts.caption.trim());
    if (opts.voice) form.set('voice', 'true');
    form.set('file', f, name); // the file goes last: the server reads fields that come before it
    try {
      await uploadWithProgress(`/conversations/${conv.id}/attachments`, form, p => setUploads(u => u.map(x => x.id === id ? { ...x, progress: p } : x)), abort.signal);
      setUploads(u => u.filter(x => x.id !== id));
      await mutate();
    } catch (e) {
      const msg = (e as Error).message;
      if ((e as { code?: string }).code === 'aborted') setUploads(u => u.filter(x => x.id !== id));
      else setUploads(u => u.map(x => x.id === id ? { ...x, error: msg } : x));
    }
  }, [conv.id, mutate, maxUpload, tooBig]);

  function pick(f: File | undefined | null) {
    if (!f) return;
    if (f.size > maxUpload) { setError(tooBig); return; }
    const looksMedia = /^(image|video|audio)\//.test(f.type);
    if (conv.channel === 'INSTAGRAM' && !looksMedia && !/\.pdf$/i.test(f.name)) { setError('إنستجرام بيقبل ملفات PDF بس، غير الصور والفيديو والصوت'); return; }
    setError(null); setFile(f); setCaption(text); setText('');
  }
  async function sendFile() {
    if (!file) return;
    const f = file; setFile(null);
    await upload(f, f.name, { caption });
    setCaption('');
  }
  async function finishVoice() {
    const blob = await voice.stop();
    if (!blob) return;
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
    await upload(blob, `voice.${ext}`, { voice: true });
  }
  async function update(patch: object) {
    try { await api(`/conversations/${conv.id}`, { method: 'PATCH', body: patch }); } catch (e) { setError((e as Error).message); }
  }

  const canReply = can.reply(me.role);
  return (
    <section aria-label="المحادثة" className="relative flex min-h-0 flex-col"
      onDragOver={e => { if (canReply && conv.windowOpen && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (canReply && conv.windowOpen) pick(e.dataTransfer.files[0]); }}>
      {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-primary bg-primary/10 font-semibold text-primary">سيب الملف هنا عشان تبعته</div>}
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3 max-md:px-4">
        <button onClick={onBack} className="hidden text-faience-ink max-lg:block">رجوع</button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" dir="auto">{contactLabel(conv.contact)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
            <ChannelBadge channel={conv.channel ?? 'WHATSAPP'} />
            {conv.contact.waId ? <bdi className="num">+{conv.contact.waId}</bdi> : conv.contact.username && conv.contact.name ? <bdi dir="ltr">@{conv.contact.username}</bdi> : null}
            <span>{conv.client.name}</span>
          </p>
        </div>
        {canReply && (
          <div className="flex gap-2">
            <Select aria-label="المسؤول" className="h-9 w-44 px-2" defaultValue={conv.assignee?.id ?? ''} onChange={e => update({ assigneeId: e.target.value || null })}>
              <option value="">من غير مسؤول</option>
              {team?.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <Select aria-label="الحالة" className="h-9 w-32 px-2" defaultValue={conv.status} onChange={e => update({ status: e.target.value })}>
              {STATUS.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </Select>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2 px-6 py-4 max-md:px-3">
        <ol className="flex flex-col gap-2">
          {data?.items.map(m => {
            const out = m.direction === 'OUT';
            const mediaOnly = m.hasMedia && !m.body && m.type !== 'template';
            return (
              <li key={m.id} className={cx('max-w-[75%] rounded-[var(--radius-md)]', mediaOnly ? 'p-1' : 'px-3 py-2', out ? 'self-end bg-primary text-on-primary' : 'self-start bg-surface text-ink', m.type === 'sticker' && 'bg-transparent')}>
                {m.type === 'template' && <p className="mb-1 flex items-center gap-1 text-xs opacity-80"><MessageSquareText size={12} aria-hidden />Template</p>}
                <MessageMedia m={m} onOpenImage={setViewer} />
                {m.template?.header && <p className="font-semibold">{m.template.header}</p>}
                {m.body ? <p className={cx('whitespace-pre-wrap break-words', m.hasMedia && 'mt-1')} dir="auto">{m.body}</p>
                  : !m.hasMedia && <p className="text-sm opacity-80">[{m.type}]</p>}
                {m.template?.footer && <p className="mt-1 text-xs opacity-80">{m.template.footer}</p>}
                {m.template && m.template.buttons.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{m.template.buttons.map((b, i) => <span key={i} className="rounded-full border border-current/40 px-2 py-0.5 text-xs">{b}</span>)}</div>}
                <p className={cx('mt-1 flex items-center gap-1 text-xs', mediaOnly && 'px-2 pb-1', out ? 'opacity-80' : 'text-muted')}>
                  <span className="num">{format(new Date(m.createdAt), 'HH:mm')}</span>
                  {m.sentBy && <span>· {m.sentBy.name}</span>}
                  {out && <StatusIcon s={m.status} />}
                </p>
                {m.error && out && <p className={cx('mt-1 flex flex-wrap items-center gap-2 text-xs', mediaOnly && 'px-2 pb-1')}>{m.error} {m.status === 'FAILED' && m.hasMedia || m.type === 'template' && m.status === 'FAILED' ? <Retry m={m} label="ابعت تاني" /> : null}</p>}
              </li>
            );
          })}
          {uploads.map(u => (
            <li key={u.id} className="flex w-72 max-w-[75%] flex-col gap-2 self-end rounded-[var(--radius-md)] bg-primary px-3 py-2 text-on-primary">
              <span className="flex items-center gap-2 text-sm"><FileText size={16} aria-hidden /><span className="min-w-0 flex-1 truncate" dir="auto">{u.name.startsWith('voice.') ? 'رسالة صوتية' : u.name}</span><span className="num text-xs opacity-80">{fileSize(u.size)}</span></span>
              {u.error ? <span className="text-xs">{u.error} <button className="underline" onClick={() => setUploads(x => x.filter(y => y.id !== u.id))}>تمام</button></span> : (
                <span className="flex items-center gap-2">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-on-primary/25" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="الرفع">
                    <span className="block h-full bg-on-primary transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </span>
                  <button onClick={() => u.abort.abort()} aria-label="إلغاء الرفع"><X size={14} /></button>
                </span>
              )}
            </li>
          ))}
        </ol>
        <div ref={end} />
      </div>
      {canReply && (
        <footer className="border-t border-line p-4">
          {conv.window === 'human_agent' && !file && (
            <p className="mb-2 rounded-[var(--radius-md)] bg-surface-2 px-3 py-2 text-xs text-muted">عدّى أكتر من 24 ساعة على آخر رسالة من العميل. {CHANNEL_LABEL[conv.channel]} بيسمح برد من موظف لحد 7 أيام، فالرد هيتبعت بعلامة «رد من موظف» (<bdi dir="ltr">Human agent</bdi>).</p>
          )}
          {!conv.windowOpen ? (
            social ? (
              <p className="rounded-[var(--radius-md)] bg-warning/12 p-3 text-sm text-warning">{conv.lastInboundAt
                ? `عدّى أكتر من 7 أيام على آخر رسالة من العميل، و${CHANNEL_LABEL[conv.channel]} مش بيسمح برسايل جديدة لحد ما يكتبلك تاني.`
                : `بعتناله رسالة في الخاص من الكومنت. ${CHANNEL_LABEL[conv.channel]} بيسمح برسالة واحدة بس، وهتقدر ترد عادي أول ما يرد عليك.`}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] bg-warning/12 p-3 text-sm text-warning">
                <p className="min-w-0 flex-1">عدّى أكتر من 24 ساعة على آخر رسالة من العميل، فواتساب مش هيسمح غير برسالة Template متوافق عليها. لما العميل يرد هتقدر تكلمه عادي.</p>
                <Button type="button" onClick={() => setTemplates(true)}><MessageSquareText size={16} aria-hidden />ابعت Template</Button>
              </div>
            )
          ) : file ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                {filePreview ? <img src={filePreview} alt="" className="h-16 w-16 rounded-[var(--radius-sm)] object-cover" /> : <FileText size={32} aria-hidden />}
                <div className="min-w-0 flex-1"><p className="truncate font-semibold" dir="auto">{file.name}</p><p className="text-sm text-muted">{fileSize(file.size)}</p></div>
                <button onClick={() => setFile(null)} aria-label="شيل الملف" className="rounded p-1 text-muted hover:bg-surface-2"><X size={18} /></button>
              </div>
              <div className="flex items-end gap-2">
                {!file.type.startsWith('audio/') && <Input aria-label="تعليق" value={caption} onChange={e => setCaption(e.target.value)} placeholder="اكتب تعليق (اختياري)" maxLength={1024} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void sendFile(); } }} />}
                <Button onClick={sendFile} aria-label="ابعت الملف"><Send size={18} className="-scale-x-100" />ابعت</Button>
              </div>
            </div>
          ) : voice.state === 'recording' ? (
            <div className="flex items-center gap-3">
              <button onClick={voice.cancel} aria-label="امسح التسجيل" className="rounded-full p-2 text-danger hover:bg-danger/10"><Trash2 size={20} /></button>
              <span className="size-3 animate-pulse rounded-full bg-danger" aria-hidden />
              <span className="num font-semibold" aria-live="off">{clock(voice.seconds)}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden><span className="block h-full bg-faience transition-[width] duration-75" style={{ width: `${Math.round(voice.level * 100)}%` }} /></span>
              <Button onClick={finishVoice} aria-label="ابعت الرسالة الصوتية"><Send size={18} className="-scale-x-100" />ابعت</Button>
            </div>
          ) : (
            <div className="relative flex items-end gap-2">
              {suggestions.length > 0 && (
                <ul className="absolute bottom-full mb-2 w-full rounded-[var(--radius-md)] border border-line bg-surface shadow-lg">
                  {suggestions.map(s => (
                    <li key={s.id}><button className="w-full px-3 py-2 text-start hover:bg-surface-2" onClick={() => setText(s.body)}><b>/{s.shortcut}</b> <span className="text-muted">{s.body.slice(0, 60)}</span></button></li>
                  ))}
                </ul>
              )}
              <input ref={fileInput} type="file" accept={conv.channel === 'INSTAGRAM' ? 'image/*,video/mp4,video/quicktime,audio/*,.pdf' : ACCEPT} hidden onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInput.current?.click()} aria-label="ابعت صورة أو ملف" title="صورة، فيديو، أو ملف" className="mb-1 rounded-[var(--radius-md)] p-2 text-muted hover:bg-surface-2"><Paperclip size={20} /></button>
              {!social && <button type="button" onClick={() => setTemplates(true)} aria-label="ابعت Template" title="رسالة Template" className="mb-1 rounded-[var(--radius-md)] p-2 text-muted hover:bg-surface-2"><MessageSquareText size={20} /></button>}
              <Textarea aria-label="اكتب الرد" rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="اكتب ردك… أو / للردود الجاهزة"
                onPaste={e => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); pick(f); } }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              {text.trim() ? (
                <Button onClick={send} disabled={sending || !!textProblem} aria-label="ابعت"><Send size={18} className="-scale-x-100" />ابعت</Button>
              ) : (
                <Button onClick={() => void voice.start()} aria-label="سجّل رسالة صوتية" title="سجّل رسالة صوتية"><Mic size={18} />سجّل</Button>
              )}
            </div>
          )}
          {voice.state === 'denied' && <p role="alert" className="mt-2 text-sm text-danger">المتصفح مش سامح بالمايك. اسمح بيه من علامة القفل جنب العنوان وجرّب تاني.</p>}
          {voice.state === 'unsupported' && <p role="alert" className="mt-2 text-sm text-danger">المتصفح ده مش بيدعم التسجيل. جرّب Chrome أو Safari جديد.</p>}
          {textProblem && <p role="alert" className="mt-2 text-sm text-danger">{textProblem}</p>}
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </footer>
      )}
      {!social && <TemplatePicker conversationId={conv.id} open={templates} onClose={() => setTemplates(false)} onSent={() => void mutate()} />}
      {viewer && (
        <div role="dialog" aria-modal="true" aria-label="الصورة" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4" onClick={() => setViewer(null)}>
          <img src={mediaUrl(viewer)} alt={viewer.body ?? ''} className="max-h-[85vh] max-w-full object-contain" onClick={e => e.stopPropagation()} />
          <div className="flex gap-3" onClick={e => e.stopPropagation()}>
            <a href={mediaUrl(viewer, { download: true })} className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-white/15 px-3 py-2 text-white"><Download size={16} aria-hidden />تحميل</a>
            <button onClick={() => setViewer(null)} className="rounded-[var(--radius-md)] bg-white/15 px-3 py-2 text-white">إغلاق</button>
          </div>
        </div>
      )}
    </section>
  );
}
