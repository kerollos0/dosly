'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { formatDistanceToNowStrict, format } from 'date-fns';
import { ar } from 'date-fns/locale';
import { Check, CheckCheck, Clock, AlertCircle, Send } from 'lucide-react';
import { api, can, fetcher, type Client, type Conversation, type Member, type Message } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, Empty, Pill, Select, Textarea, cx } from '@/components/ui';

const STATUS = [{ v: 'OPEN', l: 'مفتوحة' }, { v: 'PENDING', l: 'مستنية' }, { v: 'CLOSED', l: 'مقفولة' }] as const;

export default function InboxPage() {
  const me = useMe();
  const [clientId, setClientId] = useState('');
  const [status, setStatus] = useState<'OPEN' | 'PENDING' | 'CLOSED'>('OPEN');
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const qs = new URLSearchParams({ status, ...(clientId ? { clientId } : {}), ...(mine ? { mine: 'true' } : {}) });
  const { data: list } = useSWR<{ items: Conversation[]; nextCursor: string | null }>(`/conversations?${qs}`, fetcher as never, { refreshInterval: 30_000 });
  const current = list?.items.find(c => c.id === selected) ?? null;

  if (clients && clients.length === 0) {
    return <Empty title="لسه مفيش عملاء">{can.manage(me.role) ? 'ابدأ بإضافة عميل من صفحة العملاء، وبعدين اربط رقم الواتساب بتاعه من صفحة القنوات.' : 'اطلب من مدير الوكالة يعيّنك على عميل.'}</Empty>;
  }

  return (
    <div className="grid h-full grid-cols-[340px_1fr] max-lg:grid-cols-1">
      <section aria-label="المحادثات" className={cx('flex min-h-0 flex-col border-e border-line', current && 'max-lg:hidden')}>
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <h1 className="font-display text-[22px] font-semibold">المحادثات</h1>
          <Select aria-label="العميل" value={clientId} onChange={e => setClientId(e.target.value)}>
            <option value="">كل العملاء</option>
            {clients?.map(c => <option key={c.id} value={c.id}>{c.name}{c.unreadConversations ? ` (${c.unreadConversations})` : ''}</option>)}
          </Select>
          <div role="tablist" className="flex gap-1 rounded-[var(--radius-md)] bg-surface-2 p-1">
            {STATUS.map(s => (
              <button key={s.v} role="tab" aria-selected={status === s.v} onClick={() => setStatus(s.v)}
                className={cx('flex-1 rounded-[var(--radius-sm)] py-1.5 text-sm font-semibold', status === s.v ? 'bg-surface text-ink shadow-sm' : 'text-muted')}>{s.l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /> المتعينة ليّا بس</label>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {list?.items.length === 0 && <li className="p-6 text-center text-muted">مفيش محادثات هنا.</li>}
          {list?.items.map(c => (
            <li key={c.id}>
              <button onClick={() => setSelected(c.id)} aria-current={c.id === selected}
                className={cx('flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-start hover:bg-surface-2', c.id === selected && 'bg-surface-2')}>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{c.contact.name ?? c.contact.waId}</span>
                  <span className="shrink-0 text-xs text-muted">{formatDistanceToNowStrict(new Date(c.lastMessageAt), { locale: ar })}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-muted">{c.lastPreview}</span>
                  {c.unreadCount > 0 && <Pill tone="sun"><span className="num">{c.unreadCount}</span></Pill>}
                </span>
                <span className="text-xs text-faience-ink">{c.client.name}{c.assignee ? ` · ${c.assignee.name}` : ''}</span>
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

function Thread({ conv, onBack }: { conv: Conversation; onBack: () => void }) {
  const me = useMe();
  const { data, mutate } = useSWR<{ items: Message[] }>(`/conversations/${conv.id}/messages`, fetcher as never);
  const { data: team } = useSWR<{ members: Member[] }>('/team', fetcher as never);
  const { data: quick } = useSWR<{ id: string; shortcut: string; body: string }[]>('/quick-replies', fetcher as never);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const { mutate: mutateAll } = useSWRConfig();
  // Opening a thread, or a new message landing in the open one, clears its unread badge in the list too.
  useEffect(() => {
    void api(`/conversations/${conv.id}/read`, { method: 'POST' })
      .then(() => mutateAll(k => typeof k === 'string' && k.startsWith('/conversations?')));
  }, [conv.id, data?.items.length, mutateAll]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [data?.items.length]);

  const suggestions = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    return m ? (quick ?? []).filter(q => q.shortcut.startsWith(m[1]!)).slice(0, 5) : [];
  }, [text, quick]);

  async function send() {
    if (!text.trim()) return;
    setSending(true); setError(null);
    try {
      await api(`/conversations/${conv.id}/messages`, { body: { body: text } });
      setText('');
      await mutate();
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  async function update(patch: object) {
    try { await api(`/conversations/${conv.id}`, { method: 'PATCH', body: patch }); } catch (e) { setError((e as Error).message); }
  }

  return (
    <section aria-label="المحادثة" className="flex min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3 max-md:px-4">
        <button onClick={onBack} className="hidden text-faience-ink max-lg:block">رجوع</button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{conv.contact.name ?? 'عميل'}</p>
          <p className="text-sm text-muted"><bdi className="num">+{conv.contact.waId}</bdi> · {conv.client.name}</p>
        </div>
        {can.reply(me.role) && (
          <div className="flex gap-2">
            <Select aria-label="المسؤول" className="h-9 w-40" defaultValue={conv.assignee?.id ?? ''} onChange={e => update({ assigneeId: e.target.value || null })}>
              <option value="">من غير مسؤول</option>
              {team?.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <Select aria-label="الحالة" className="h-9 w-32" defaultValue={conv.status} onChange={e => update({ status: e.target.value })}>
              {STATUS.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
            </Select>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2 px-6 py-4 max-md:px-3">
        <ol className="flex flex-col gap-2">
          {data?.items.map(m => (
            <li key={m.id} className={cx('max-w-[75%] rounded-[var(--radius-md)] px-3 py-2', m.direction === 'OUT' ? 'self-end bg-primary text-on-primary' : 'self-start bg-surface text-ink')}>
              <p className="whitespace-pre-wrap break-words">{m.body ?? `[${m.type}]`}</p>
              <p className={cx('mt-1 flex items-center gap-1 text-xs', m.direction === 'OUT' ? 'opacity-80' : 'text-muted')}>
                <span className="num">{format(new Date(m.createdAt), 'HH:mm')}</span>
                {m.sentBy && <span>· {m.sentBy.name}</span>}
                {m.direction === 'OUT' && <StatusIcon s={m.status} />}
              </p>
              {m.error && <p className="mt-1 text-xs">{m.error}</p>}
            </li>
          ))}
        </ol>
        <div ref={end} />
      </div>
      {can.reply(me.role) && (
        <footer className="border-t border-line p-4">
          {!conv.windowOpen ? (
            <p className="rounded-[var(--radius-md)] bg-warning/12 p-3 text-sm text-warning">عدّى أكتر من 24 ساعة على آخر رسالة من العميل، فواتساب مش هيسمح برد عادي. لما العميل يبعت تاني هتقدر ترد.</p>
          ) : (
            <div className="relative flex items-end gap-2">
              {suggestions.length > 0 && (
                <ul className="absolute bottom-full mb-2 w-full rounded-[var(--radius-md)] border border-line bg-surface shadow-lg">
                  {suggestions.map(s => (
                    <li key={s.id}><button className="w-full px-3 py-2 text-start hover:bg-surface-2" onClick={() => setText(s.body)}><b>/{s.shortcut}</b> <span className="text-muted">{s.body.slice(0, 60)}</span></button></li>
                  ))}
                </ul>
              )}
              <Textarea aria-label="اكتب الرد" rows={2} value={text} onChange={e => setText(e.target.value)} placeholder="اكتب ردك… أو / للردود الجاهزة"
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
              <Button onClick={send} disabled={sending || !text.trim()} aria-label="ابعت"><Send size={18} className="-scale-x-100" />ابعت</Button>
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        </footer>
      )}
    </section>
  );
}
