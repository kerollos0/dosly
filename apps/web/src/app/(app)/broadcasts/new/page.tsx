'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { ArrowRight, ImagePlus, Send, UserRound } from 'lucide-react';
import { api, fetcher, type TemplateField } from '@/lib/api';
import {
  AUDIENCES, badParam, blanks, cairoLocal, fillPreview, fromCairoLocal, NAME_TOKEN, wordsBefore,
  type AudienceCount, type AudienceKind, type BroadcastOptions, type BroadcastTemplate
} from '@/lib/broadcasts';
import { Bubble, peopleWord } from '@/components/broadcast';
import { uploadWithProgress } from '@/components/inbox/upload';
import { Button, cx, ErrorText, Field, Input, PageHeader, Pill, Select } from '@/components/ui';
import { count } from '@/lib/when';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-5 max-sm:p-4">
      <h2 id={`step-${n}`} className="flex items-center gap-3 font-display text-lg font-bold">
        <span className="num grid size-8 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">{n}</span>{title}
      </h2>
      {children}
    </section>
  );
}

/** "اللي بعد «عندنا عرض لآخر الأسبوع:»": a field named by where its words go. */
function fieldLabel(f: TemplateField, t: BroadcastTemplate) {
  if (f.part === 'button') return `آخر لينك زرار «${t.shape.buttons[f.buttonIndex ?? 0]?.text ?? ''}»`;
  if (!/^\d+$/.test(f.key)) return f.key.replace(/_/g, ' ');
  const before = wordsBefore(f.part === 'header' ? t.shape.headerText ?? '' : t.shape.body, f.key);
  return before ? `اللي بعد «${before}»` : 'أول الرسالة';
}
const looksLikeName = (f: TemplateField) => /name|اسم/i.test(f.key);
const MAX_IMAGE = 5 * 1024 * 1024;
const unsupported = (x: BroadcastTemplate) => !!x.shape.headerMedia && x.shape.headerMedia !== 'IMAGE';

/** A new broadcast on one page: whose customers, the message, who gets it, when. The summary says what will happen before sending. */
export default function NewBroadcast() {
  const router = useRouter();
  const { data: options, error: optErr } = useSWR<BroadcastOptions>('/broadcasts/options', fetcher as never, { revalidateOnFocus: false });
  const [clientId, setClientId] = useState('');
  const [numberId, setNumberId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [audience, setAudience] = useState<AudienceKind>('recent');
  const [days, setDays] = useState(30);
  const [whenMode, setWhenMode] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<AudienceKind, AudienceCount | 'error'>>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // One client: nothing to choose.
  useEffect(() => { if (options?.length === 1 && !clientId) setClientId(options[0]!.id); }, [options, clientId]);
  const client = options?.find(c => c.id === clientId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the person picks another client, not on every refetch
  useEffect(() => { setNumberId(client?.numbers[0]?.id ?? ''); setTemplateId(''); setFile(null); }, [clientId]);
  // Agreeing is about these particular people: choosing others asks again.
  useEffect(() => { setConsent(false); }, [clientId, numberId, audience]);
  const number = client?.numbers.find(n => n.id === numberId);
  const t: BroadcastTemplate | undefined = number?.templates.find(x => x.id === templateId);
  const image = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  function pick(x: BroadcastTemplate) {
    setTemplateId(x.id); setFile(null); setErr(null);
    if (fileInput.current) fileInput.current.value = '';
    // The first field is usually the greeting's name: prefill it.
    const first = x.shape.fields.find(f => f.part === 'body');
    setValues(first && (looksLikeName(first) || first.key === '1') ? { [first.id]: NAME_TOKEN } : {});
  }
  function chooseFile(f: File | null) {
    if (f && f.size > MAX_IMAGE) { setErr('الصورة أكبر من 5 ميجا، وده أقصى حجم في واتساب. صغّرها وجرّب تاني.'); if (fileInput.current) fileInput.current.value = ''; return; }
    setErr(null); setFile(f);
  }

  // How many people each audience reaches on this number (and template, for the price).
  useEffect(() => {
    if (!numberId) return;
    let live = true;
    setCounts({});
    for (const a of AUDIENCES) {
      void api<AudienceCount>('/broadcasts/audience', { body: { waNumberId: numberId, templateId: templateId || undefined, audience: { kind: a.kind, ...(a.kind === 'recent' && { days }) } } })
        .then(c => { if (live) setCounts(p => ({ ...p, [a.kind]: c })); })
        .catch(() => { if (live) setCounts(p => ({ ...p, [a.kind]: 'error' })); });
    }
    return () => { live = false; };
  }, [numberId, templateId, days]);

  const raw = counts[audience];
  const c = raw && raw !== 'error' ? raw : undefined;
  const now = Date.now();
  const atDate = at ? fromCairoLocal(at) : null;
  const fieldsOk = !!t && t.shape.fields.every(f => values[f.id]?.trim() && !badParam(values[f.id]!));
  const headerOk = !!t && !unsupported(t) && (!t.shape.headerMedia || !!file);
  const whenOk = whenMode === 'now' || (!!atDate && atDate.getTime() > now && atDate.getTime() < now + 30 * 86_400_000);
  const hasPeople = whenMode === 'later' || (c?.people ?? 0) > 0;
  const ready = !!t && fieldsOk && headerOk && whenOk && consent && hasPeople;
  const missing = !client ? 'اختار العميل' : !t ? 'اختار الرسالة'
    : unsupported(t) ? 'القالب ده مش مدعوم في الحملات، اختار غيره'
    : !headerOk ? 'ضيف صورة العرض' : !fieldsOk ? 'كمّل خانات الرسالة'
    : !whenOk ? (at ? 'الميعاد لازم يكون جاي، وخلال 30 يوم' : 'اختار اليوم والساعة')
    : raw === 'error' ? 'مش قادرين نعد الناس دلوقتي. جرّب تاني بعد شوية.'
    : !c && whenMode === 'now' ? 'بيعد الناس…'
    : !hasPeople ? 'مفيش حد في الجمهور ده دلوقتي' : !consent ? 'أكّد الموافقة فوق الزرار' : null;

  async function send() {
    if (!ready || !t) return;
    setBusy(true); setErr(null); setProgress(0);
    const sendAt = whenMode === 'later' && atDate ? atDate : new Date();
    const body = {
      waNumberId: numberId, templateId: t.id, values, consent: true,
      name: name.trim() || `حملة ${sendAt.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', timeZone: 'Africa/Cairo' })}`,
      audience: { kind: audience, ...(audience === 'recent' && { days }) },
      scheduledAt: whenMode === 'later' ? sendAt.toISOString() : null
    };
    try {
      let out: { id: string };
      if (t.shape.headerMedia && file) {
        const form = new FormData();
        form.set('data', JSON.stringify(body)); // the fields go before the file
        form.set('header', file);
        out = await uploadWithProgress<{ id: string }>('/broadcasts', form, setProgress);
      } else out = await api<{ id: string }>('/broadcasts', { body });
      router.push(`/broadcasts/${out.id}`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  if (optErr) return <p className="p-8"><ErrorText error={(optErr as Error).message} /></p>;
  if (!options) return <p role="status" className="p-8 text-muted">بيحمّل…</p>;
  const noNumbers = options.every(o => !o.numbers.length);
  const minAt = cairoLocal(new Date(now + 5 * 60_000));
  const maxAt = cairoLocal(new Date(now + 30 * 86_400_000 - 60_000));
  const notCounted = c ? [
    c.optedOut ? count(c.optedOut, 'شخص واحد طلب ميوصلوش عروض', 'شخصين طلبوا ميوصلهمش عروض', 'أشخاص طلبوا ميوصلهمش عروض', 'شخص طلبوا ميوصلهمش عروض') : '',
    c.gotOneToday ? count(c.gotOneToday, 'شخص واحد وصله عرض النهارده', 'شخصين وصلهم عرض النهارده', 'أشخاص وصلهم عرض النهارده', 'شخص وصلهم عرض النهارده') : ''
  ].filter(Boolean) : [];

  return (
    <>
      <PageHeader title="حملة جديدة" sub="رسالة واحدة، كل شخص يوصله باسمه في الخاص." action={<Link href="/broadcasts" className="flex min-h-11 items-center gap-1 font-semibold text-primary"><ArrowRight size={16} aria-hidden />كل الحملات</Link>} />
      {noNumbers ? (
        <p className="m-8 rounded-[var(--radius-md)] border border-warning/40 bg-warning/5 p-4 max-md:m-4">لازم رقم واتساب متوصل الأول. <Link href="/channels" className="font-semibold text-primary underline">وصّل رقم العميل</Link>.</p>
      ) : (
        <div className="grid items-start gap-6 p-8 max-md:p-4 lg:grid-cols-[1fr_340px]">
          <div className="flex flex-col gap-5">
            <Step n={1} title="لعملاء مين من عملاء الوكالة؟">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="العميل (البيزنس)" id="bc-client">
                  <Select id="bc-client" value={clientId} onChange={e => setClientId(e.target.value)} className="h-11">
                    <option value="">اختار العميل</option>
                    {options.filter(o => o.numbers.length).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </Select>
                </Field>
                {client && client.numbers.length > 1 && (
                  <Field label="من أنهي رقم" id="bc-num">
                    <Select id="bc-num" value={numberId} onChange={e => { setNumberId(e.target.value); setTemplateId(''); }} dir="ltr" className="h-11">
                      {client.numbers.map(n => <option key={n.id} value={n.id}>{n.displayPhone}</option>)}
                    </Select>
                  </Field>
                )}
              </div>
            </Step>

            {number && (
              <Step n={2} title="الرسالة">
                {!number.templates.length ? (
                  <p className="text-muted">مفيش رسايل جاهزة متوافق عليها على الرقم ده. واتساب بيسمح بالحملات من قوالب ميتا وافقت عليها بس: اعمل قالب «تسويقي» من WhatsApp Manager، ولما يتوافق عليه هيظهر هنا.</p>
                ) : (
                  <div role="radiogroup" aria-label="الرسالة الجاهزة" className="grid gap-2 sm:grid-cols-2">
                    {number.templates.map(x => (
                      <button key={x.id} type="button" role="radio" aria-checked={templateId === x.id} disabled={unsupported(x)} onClick={() => pick(x)}
                        className={cx('flex flex-col gap-2 rounded-[var(--radius-md)] border p-3 text-start disabled:cursor-not-allowed disabled:opacity-55', templateId === x.id ? 'border-primary bg-primary/6 ring-1 ring-primary' : 'border-line hover:bg-surface-2')}>
                        <span className="line-clamp-3 leading-6">{blanks(x.shape.body)}</span>
                        <span className="flex flex-wrap items-center gap-2">
                          <Pill tone={x.category === 'MARKETING' ? 'sun' : 'neutral'}>{x.category === 'MARKETING' ? 'عروض' : 'خدمية'}</Pill>
                          {x.shape.headerMedia === 'IMAGE' && <Pill tone="info">فيها صورة</Pill>}
                          {unsupported(x) && <Pill tone="neutral">فيها فيديو أو ملف: لسه مش مدعومة هنا</Pill>}
                          <bdi dir="ltr" className="text-xs text-muted">{x.name}</bdi>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {t && (
                  <div className="flex flex-col gap-4 border-t border-line pt-4">
                    {t.shape.headerMedia === 'IMAGE' && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[13px] font-semibold">صورة العرض (JPG أو PNG، لحد 5 ميجا)</span>
                        <input ref={fileInput} type="file" accept="image/jpeg,image/png" className="sr-only" id="bc-file" onChange={e => chooseFile(e.target.files?.[0] ?? null)} />
                        <Button type="button" variant="ghost" className="h-11 self-start" onClick={() => fileInput.current?.click()}><ImagePlus size={18} aria-hidden />{file ? 'غيّر الصورة' : 'اختار صورة'}</Button>
                        {file && <span className="text-sm text-muted">{file.name}</span>}
                      </div>
                    )}
                    {t.shape.fields.map(f => {
                      const v = values[f.id] ?? '';
                      const canName = f.part !== 'button' && !v.includes(NAME_TOKEN);
                      const addName = () => setValues(x => ({ ...x, [f.id]: `${x[f.id] ?? ''}${NAME_TOKEN}` }));
                      return (
                        <Field key={f.id} label={fieldLabel(f, t)} id={`bc-f-${f.id}`}>
                          <div className="flex gap-2">
                            <Input id={`bc-f-${f.id}`} value={v} dir="auto" maxLength={f.part === 'button' ? 200 : 1024} className="h-11"
                              onChange={e => setValues(x => ({ ...x, [f.id]: e.target.value }))} aria-invalid={!!v && badParam(v)} />
                            {canName && <Button type="button" variant="ghost" className="h-11 shrink-0 max-sm:hidden" onClick={addName}><UserRound size={16} aria-hidden />اسم الشخص</Button>}
                          </div>
                          {canName && <button type="button" onClick={addName} className="min-h-11 self-start text-sm font-semibold text-primary sm:hidden">+ اسم الشخص</button>}
                          {v && badParam(v) && <p className="text-sm text-danger">واتساب مش بيقبل سطر جديد أو أكتر من 4 مسافات ورا بعض هنا.</p>}
                        </Field>
                      );
                    })}
                    {t.shape.fields.some(f => (values[f.id] ?? '').includes(NAME_TOKEN)) && <p className="text-sm text-muted">«{NAME_TOKEN}» هيتكتب مكانه الاسم الأول لكل شخص، ولو الاسم مش واضح هيتكتب «حضرتك».</p>}
                  </div>
                )}
              </Step>
            )}

            {number && (
              <Step n={3} title="مين يوصله؟">
                <div role="radiogroup" aria-label="الجمهور" className="flex flex-col gap-2">
                  {AUDIENCES.map(a => {
                    const n = counts[a.kind];
                    return (
                      <label key={a.kind} className={cx('flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2', audience === a.kind ? 'border-primary bg-primary/6' : 'border-line hover:bg-surface-2')}>
                        <input type="radio" name="audience" checked={audience === a.kind} onChange={() => setAudience(a.kind)} className="size-5 shrink-0" />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="font-semibold">{a.label}</span>
                          <span className="text-sm text-muted">{a.hint}</span>
                          {a.kind === 'recent' && audience === 'recent' && (
                            <Select aria-label="آخر كام يوم" value={days} onChange={e => setDays(Number(e.target.value))} className="mt-1 h-11 w-40">
                              {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>آخر {d} يوم</option>)}
                            </Select>
                          )}
                        </span>
                        <span className="num min-w-10 text-end font-display text-lg font-bold tabular-nums">{n === 'error' ? '؟' : n ? n.people : '…'}</span>
                      </label>
                    );
                  })}
                </div>
                {notCounted.length > 0 && <p className="text-sm text-muted">مش محسوبين: {notCounted.join('، و')}.</p>}
              </Step>
            )}

            {number && (
              <Step n={4} title="إمتى؟">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="الميعاد">
                  {(['now', 'later'] as const).map(m => (
                    <button key={m} type="button" role="radio" aria-checked={whenMode === m} onClick={() => setWhenMode(m)}
                      className={cx('h-11 rounded-[var(--radius-md)] border px-4 font-semibold', whenMode === m ? 'border-primary bg-primary text-on-primary' : 'border-line hover:bg-surface-2')}>
                      {m === 'now' ? 'دلوقتي' : 'في ميعاد'}
                    </button>
                  ))}
                </div>
                {whenMode === 'later' && (
                  <Field label="اليوم والساعة (بتوقيت القاهرة)" id="bc-at" hint="أحسن وقت للعروض في مصر غالبًا بالليل بين 7 و10.">
                    <Input id="bc-at" type="datetime-local" min={minAt} max={maxAt} value={at} onChange={e => setAt(e.target.value)} className="h-11 max-w-xs" />
                  </Field>
                )}
                <Field label="اسم الحملة (ليك إنت بس)" id="bc-name"><Input id="bc-name" value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="مثلًا: عرض الجمعة البيضا" className="h-11 max-w-md" /></Field>
              </Step>
            )}
          </div>

          <aside aria-label="الملخص" className="sticky top-4 flex flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface-2 p-4 max-lg:static">
            <h2 className="font-semibold">الشخص هيشوفها كده</h2>
            {t ? (
              <Bubble image={image} imageLabel={t.shape.headerMedia === 'IMAGE' ? 'صورة العرض' : undefined}
                header={t.shape.headerText ? fillPreview(t.shape.headerText, values, 'header') : undefined}
                body={fillPreview(t.shape.body, values, 'body')} footer={t.shape.footer} buttons={t.shape.buttons.map(b => b.text)} />
            ) : <p className="text-sm text-muted">اختار الرسالة عشان تشوفها.</p>}
            {c && t && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="text-lg">هتتبعت {whenMode === 'later' ? 'لحوالي' : 'لـ'} <b>{peopleWord(c.people)}</b>{whenMode === 'now' ? ' دلوقتي' : ''}.</p>
                <p className="text-sm text-muted">تكلفة واتساب التقريبية: <b className="num">{c.costUsd.toLocaleString('en', { maximumFractionDigits: 2 })}$</b> (بتتخصم من حساب واتساب بتاع العميل، مش من دوسلي).</p>
                {c.overNewLimit && <p className="rounded-[var(--radius-md)] bg-warning/10 p-2 text-sm">لو البيزنس لسه مش موثّق في ميتا، الرقم يقدر يبعت لـ 250 شخص جديد بس في اليوم، والباقي هيفشل.</p>}
                {c.capped && <p className="text-sm text-warning">أقصى عدد في الحملة الواحدة 50,000.</p>}
              </div>
            )}
            {t && (
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
                <span>الناس دول كلّموا البيزنس أو اشتروا منه، وموافقين يوصلهم رسايل منه. (واتساب بيقفل الأرقام اللي بتبعت لناس مش عايزة.)</span>
              </label>
            )}
            <ErrorText error={err} />
            <Button size="lg" disabled={!ready || busy} onClick={send}>
              <Send size={18} aria-hidden />{busy ? (progress > 0 && progress < 1 ? `بيرفع الصورة ${Math.round(progress * 100)}%` : 'لحظة…') : whenMode === 'now' ? 'ابعت الحملة' : 'جدول الحملة'}
            </Button>
            {missing && !busy && <p role="status" className="text-center text-sm text-muted">{missing}</p>}
          </aside>
        </div>
      )}
    </>
  );
}
