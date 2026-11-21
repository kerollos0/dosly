'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import useSWR, { mutate as mutateKey } from 'swr';
import { Clock, Hand, MessageSquareText, MessagesSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import {
  CHANNEL_LABEL, DAYS, daysLabel, HALF_HOURS, NAME_TOKEN, PLATFORM_LABEL, splitWords, timeLabel, timesLabel,
  type AutoClient, type AutoKind, type AutoPost, type AutoRule, type ChatChannel, type Hours, type Platform
} from '@/lib/automations';
import { Button, cx, Empty, ErrorText, Field, Input, Modal, PageHeader, Pill, Select, Textarea } from '@/components/ui';
import { when } from '@/lib/when';

type Data = { rules: AutoRule[]; posts: AutoPost[] };

/** Automatic replies per client: in chats (welcome, closed hours, keywords) and under posts. */
export default function AutomationsPage() {
  const { data: clients, error: cErr } = useSWR<AutoClient[]>('/automations/options', fetcher as never);
  const [clientId, setClientId] = useState('');
  useEffect(() => { if (!clientId && clients?.[0]) setClientId(clients[0].id); }, [clients, clientId]);
  const client = clients?.find(c => c.id === clientId);
  const { data, error, mutate } = useSWR<Data>(clientId ? `/automations?clientId=${clientId}` : null, fetcher as never);
  const [editing, setEditing] = useState<{ kind: AutoKind; rule?: AutoRule } | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const busy = (id: string, on: boolean) => setPending(p => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });
  const refresh = async () => { await mutate(); await mutateKey('/automations/options'); };

  async function act(r: AutoRule, run: () => Promise<unknown>) {
    if (pending.has(r.id)) return;
    busy(r.id, true); setRowErr(e => ({ ...e, [r.id]: '' }));
    try { await run(); } catch { setRowErr(e => ({ ...e, [r.id]: 'ما قدرناش نغيّر الرد ده. جرّب تاني.' })); }
    await refresh(); busy(r.id, false);
  }
  async function toggle(r: AutoRule) {
    await mutate(d => d && { ...d, rules: d.rules.map(x => (x.id === r.id ? { ...x, enabled: !r.enabled } : x)) }, { revalidate: false });
    await act(r, () => api(`/automations/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }));
  }
  const remove = (r: AutoRule) => act(r, () => api(`/automations/${r.id}`, { method: 'DELETE' }));
  const rowProps = (r: AutoRule) => ({ pending: pending.has(r.id), error: rowErr[r.id] || null });

  const rules = data?.rules ?? [];
  const welcome = rules.find(r => r.kind === 'WELCOME');
  const away = rules.find(r => r.kind === 'AWAY');
  const keywords = rules.filter(r => r.kind === 'KEYWORD');
  const comments = rules.filter(r => r.kind === 'COMMENT');
  const chats = client?.channels.length ?? 0, pages = client?.platforms.length ?? 0;

  return (
    <>
      <PageHeader title="ردود تلقائية" sub="دوسلي بيرد مكانك على الأسئلة اللي بتتكرر، في المحادثات وتحت البوستات. لما حد من الفريق يرد بنفسه، الردود التلقائية بتقف نص ساعة في المحادثة دي." />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-8 max-md:p-4">
        {cErr ? <ErrorText error="مش قادرين نجيب العملاء دلوقتي. جرّب تاني بعد شوية." />
          : !clients ? <p role="status" className="text-muted">بيحمّل…</p>
          : !clients.length ? <Empty title="لسه مفيش عملاء">ضيف عميل واربط له واتساب أو صفحة فيسبوك، وبعدين ارجع هنا.</Empty>
          : <>
            {clients.length > 1 && (
              <div className="w-64 max-sm:w-full">
                <label htmlFor="au-client" className="mb-2 block text-[13px] font-semibold">العميل</label>
                <Select id="au-client" className="h-11" value={clientId} onChange={e => setClientId(e.target.value)}>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.active ? ` (${c.active} ردود شغالة)` : ''}</option>)}
                </Select>
              </div>
            )}
            {error ? <div className="flex items-center gap-3"><ErrorText error="مش قادرين نجيب الردود دلوقتي." /><Button variant="ghost" className="h-11" onClick={() => mutate()}>جرّب تاني</Button></div> : !data ? <p role="status" className="text-muted">بيحمّل…</p> : <>
              <section aria-labelledby="chats-h" className="flex flex-col gap-3">
                <h2 id="chats-h" className="font-display text-xl font-bold">في المحادثات</h2>
                {!chats ? <NotConnected what="واتساب أو ماسنجر أو إنستجرام" /> : <>
                  <Card icon={<Hand size={20} aria-hidden />} title="رسالة الترحيب" sub="لأول رسالة من أي حد جديد" rule={welcome} {...(welcome ? rowProps(welcome) : {})} onToggle={toggle} onEdit={() => setEditing({ kind: 'WELCOME', rule: welcome })}
                    empty="مش متفعّلة. فعّلها عشان كل عميل جديد ياخد رد في نفس الثانية.">
                    {welcome && <Said text={welcome.reply} />}
                  </Card>
                  <Card icon={<Clock size={20} aria-hidden />} title="برّه مواعيد الشغل" sub={away?.hours ? `مواعيدكم: ${daysLabel(away.hours.days)}، من ${timeLabel(away.hours.from)} لحد ${timeLabel(away.hours.to)}` : 'لو حد كتب واحنا قافلين'}
                    rule={away} {...(away ? rowProps(away) : {})} onToggle={toggle} onEdit={() => setEditing({ kind: 'AWAY', rule: away })} empty="مش متفعّلة. اكتب مواعيدكم والعميل يعرف إمتى هتردوا عليه.">
                    {away && <Said text={away.reply} />}
                  </Card>
                  <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <MessageSquareText size={20} aria-hidden className="text-primary" />
                      <div className="flex-1">
                        <h3 className="font-semibold">لو حد كتب كلمة معينة</h3>
                        <p className="text-sm text-muted">مثلًا «بكام» يوصله السعر، و«العنوان» يوصله العنوان على الخريطة</p>
                      </div>
                      <Button variant="ghost" className="h-11" onClick={() => setEditing({ kind: 'KEYWORD' })}><Plus size={16} aria-hidden />رد جديد</Button>
                    </div>
                    {keywords.length ? (
                      <ul className="flex flex-col divide-y divide-line">
                        {keywords.map(r => (
                          <Row key={r.id} rule={r} {...rowProps(r)} onToggle={toggle} onEdit={() => setEditing({ kind: 'KEYWORD', rule: r })} onDelete={remove}>
                            <p className="text-sm"><span className="text-muted">لو كتب: </span><Words words={r.keywords} /></p>
                            <Said text={r.reply} />
                            <p className="text-xs text-muted">{r.channels.map(c => CHANNEL_LABEL[c]).join(' · ')}</p>
                          </Row>
                        ))}
                      </ul>
                    ) : <p className="text-sm text-muted">مفيش ردود على كلمات لسه.</p>}
                  </div>
                </>}
              </section>

              <section aria-labelledby="cm-h" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1">
                    <h2 id="cm-h" className="font-display text-xl font-bold">تحت البوستات</h2>
                    <p className="text-sm text-muted">يرد على الكومنت قدّام الناس، ويبعت للشخص رسالة واحدة في الخاص. كل شخص بياخد الرد مرة واحدة بس على كل بوست.</p>
                  </div>
                  {!!pages && <Button className="h-11" onClick={() => setEditing({ kind: 'COMMENT' })}><Plus size={16} aria-hidden />رد على الكومنتات</Button>}
                </div>
                {!pages ? <NotConnected what="صفحة فيسبوك أو حساب إنستجرام" /> : comments.length ? (
                  <ul className="flex flex-col divide-y divide-line rounded-[var(--radius-lg)] border border-line bg-surface px-4">
                    {comments.map(r => (
                      <Row key={r.id} rule={r} {...rowProps(r)} onToggle={toggle} onEdit={() => setEditing({ kind: 'COMMENT', rule: r })} onDelete={remove}>
                        <p className="text-sm"><span className="text-muted">على: </span>{r.postExternalId ? `بوست «${r.postLabel || 'بوست معيّن'}»` : 'كل البوستات'} · {r.platforms.map(p => PLATFORM_LABEL[p]).join(' و')}</p>
                        <p className="text-sm"><span className="text-muted">لو الكومنت فيه: </span>{r.keywords.length ? <Words words={r.keywords} /> : 'أي كلام'}</p>
                        {!!r.publicReplies.length && <p className="text-sm"><span className="text-muted">يرد تحت الكومنت: </span>{r.publicReplies[0]}{r.publicReplies.length > 1 && <span className="text-muted"> (و{r.publicReplies.length - 1} صيغ تانية)</span>}</p>}
                        {r.reply && <p className="text-sm"><span className="text-muted">ويبعت في الخاص: </span>{r.reply}</p>}
                      </Row>
                    ))}
                  </ul>
                ) : (
                  <div className="flex flex-col items-start gap-2 rounded-[var(--radius-lg)] border border-dashed border-line p-5">
                    <MessagesSquare size={22} aria-hidden className="text-muted" />
                    <p className="text-muted">مثال: أي حد يكتب «بكام» تحت بوست، يتردّ عليه «بعتنالك السعر في الرسايل» ويوصله السعر في الخاص. الكومنتات اللي اتردّ عليها بتختفي من قايمة «الكومنتات».</p>
                  </div>
                )}
              </section>
            </>}
          </>}
      </div>
      {editing && client && data && (
        <Editor kind={editing.kind} rule={editing.rule} client={client} posts={data.posts}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />
      )}
    </>
  );
}

function NotConnected({ what }: { what: string }) {
  return <p className="rounded-[var(--radius-md)] bg-surface-2 p-4 text-sm text-muted">العميل ده مش رابط {what}. <Link href="/channels" className="font-semibold text-primary">اربطه من القنوات</Link></p>;
}

const Words = ({ words }: { words: string[] }) => <>{words.map((w, i) => <span key={i}>{i ? '، ' : ''}<b className="font-semibold">«{w}»</b></span>)}</>;
const Said = ({ text }: { text: string | null }) => text ? <p className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-2 px-3 py-2 text-sm leading-6">{text}</p> : null;

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange} disabled={disabled} className="grid h-11 w-14 shrink-0 place-items-center disabled:opacity-60">
      <span className={cx('relative h-6 w-11 rounded-full transition-colors', on ? 'bg-primary' : 'bg-line')}>
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'start-[22px]' : 'start-0.5')} />
      </span>
    </button>
  );
}

function Stats({ rule }: { rule: AutoRule }) {
  return (
    <p className="text-xs text-muted">
      {timesLabel(rule.fired)}{rule.lastFiredAt ? ` · آخر مرة ${when(rule.lastFiredAt)}` : ''}
      {rule.lastError && <span className="block text-danger">آخر مرة ما نفعش: {rule.lastError}</span>}
    </p>
  );
}

function Card({ icon, title, sub, rule, empty, children, onToggle, onEdit, pending, error }: { icon: ReactNode; title: string; sub: string; rule?: AutoRule; empty: string; children?: ReactNode; onToggle: (r: AutoRule) => void; onEdit: () => void; pending?: boolean; error?: string | null }) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-primary">{icon}</span>
        <div className="flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-sm text-muted">{sub}</p>
        </div>
        {rule ? <>
          {!rule.enabled && <Pill>متوقفة</Pill>}
          <Button variant="ghost" className="h-11" onClick={onEdit}><Pencil size={15} aria-hidden />تعديل</Button>
          <Switch on={rule.enabled} onChange={() => onToggle(rule)} label={title} disabled={pending} />
        </> : <Button className="h-11" onClick={onEdit}>فعّلها</Button>}
      </div>
      {rule ? <>{children}<Stats rule={rule} /></> : <p className="text-sm text-muted">{empty}</p>}
      <ErrorText error={error} />
    </div>
  );
}

function Row({ rule, children, onToggle, onEdit, onDelete, pending, error }: { rule: AutoRule; children: ReactNode; onToggle: (r: AutoRule) => void; onEdit: () => void; onDelete: (r: AutoRule) => void; pending?: boolean; error?: string | null }) {
  const [sure, setSure] = useState(false);
  const title = rule.name || (rule.keywords[0] ? `الرد على «${rule.keywords[0]}»` : 'الرد على الكومنتات');
  return (
    <li className={cx('flex flex-col gap-2 py-4', !rule.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex-1 font-semibold">{title}</h4>
        {!rule.enabled && <Pill>متوقف</Pill>}
        <Switch on={rule.enabled} onChange={() => onToggle(rule)} label={title} disabled={pending} />
        <button type="button" onClick={onEdit} aria-label={`تعديل ${title}`} className="grid size-11 place-items-center rounded-[var(--radius-md)] text-muted hover:bg-surface-2 hover:text-ink"><Pencil size={17} aria-hidden /></button>
        {sure ? <span role="group" aria-label={`تمسح ${title}؟`} className="flex flex-wrap items-center gap-2">
          <span className="text-sm">تمسحه خالص؟</span>
          <Button variant="danger" className="h-11" disabled={pending} onClick={() => onDelete(rule)}>{pending ? 'بيمسح…' : 'أيوه، امسحه'}</Button>
          <Button variant="ghost" className="h-11" autoFocus onClick={() => setSure(false)}>لأ، سيبه</Button>
        </span> : <button type="button" onClick={() => setSure(true)} aria-label={`امسح ${title}`} className="grid size-11 place-items-center rounded-[var(--radius-md)] text-muted hover:bg-surface-2 hover:text-danger"><Trash2 size={17} aria-hidden /></button>}
      </div>
      {children}
      <Stats rule={rule} />
      <ErrorText error={error} />
    </li>
  );
}

const TITLES: Record<AutoKind, [string, string]> = {
  WELCOME: ['رسالة الترحيب', 'رسالة الترحيب'], AWAY: ['برّه مواعيد الشغل', 'برّه مواعيد الشغل'],
  KEYWORD: ['رد جديد على كلمة', 'تعديل الرد'], COMMENT: ['رد جديد على الكومنتات', 'تعديل الرد على الكومنتات']
};
const MAX_REPLY = 1000, MAX_PUBLIC = 5;

/** Puts "[الاسم]" where the cursor is in a textarea, and the cursor right after it. */
function NameButton({ target, value, set }: { target: RefObject<HTMLTextAreaElement | null>; value: string; set: (v: string) => void }) {
  return (
    <button type="button" className="min-h-11 self-start text-sm font-semibold text-primary" onClick={() => {
      const el = target.current;
      const a = el?.selectionStart ?? value.length, b = el?.selectionEnd ?? value.length;
      const pad = a > 0 && !/\s$/.test(value.slice(0, a)) ? ' ' : '';
      const next = `${value.slice(0, a)}${pad}${NAME_TOKEN}${value.slice(b)}`;
      set(next);
      requestAnimationFrame(() => { if (el) { el.focus(); const at = a + pad.length + NAME_TOKEN.length; el.setSelectionRange(at, at); } });
    }}>+ اسم الشخص</button>
  );
}

function Editor({ kind, rule, client, posts, onClose, onSaved }: { kind: AutoKind; rule?: AutoRule; client: AutoClient; posts: AutoPost[]; onClose: () => void; onSaved: () => void }) {
  // Only what the client still has connected: a channel removed since cannot be unticked, so it is dropped here.
  const [channels, setChannels] = useState<ChatChannel[]>(() => { const ok = (rule?.channels ?? []).filter(c => client.channels.includes(c)); return ok.length ? ok : client.channels; });
  const [platforms, setPlatforms] = useState<Platform[]>(() => { const ok = (rule?.platforms ?? []).filter(p => client.platforms.includes(p)); return ok.length ? ok : client.platforms; });
  const [words, setWords] = useState(rule?.keywords.join('، ') ?? '');
  const [reply, setReply] = useState(rule?.reply ?? (kind === 'WELCOME' ? `أهلًا يا ${NAME_TOKEN} 👋 نورتنا! قولنا محتاج إيه وهنرد عليك حالًا.` : kind === 'AWAY' ? 'أهلًا بيك 🌙 إحنا قافلين دلوقتي، وهنرد عليك أول ما نفتح الصبح.' : ''));
  const [publics, setPublics] = useState(rule?.publicReplies.join('\n') ?? (kind === 'COMMENT' ? 'بعتنالك التفاصيل في الرسايل 💬\nشوف رسايلك، بعتنالك كل حاجة 🙏' : ''));
  const [post, setPost] = useState(rule?.postExternalId ?? '');
  const [hours, setHours] = useState<Hours>(rule?.hours ?? { days: [6, 0, 1, 2, 3, 4], from: '10:00', to: '22:00' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null), pubRef = useRef<HTMLTextAreaElement>(null);
  const initial = useRef<string | null>(null);
  const snapshot = JSON.stringify([channels, platforms, words, reply, publics, post, hours]);
  if (initial.current === null) initial.current = snapshot;
  const dirty = snapshot !== initial.current;
  const close = () => { if (!dirty || window.confirm('عندك تعديلات لسه ما اتحفظتش. تخرج من غير ما تحفظ؟')) onClose(); };

  const chosenPost = posts.find(p => p.externalId === post && platforms.includes(p.platform));
  const legacyPost = !!post && !posts.some(p => p.externalId === post); // picked before, no longer in the recent list
  const wordList = splitWords(words);
  const publicList = publics.split('\n').map(x => x.trim()).filter(Boolean);

  function problem(): string | null {
    if (kind === 'COMMENT' ? !platforms.length : !channels.length) return 'اختار مكان واحد على الأقل';
    if (kind === 'KEYWORD' && !wordList.length) return 'اكتب كلمة واحدة على الأقل';
    if (wordList.some(w => w.length > 60)) return 'في كلمة طويلة أوي، خليها أقل من 60 حرف';
    if (kind === 'AWAY' && !hours.days.length) return 'اختار يوم واحد على الأقل';
    if (kind === 'AWAY' && hours.from === hours.to) return 'وقت الفتح والقفل زي بعض';
    if (kind === 'COMMENT') {
      if (!publicList.length && !reply.trim()) return 'اكتب رد تحت الكومنت أو رسالة في الخاص';
      if (publicList.length > MAX_PUBLIC) return `بحد أقصى ${MAX_PUBLIC} ردود تحت الكومنت`;
    } else if (!reply.trim()) return 'اكتب الرد';
    return null;
  }

  async function save() {
    const p = problem();
    if (p) { setErr(p); return; }
    setBusy(true); setErr(null);
    const base = { kind, ...(kind === 'COMMENT' ? { platforms } : { channels }) };
    const body = kind === 'WELCOME' ? { ...base, reply }
      : kind === 'AWAY' ? { ...base, reply, hours }
      : kind === 'KEYWORD' ? { ...base, keywords: wordList, reply }
      : { ...base, keywords: wordList, postExternalId: chosenPost || legacyPost ? post : null, postLabel: chosenPost ? chosenPost.caption.slice(0, 60) : rule?.postLabel ?? null, publicReplies: publicList, reply: reply.trim() || undefined };
    try {
      if (rule) await api(`/automations/${rule.id}`, { method: 'PATCH', body });
      else await api('/automations', { body: { clientId: client.id, ...body } });
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const nameHint = <p className="text-sm text-muted">{NAME_TOKEN} بيتكتب مكانه الاسم الأول للشخص، ولو مش واضح بيتكتب «حضرتك».</p>;

  return (
    <Modal open onClose={close} title={TITLES[kind][rule ? 1 : 0]}>
      <form className="flex flex-col gap-5" onSubmit={e => { e.preventDefault(); void save(); }}>
        {rule && !rule.enabled && <p className="rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm">الرد ده متوقف. هيفضل متوقف لحد ما تشغّله من الزرار.</p>}
        {kind === 'COMMENT' ? <>
          <Checks legend="فين؟" options={client.platforms.map(p => ({ v: p, label: PLATFORM_LABEL[p] }))} value={platforms}
            onChange={v => { const next = toggleIn(platforms, v); setPlatforms(next); if (chosenPost && !next.includes(chosenPost.platform)) setPost(''); }} />
          <Field label="على أنهي بوست؟" id="au-post" hint={posts.length ? undefined : 'البوستات اللي اتنشرت من دوسلي بتظهر هنا. من غيرها الرد بيشتغل على كل البوستات.'}>
            <Select id="au-post" className="h-11" value={chosenPost || legacyPost ? post : ''} onChange={e => setPost(e.target.value)}>
              <option value="">كل البوستات</option>
              {legacyPost && <option value={post}>{rule?.postLabel || 'البوست اللي اخترته قبل كده'}</option>}
              {posts.filter(p => platforms.includes(p.platform)).map(p => <option key={p.externalId} value={p.externalId}>{PLATFORM_LABEL[p.platform]}: {p.caption.slice(0, 50) || 'بوست من غير كلام'}</option>)}
            </Select>
          </Field>
          <Field label="لو الكومنت فيه كلمة من دول" id="au-words" hint="اكتب كل كلمة وبعدها فاصلة (،). سيبها فاضية لو عايزه يرد على أي كومنت، حتى الكومنتات اللي مالهاش علاقة.">
            <Input id="au-words" className="h-11" value={words} onChange={e => setWords(e.target.value)} placeholder="بكام، السعر، تفاصيل" />
          </Field>
          {!!wordList.length && <p className="-mt-3 text-sm text-muted">هيرد لو حد كتب: <Words words={wordList} /></p>}
          <div className="flex flex-col gap-1">
            <Field label="يرد تحت الكومنت (قدّام الناس)" id="au-pub" hint={`اكتب لحد ${MAX_PUBLIC} ردود، كل رد في سطر، ودوسلي يختار واحد كل مرة عشان الصفحة متكررش نفس الكلام.`}>
              <Textarea ref={pubRef} id="au-pub" rows={3} value={publics} onChange={e => setPublics(e.target.value)} />
            </Field>
            <NameButton target={pubRef} value={publics} set={setPublics} />
          </div>
          <div className="flex flex-col gap-1">
            <Field label="ويبعت في الخاص" id="au-reply" hint="اختياري. رسالة واحدة بس للشخص، ولو رد عليها تكمّلوا عادي في المحادثات.">
              <Textarea ref={replyRef} id="au-reply" rows={3} maxLength={MAX_REPLY} value={reply} onChange={e => setReply(e.target.value)} placeholder="أهلًا يا [الاسم]، السعر 450 جنيه والشحن لكل المحافظات" />
            </Field>
            <NameButton target={replyRef} value={reply} set={setReply} />
          </div>
          {nameHint}
        </> : <>
          <Checks legend="على أنهي قناة؟" options={client.channels.map(c => ({ v: c, label: CHANNEL_LABEL[c] }))} value={channels} onChange={v => setChannels(toggleIn(channels, v))} />
          {kind === 'KEYWORD' && <>
            <Field label="لو حد كتب كلمة من دول" id="au-words" hint="اكتب كل كلمة وبعدها فاصلة (،). مثال: بكام، السعر، الأسعار. بيلقط الكلمة حتى لو مكتوبة بهمزة أو من غيرها.">
              <Input id="au-words" className="h-11" value={words} onChange={e => setWords(e.target.value)} placeholder="بكام، السعر، الأسعار" />
            </Field>
            {!!wordList.length && <p className="-mt-3 text-sm text-muted">هيرد لو حد كتب: <Words words={wordList} /></p>}
          </>}
          {kind === 'AWAY' && <HoursPicker value={hours} onChange={setHours} />}
          <div className="flex flex-col gap-1">
            <Field label="الرد" id="au-reply">
              <Textarea ref={replyRef} id="au-reply" rows={4} maxLength={MAX_REPLY} value={reply} onChange={e => setReply(e.target.value)} />
            </Field>
            <NameButton target={replyRef} value={reply} set={setReply} />
            {nameHint}
          </div>
        </>}
        <ErrorText error={err} />
        <div className="sticky bottom-0 -mx-6 -mb-6 grid grid-cols-2 gap-2 border-t border-line bg-surface p-4">
          <Button type="submit" className="h-12" disabled={busy}>{busy ? 'بيحفظ…' : rule ? 'احفظ' : 'احفظ وشغّل'}</Button>
          <Button type="button" variant="ghost" className="h-12" onClick={close}>رجوع</Button>
        </div>
      </form>
    </Modal>
  );
}

function Checks<T extends string>({ legend, options, value, onChange }: { legend: string; options: { v: T; label: string }[]; value: T[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(o => (
          <label key={o.v} className={cx('flex h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-3', value.includes(o.v) ? 'border-primary bg-primary/8' : 'border-line')}>
            <input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={value.includes(o.v)} onChange={() => onChange(o.v)} />{o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function HoursPicker({ value, onChange }: { value: Hours; onChange: (h: Hours) => void }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-[13px] font-semibold">مواعيد الشغل (بتوقيت القاهرة)</legend>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="الأيام">
        {DAYS.map((d, i) => (
          <button key={d} type="button" aria-pressed={value.days.includes(i)} onClick={() => onChange({ ...value, days: value.days.includes(i) ? value.days.filter(x => x !== i) : [...value.days, i] })}
            className={cx('h-11 min-w-14 rounded-[var(--radius-md)] border px-2 text-sm font-semibold', value.days.includes(i) ? 'border-primary bg-primary text-on-primary' : 'border-line text-muted')}>{d}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="بتفتحوا" id="au-from"><Select id="au-from" className="h-11" value={value.from} onChange={e => onChange({ ...value, from: e.target.value })}>{HALF_HOURS.map(t => <option key={t} value={t}>{timeLabel(t)}</option>)}</Select></Field>
        <Field label="وبتقفلوا" id="au-to"><Select id="au-to" className="h-11" value={value.to} onChange={e => onChange({ ...value, to: e.target.value })}>{HALF_HOURS.map(t => <option key={t} value={t}>{timeLabel(t)}</option>)}</Select></Field>
      </div>
      <p className="text-sm text-muted">لو بتقفلوا بعد نص الليل (مثلًا لحد 2 بالليل) اكتبها عادي. الرد ده بيوصل للشخص مرة واحدة كل 12 ساعة.</p>
    </fieldset>
  );
}
