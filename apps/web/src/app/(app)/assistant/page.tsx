'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Bot, Sparkles, UserRound } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { CHANNEL_LABEL, type AutoClient, type ChatChannel } from '@/lib/automations';
import { Button, cx, Empty, ErrorText, Modal, PageHeader, Pill, Select, Textarea } from '@/components/ui';

type Mode = 'OFF' | 'SUGGEST' | 'AUTO';
type Assistant = { mode: Mode; channels: ChatChannel[]; knowledge: string; suggested: number; autoSent: number; handoffs: number; lastError: string | null; updatedAt: string };
type Data = { engine: 'claude' | 'demo'; assistant: Assistant | null };
type Answer = { reply: string; sure: boolean; handoff: boolean; reason: string };

const MAX = 12_000;
const MODES: { v: Mode; title: string; sub: string }[] = [
  { v: 'OFF', title: 'مقفول', sub: 'الفريق بيرد بنفسه زي ما هو.' },
  { v: 'SUGGEST', title: 'يقترح رد بس', sub: 'في المحادثات هيظهر زرار «اقترح رد». المساعد يكتب، وانت تراجع وتبعت.' },
  { v: 'AUTO', title: 'يرد لوحده لو متأكد', sub: 'بيرد على الزبون على طول من غير ما حد يراجع، بس على الأسئلة اللي إجابتها مكتوبة تحت. لو مش متأكد أو في شكوى، بيسيبها لحد من الفريق ويعلّم على المحادثة.' }
];
const STARTER = `النشاط: (مثلًا: محل عطور أونلاين، بنشحن لكل المحافظات)

المنتجات والأسعار:
- 

التوصيل (أنهي محافظات، بكام، وبياخد قد إيه):
- 

الدفع:
- 

المواعيد والعنوان:
- 

الاسترجاع والاستبدال:
- `;
const PLACEHOLDER = 'مثلًا:\nعود ملكي 50 مل: 450 جنيه\nالتوصيل للقاهرة والجيزة في يومين بـ 50 جنيه\nالدفع كاش عند الاستلام';
/** Drops template lines nobody filled ("-" alone, the example line) and headings left with nothing under them. */
function cleanKnowledge(t: string) {
  const lines = t.split('\n').filter(l => !/^\s*[-•*]\s*$/.test(l) && !l.startsWith('النشاط: (مثلًا'));
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (/:\s*$/.test(l)) {
      const next = lines.slice(i + 1).find(x => x.trim());
      if (!next || /:\s*$/.test(next)) return;
    }
    out.push(l);
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The client's AI assistant: what it knows about the business, and whether it drafts or answers on its own. */
export default function AssistantPage() {
  const { data: clients, error: cErr } = useSWR<AutoClient[]>('/automations/options', fetcher as never);
  const [clientId, setClientId] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!clientId && clients?.[0]) setClientId(clients[0].id); }, [clients, clientId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const client = clients?.find(c => c.id === clientId);
  const { data, error, mutate } = useSWR<Data>(clientId ? `/assistant?clientId=${clientId}` : null, fetcher as never);

  return (
    <>
      <PageHeader title="المساعد الذكي" sub="مساعد بالذكاء الاصطناعي بيرد على زباين العميل بالمصري، من المعلومات اللي انت بتكتبها عن النشاط بس. مش بيألّف أسعار، ولو مش متأكد بيسيب الرد لحد من الفريق." />
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8 max-md:p-4">
        {cErr ? <ErrorText error="مش قادرين نجيب العملاء دلوقتي. جرّب تاني بعد شوية." />
          : !clients ? <p role="status" className="text-muted">بيحمّل…</p>
          : !clients.length ? <Empty title="لسه مفيش عملاء">ضيف عميل واربط له واتساب أو صفحة فيسبوك، وبعدين ارجع هنا.</Empty>
          : <>
            {clients.length > 1 && (
              <div className="w-64 max-sm:w-full">
                <label htmlFor="ai-client" className="mb-2 block text-[13px] font-semibold">العميل</label>
                <Select id="ai-client" className="h-11" value={clientId} onChange={e => { if (!dirty || window.confirm('في تغييرات ما اتحفظتش. تسيبها؟')) { setDirty(false); setClientId(e.target.value); } }}>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
            )}
            {error ? <div className="flex items-center gap-3"><ErrorText error="مش قادرين نجيب إعدادات المساعد." /><Button variant="ghost" className="h-11" onClick={() => mutate()}>جرّب تاني</Button></div>
              : !data || !client ? <p role="status" className="text-muted">بيحمّل…</p>
              : <Settings key={clientId} client={client} data={data} onSaved={() => mutate()} onDirty={setDirty} />}
          </>}
      </div>
    </>
  );
}

function Settings({ client, data, onSaved, onDirty }: { client: AutoClient; data: Data; onSaved: () => void; onDirty: (d: boolean) => void }) {
  const a = data.assistant;
  const savedChannels = a?.channels ?? [];
  const [mode, setMode] = useState<Mode>(a?.mode ?? 'OFF');
  const [channels, setChannels] = useState<ChatChannel[]>(savedChannels);
  const [knowledge, setKnowledge] = useState(a?.knowledge ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const know = useRef<HTMLTextAreaElement>(null);
  const dirty = mode !== (a?.mode ?? 'OFF') || knowledge !== (a?.knowledge ?? '') || channels.join() !== savedChannels.join();
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const noChannels = !client.channels.length;
  const channelNames = channels.map(c => CHANNEL_LABEL[c]).join(' و');

  async function save(confirmed = false) {
    if (mode === 'AUTO' && a?.mode !== 'AUTO' && !confirmed) { setConfirmAuto(true); return; }
    setConfirmAuto(false); setSaving(true); setErr(null); setSaved(false);
    const clean = cleanKnowledge(knowledge);
    try {
      await api('/assistant', { method: 'PUT', body: { clientId: client.id, mode, channels: channels.filter(c => client.channels.includes(c)), knowledge: clean } });
      setKnowledge(clean); setSaved(true); onSaved();
    } catch (e) {
      const m = (e as Error).message; setErr(m);
      if (/معلومات/.test(m)) know.current?.focus();
    } finally { setSaving(false); }
  }
  const toggleChannel = (c: ChatChannel) => setChannels(cs => (cs.includes(c) ? cs.filter(x => x !== c) : [...cs, c]));

  return (
    <div className="flex flex-col gap-6">
      {data.engine === 'demo' && (
        <p className="rounded-[var(--radius-md)] bg-surface-2 px-4 py-3 text-sm text-muted">
          <b className="text-ink">النسخة دي تجريبية:</b> المساعد بيدوّر على كلمات من سؤال الزبون في المعلومات اللي كتبتها. في النسخة الحقيقية هيفهم الكلام أحسن بكتير.
        </p>
      )}
      {a?.lastError && a.mode === 'AUTO' && (
        <p role="alert" className="rounded-[var(--radius-md)] bg-danger/10 px-4 py-3 text-sm text-danger">آخر مرة المساعد ما عرفش يرد: {a.lastError}. الزباين دول محتاجين حد يرد عليهم.</p>
      )}
      {a && (a.suggested || a.autoSent || a.handoffs) ? (
        <dl className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
          {[{ k: 'اقترح ردود', v: a.suggested }, { k: 'رد لوحده', v: a.autoSent }, { k: 'حوّلها للفريق', v: a.handoffs }].map(x => (
            <div key={x.k} className="rounded-[var(--radius-lg)] border border-line bg-surface p-4"><dt className="text-sm text-muted">{x.k}</dt><dd className="num font-display text-2xl font-bold">{x.v}</dd></div>
          ))}
        </dl>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-display text-xl font-bold">المساعد يشتغل إزاي؟</legend>
        {MODES.map(m => {
          const off = m.v === 'AUTO' && noChannels;
          return (
            <label key={m.v} className={cx('flex min-h-11 items-start gap-3 rounded-[var(--radius-lg)] border bg-surface p-4', off ? 'opacity-60' : 'cursor-pointer', mode === m.v ? 'border-primary ring-1 ring-primary' : 'border-line')}>
              <input type="radio" name="ai-mode" value={m.v} checked={mode === m.v} disabled={off} onChange={() => { setMode(m.v); setSaved(false); }} className="mt-1 size-5 accent-[var(--color-primary)]" />
              <span className="flex flex-col gap-1"><span className="font-semibold">{m.title}</span><span className="text-sm text-muted">{off ? 'اربط قناة للعميل ده الأول من صفحة القنوات.' : m.sub}</span></span>
            </label>
          );
        })}
      </fieldset>

      {mode === 'AUTO' && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">يرد لوحده على:</legend>
          {noChannels ? <p className="text-sm text-muted">العميل ده لسه مفيش له قناة متوصّلة. اربط واتساب أو ماسنجر أو إنستجرام من صفحة القنوات.</p> : (
            <div className="flex flex-wrap gap-2">
              {client.channels.map(c => (
                <label key={c} className={cx('flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border px-3', channels.includes(c) ? 'border-primary bg-primary/8' : 'border-line')}>
                  <input type="checkbox" checked={channels.includes(c)} onChange={() => { toggleChannel(c); setSaved(false); }} className="size-5 accent-[var(--color-primary)]" />{CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
          )}
          <p className="text-sm text-muted">لما حد من الفريق يرد بنفسه في محادثة، المساعد بيسكت فيها نص ساعة. ولو العميل اشتكى أو سأل عن طلب معيّن، بيقوله إن حد من الفريق هيرد عليه ويستنّاكم.</p>
        </fieldset>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor="ai-know" className="font-display text-xl font-bold">المساعد يعرف إيه عن {client.name}؟</label>
        <p className="text-sm text-muted">اكتب كل حاجة الزباين بيسألوا عنها: المنتجات والأسعار، التوصيل، الدفع، المواعيد، الاسترجاع. المساعد مش هيقول أي حاجة مش مكتوبة هنا.</p>
        {!knowledge.trim() && <button type="button" onClick={() => setKnowledge(STARTER)} className="min-h-11 self-start px-1 text-sm font-semibold text-primary">ابدأ بنموذج تكمّل عليه</button>}
        <Textarea ref={know} id="ai-know" rows={14} maxLength={MAX} value={knowledge} placeholder={PLACEHOLDER} onChange={e => { setKnowledge(e.target.value); setSaved(false); }} dir="auto" />
        <p className="num text-xs text-muted">{knowledge.length.toLocaleString('ar-EG')} / {MAX.toLocaleString('ar-EG')} حرف</p>
      </div>

      <div className="sticky bottom-0 z-[1] -mx-4 mb-4 flex flex-wrap items-center gap-3 border-t border-line bg-surface-2/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        <Button className="h-11" onClick={() => void save()} disabled={saving || !dirty}>{saving ? 'بيحفظ…' : 'احفظ'}</Button>
        <span role="status" className={cx('text-sm font-semibold', dirty ? 'text-muted' : 'text-success')}>{dirty ? 'في تغييرات ما اتحفظتش' : saved ? 'اتحفظ ✓' : ''}</span>
        <ErrorText error={err} />
      </div>

      <TryIt clientId={client.id} knowledge={cleanKnowledge(knowledge)} mode={mode} />
      <Modal open={confirmAuto} onClose={() => setConfirmAuto(false)} title="تشغّل الرد لوحده؟">
        <div className="flex flex-col gap-4">
          <p>المساعد هيبعت ردود للزباين على {channelNames || 'القنوات اللي اخترتها'} من غير ما حد يراجعها. أي غلطة في المعلومات اللي كتبتها هتوصل للزبون. جرّبه الأول تحت بأسئلة حقيقية.</p>
          <div className="flex flex-wrap gap-2">
            <Button className="h-11" onClick={() => void save(true)}>أيوه، شغّله</Button>
            <Button className="h-11" variant="ghost" onClick={() => setConfirmAuto(false)}>لسه</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** A test box: type what a customer would write and see what the assistant answers, before turning it on. */
function TryIt({ clientId, knowledge, mode }: { clientId: string; knowledge: string; mode: Mode }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (!q.trim()) return;
    setBusy(true); setErr(null); setAns(null);
    try { setAns(await api<Answer>('/assistant/try', { body: { clientId, knowledge, question: q } })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <section aria-labelledby="try-h" className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <h2 id="try-h" className="flex items-center gap-2 font-display text-xl font-bold"><Sparkles size={20} aria-hidden className="text-primary" />جرّبه</h2>
      <p className="text-sm text-muted">اكتب سؤال زي ما الزبون هيكتبه، وشوف المساعد هيرد إزاي (بالمعلومات اللي فوق، حتى لو لسه ما حفظتهاش).</p>
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void run(); }}>
        <label htmlFor="try-q" className="sr-only">سؤال الزبون</label>
        <input id="try-q" value={q} onChange={e => setQ(e.target.value)} maxLength={500} placeholder="مثلًا: التوصيل لإسكندرية بكام؟" dir="auto"
          className="h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-line bg-surface px-3" />
        <Button className="h-11" type="submit" disabled={busy || !q.trim() || !knowledge.trim()}>{busy ? 'بيفكّر…' : 'اسأل'}</Button>
      </form>
      {!knowledge.trim() && <p className="text-sm text-muted">اكتب معلومات عن النشاط الأول عشان تقدر تجرّب.</p>}
      <ErrorText error={err} />
      <div aria-live="polite" className="flex flex-col gap-2">
      {busy && <p className="text-sm text-muted">المساعد بيفكّر…</p>}
      {ans && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Bot size={18} aria-hidden className="mt-1 shrink-0 text-primary" />
            <p className="rounded-[var(--radius-md)] bg-surface-2 px-3 py-2" dir="auto">{ans.reply || '—'}</p>
          </div>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {mode === 'OFF' ? <Pill>المساعد مقفول، ده مجرد تجربة</Pill>
              : ans.handoff ? <Pill tone="sun"><UserRound size={12} aria-hidden />هيسيبها لحد من الفريق</Pill>
              : mode === 'SUGGEST' ? <Pill tone="info">الرد ده هيظهر كاقتراح في المحادثة</Pill>
              : ans.sure ? <Pill tone="good">متأكد، هيبعته لوحده</Pill> : <Pill tone="sun">مش متأكد، هيسيبه لحد من الفريق</Pill>}
            {ans.reason && <span className="text-muted">{ans.reason}</span>}
          </p>
        </div>
      )}
      </div>
    </section>
  );
}
