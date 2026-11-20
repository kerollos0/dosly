'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Check, Pause, Pencil, Play, Plus, Square } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { money, nf } from '@/lib/ads';
import { day, fromMinor, PERIOD, PERIOD_SHORT, toMinor, type BillingClient, type Package, type Subscription } from '@/lib/billing';
import { BillingTabs } from '@/components/billing';
import { Button, cx, Empty, ErrorText, Field, Input, Modal, PageHeader, Pill, Select, Textarea } from '@/components/ui';
import { cairoDayKey, count } from '@/lib/when';

const CURRENCIES = ['EGP', 'USD', 'SAR', 'AED', 'EUR'];

function PackageForm({ p, onSaved }: { p?: Package; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const priceMinor = toMinor(String(f.get('price') ?? ''));
    if (priceMinor === null) { setErr('اكتب السعر بالأرقام'); return; }
    const posts = String(f.get('posts') ?? '').trim();
    const body = {
      name: String(f.get('name')), description: String(f.get('description') ?? ''), priceMinor, currency: String(f.get('currency')), months: Number(f.get('months')),
      features: String(f.get('features') ?? '').split('\n').map(s => s.trim()).filter(Boolean), postsPerMonth: posts ? Number(posts) : null
    };
    setBusy(true); setErr(null);
    try { await api(p ? `/billing/packages/${p.id}` : '/billing/packages', { method: p ? 'PATCH' : 'POST', body }); onSaved(); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="اسم الباقة" id="pk-name"><Input id="pk-name" name="name" defaultValue={p?.name} required maxLength={80} placeholder="مثلًا: باقة النمو" /></Field>
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <Field label="السعر" id="pk-price"><Input id="pk-price" name="price" inputMode="decimal" dir="ltr" className="text-end" defaultValue={p ? fromMinor(p.priceMinor) : ''} required /></Field>
        <Field label="العملة" id="pk-cur"><Select id="pk-cur" name="currency" defaultValue={p?.currency ?? 'EGP'}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</Select></Field>
      </div>
      <Field label="بتتدفع" id="pk-months"><Select id="pk-months" name="months" defaultValue={String(p?.months ?? 1)}>{[1, 3, 6, 12, 0].map(m => <option key={m} value={m}>{PERIOD[m]}</option>)}</Select></Field>
      <Field label="فيها إيه (كل سطر ميزة)" id="pk-features" hint="ده اللي العميل بيشوفه في البوابة تحت اسم باقته."><Textarea id="pk-features" name="features" rows={4} defaultValue={p?.features.join('\n')} placeholder={'12 بوست في الشهر\nالرد على الرسايل\nتقرير شهري'} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="وصف قصير (اختياري)" id="pk-desc"><Input id="pk-desc" name="description" defaultValue={p?.description ?? ''} maxLength={300} /></Field>
        <Field label="بوستات في الشهر (اختياري)" id="pk-posts"><Input id="pk-posts" name="posts" inputMode="numeric" defaultValue={p?.postsPerMonth ?? ''} /></Field>
      </div>
      {p && p.clients > 0 && <p className="text-sm text-muted">تغيير السعر بيسري على العملاء الجداد بس. العملاء اللي على الباقة دلوقتي بيفضل سعرهم زي ما هو، وتقدر تغيّره لكل عميل لوحده.</p>}
      <ErrorText error={err} />
      <Button size="lg" disabled={busy}>{p ? 'احفظ' : 'ضيف الباقة'}</Button>
    </form>
  );
}

function StartForm({ client, packages, onSaved }: { client: BillingClient; packages: Package[]; onSaved: () => void }) {
  const live = packages.filter(p => !p.archivedAt && p.months > 0);
  const [pkgId, setPkgId] = useState(live[0]?.id ?? '');
  const pkg = live.find(p => p.id === pkgId);
  const [price, setPrice] = useState('');
  const [startOn, setStartOn] = useState(cairoDayKey(new Date()));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!live.length) return <p className="text-muted">اعمل باقة شهرية الأول، وبعدين ارجع هنا.</p>;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const priceMinor = price ? toMinor(price) : undefined;
    if (priceMinor === null) { setErr('اكتب السعر بالأرقام'); return; }
    setBusy(true); setErr(null);
    try { await api('/billing/subscriptions', { body: { clientId: client.id, packageId: pkgId, startOn, ...(priceMinor !== undefined && { priceMinor }) } }); onSaved(); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  const startsToday = startOn <= cairoDayKey(new Date());
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field label="الباقة" id="st-pkg"><Select id="st-pkg" value={pkgId} onChange={e => setPkgId(e.target.value)}>{live.map(p => <option key={p.id} value={p.id}>{p.name}: {money(p.priceMinor, p.currency, true)} {PERIOD_SHORT[p.months]}</option>)}</Select></Field>
      <Field label="سعر خاص للعميل ده (اختياري)" id="st-price" hint={pkg ? `لو سبته فاضي: ${money(pkg.priceMinor, pkg.currency, true)}` : undefined}><Input id="st-price" inputMode="decimal" dir="ltr" className="text-end" value={price} onChange={e => setPrice(e.target.value)} /></Field>
      <Field label="تبدأ من" id="st-start"><Input id="st-start" type="date" value={startOn} onChange={e => setStartOn(e.target.value)} required /></Field>
      {client.subscriptions.some(x => x.packageId === pkgId && x.status !== 'ENDED') && <p role="note" className="rounded-[var(--radius-md)] border border-warning/40 bg-warning/5 p-3 text-sm">العميل ده عليه الباقة دي بالفعل. لو بدأتها تاني هيتحاسب عليها مرتين.</p>}
      <p className="rounded-[var(--radius-md)] bg-surface-2 p-3 text-sm">{startsToday ? 'أول فاتورة هتطلع دلوقتي' : `أول فاتورة هتطلع يوم ${day(startOn)}`}، وبعدها فاتورة {pkg ? PERIOD[pkg.months] : ''} لوحدها في نفس اليوم. العميل بيشوفها في البوابة مع طرق الدفع.</p>
      <ErrorText error={err} />
      <Button size="lg" disabled={busy}>ابدأ الباقة</Button>
    </form>
  );
}

function ClientBillingForm({ client, onSaved }: { client: BillingClient; onSaved: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try { await api(`/billing/clients/${client.id}`, { method: 'PUT', body: f }); onSaved(); } catch (e2) { setErr((e2 as Error).message); }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <p className="text-sm text-muted">ده اللي بيتكتب في خانة «إلى» على الفاتورة. لو العميل شركة ومحتاج فاتورة ضريبية، اكتب اسمها الرسمي ورقم تسجيلها الضريبي.</p>
      <Field label="الاسم الرسمي (اختياري)" id="cb-name"><Input id="cb-name" name="legalName" defaultValue={client.legalName ?? ''} placeholder={client.name} maxLength={160} /></Field>
      <Field label="رقم التسجيل الضريبي (اختياري)" id="cb-tax" hint="9 أرقام"><Input id="cb-tax" name="taxId" dir="ltr" inputMode="numeric" defaultValue={client.taxId ?? ''} maxLength={15} /></Field>
      <Field label="العنوان (اختياري)" id="cb-addr"><Input id="cb-addr" name="billingAddress" defaultValue={client.billingAddress ?? ''} maxLength={300} /></Field>
      <ErrorText error={err} />
      <Button size="lg">احفظ</Button>
    </form>
  );
}

function SubLine({ s, onChange }: { s: Subscription; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [price, setPrice] = useState(fromMinor(s.priceMinor));
  async function patch(body: object) {
    setErr(null);
    try { await api(`/billing/subscriptions/${s.id}`, { method: 'PATCH', body }); setEditing(false); onChange(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{s.name}</span>
        <Pill tone={s.status === 'ACTIVE' ? 'good' : 'warn'}>{s.status === 'ACTIVE' ? 'شغالة' : 'متوقفة مؤقتًا'}</Pill>
        <span className="ms-auto tabular-nums">{money(s.priceMinor, s.currency, true)} {PERIOD_SHORT[s.months]}</span>
      </div>
      <p className="text-sm text-muted">{s.status === 'ACTIVE' && s.nextInvoiceOn ? `الفاتورة الجاية ${day(s.nextInvoiceOn)}` : 'مفيش فواتير جديدة لحد ما ترجّعها'}</p>
      {editing ? (
        <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); const m = toMinor(price); if (m === null) setErr('اكتب السعر بالأرقام'); else void patch({ priceMinor: m }); }}>
          <Field label="السعر الجديد (من الفاتورة الجاية)" id={`sp-${s.id}`}><Input id={`sp-${s.id}`} inputMode="decimal" dir="ltr" className="text-end" value={price} onChange={e => setPrice(e.target.value)} autoFocus /></Field>
          <Button size="sm"><Check size={15} aria-hidden />احفظ</Button>
        </form>
      ) : ending ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">مفيش فواتير جديدة هتطلع للباقة دي تاني، والفواتير القديمة بتفضل زي ما هي. لو العميل هيرجع بعدين، «وقّفها مؤقتًا» أحسن.</p>
          <div className="flex gap-2"><Button variant="danger" onClick={() => patch({ status: 'ENDED' })}>أيوه، أنهيها</Button><Button variant="ghost" onClick={() => setEnding(false)}>رجوع</Button></div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden />غيّر السعر</Button>
          {s.status === 'ACTIVE'
            ? <Button variant="ghost" onClick={() => patch({ status: 'PAUSED' })}><Pause size={14} aria-hidden />وقّفها مؤقتًا</Button>
            : <Button variant="ghost" onClick={() => patch({ status: 'ACTIVE' })}><Play size={14} aria-hidden />رجّعها</Button>}
          <Button variant="ghost" className="text-danger" onClick={() => setEnding(true)}><Square size={14} aria-hidden />أنهي الباقة</Button>
        </div>
      )}
      <ErrorText error={err} />
    </div>
  );
}

export default function PackagesPage() {
  const { data: packages, mutate: mutatePk } = useSWR<Package[]>('/billing/packages', fetcher as never);
  const { data: clients, mutate: mutateCl } = useSWR<BillingClient[]>('/billing/clients', fetcher as never);
  const [editing, setEditing] = useState<Package | 'new' | null>(null);
  const [starting, setStarting] = useState<BillingClient | null>(null);
  const [details, setDetails] = useState<BillingClient | null>(null);
  // Monthly packages first, cheapest first; one-time extras after them.
  const live = packages?.filter(p => !p.archivedAt).sort((a, b) => Number(a.months === 0) - Number(b.months === 0)) ?? [];
  const archived = packages?.filter(p => p.archivedAt) ?? [];
  const refresh = () => { void mutatePk(); void mutateCl(); };
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archErr, setArchErr] = useState<string | null>(null);
  async function archive(p: Package, on: boolean) {
    setArchErr(null);
    try { await api(`/billing/packages/${p.id}/archive`, { body: { archived: on } }); setArchiving(null); refresh(); }
    catch (e) { setArchErr((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="الفواتير" sub="اعمل باقاتك مرة واحدة، وحط كل عميل على باقته. الفاتورة بتطلع لوحدها في ميعادها." action={<Button onClick={() => setEditing('new')}><Plus size={18} aria-hidden />باقة جديدة</Button>} />
      <BillingTabs />
      <div className="flex flex-col gap-8 p-8 max-md:p-4">
        <section aria-labelledby="pk-h" className="flex flex-col gap-3">
          <h2 id="pk-h" className="font-display text-xl font-bold">باقاتك</h2>
          <ErrorText error={archErr} />
          {packages && !live.length && <Empty title="لسه مفيش باقات">ضيف الباقات اللي بتبيعها لعملائك، زي «12 بوست + الرد على الرسايل» بسعر شهري.</Empty>}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4">
            {live.map(p => (
              <li key={p.id} className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
                <div>
                  <h3 className="text-lg font-semibold">{p.name}</h3>
                  {p.description && <p className="text-sm text-muted">{p.description}</p>}
                </div>
                <p className="font-display text-2xl font-bold tabular-nums">{money(p.priceMinor, p.currency, true)} <span className="text-base font-normal text-muted">{PERIOD_SHORT[p.months] || 'مرة واحدة'}</span></p>
                {!!p.features.length && <ul className="flex flex-col gap-1 text-sm">{p.features.map(f => <li key={f} className="flex items-start gap-2"><Check size={15} aria-hidden className="mt-0.5 shrink-0 text-success" />{f}</li>)}</ul>}
                <p className="mt-auto text-sm text-muted">{p.months === 0 ? 'بتتضاف كبند في فاتورة' : p.clients ? count(p.clients, 'عميل واحد عليها', 'عميلين عليها', 'عملاء عليها', 'عميل عليها') : 'مفيش عملاء عليها لسه'}</p>
                {archiving === p.id ? (
                  <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-2 p-3">
                    <p className="text-sm">مش هتظهر في الباقات الجديدة. العملاء اللي عليها هيفضلوا عليها بنفس السعر.</p>
                    <div className="flex gap-2"><Button size="sm" variant="danger" onClick={() => archive(p, true)}>أرشفها</Button><Button size="sm" variant="ghost" onClick={() => setArchiving(null)}>رجوع</Button></div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>عدّل</Button>
                    <Button size="sm" variant="ghost" onClick={() => setArchiving(p.id)}>أرشفها</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!!archived.length && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted">باقات متأرشفة ({nf.format(archived.length)})</summary>
              <ul className="mt-2 flex flex-col gap-1">{archived.map(p => <li key={p.id} className="flex items-center gap-2">{p.name}<button className="text-primary underline" onClick={() => archive(p, false)}>رجّعها</button></li>)}</ul>
            </details>
          )}
        </section>

        <section aria-labelledby="cl-h" className="flex flex-col gap-3">
          <h2 id="cl-h" className="font-display text-xl font-bold">العملاء وباقاتهم</h2>
          <ul className="grid gap-3 xl:grid-cols-2">
            {clients?.map(c => {
              const late = c.owed.filter(o => o.overdue > 0);
              return (
                <li key={c.id} className={cx('flex flex-col gap-3 rounded-[var(--radius-md)] border bg-surface p-4', late.length ? 'border-danger/40' : 'border-line')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{c.name}</h3>
                    {c.taxId && <Pill tone="info">فاتورة ضريبية</Pill>}
                    <span className={cx('ms-auto text-sm', late.length ? 'font-semibold text-danger' : 'text-muted')}>
                      {c.owed.some(o => o.minor > 0) ? `عليه ${c.owed.map(o => money(o.minor, o.currency, true)).join(' و')}${late.length ? `، منهم ${late.map(o => money(o.overdue, o.currency, true)).join(' و')} متأخر` : ''}` : 'مفيش عليه حاجة'}
                    </span>
                  </div>
                  {c.subscriptions.map(s => <SubLine key={s.id} s={s} onChange={refresh} />)}
                  {!c.subscriptions.length && <p className="text-sm text-muted">مش على باقة. الفواتير بتتعمل له يدوي.</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={c.subscriptions.length ? 'ghost' : 'primary'} onClick={() => setStarting(c)}><Plus size={14} aria-hidden />{c.subscriptions.length ? 'باقة كمان' : 'حطه على باقة'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDetails(c)}>بياناته على الفاتورة</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'باقة جديدة' : 'عدّل الباقة'}>
        {editing && <PackageForm p={editing === 'new' ? undefined : editing} onSaved={() => { setEditing(null); refresh(); }} />}
      </Modal>
      <Modal open={!!starting} onClose={() => setStarting(null)} title={`باقة ${starting?.name ?? ''}`}>
        {starting && packages && <StartForm client={starting} packages={packages} onSaved={() => { setStarting(null); refresh(); }} />}
      </Modal>
      <Modal open={!!details} onClose={() => setDetails(null)} title={`بيانات ${details?.name ?? ''} على الفاتورة`}>
        {details && <ClientBillingForm client={details} onSaved={() => { setDetails(null); refresh(); }} />}
      </Modal>
    </>
  );
}
