'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Check, Copy } from 'lucide-react';
import { api, fetcher, type Client } from '@/lib/api';
import { STORE_KIND, type Store } from '@/lib/orders';
import { ago } from '@/lib/when';
import { Button, ErrorText, Field, Input, Pill, Select } from './ui';

const WAITS = [30, 60, 120, 240, 480];
const waitLabel = (m: number) => (m < 60 ? `${m} دقيقة` : m === 60 ? 'ساعة' : m === 120 ? 'ساعتين' : `${m / 60} ساعات`);

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} dir="ltr" aria-label={label} className="num text-sm" onFocus={e => e.currentTarget.select()} />
      <Button type="button" size="sm" variant="ghost" className="h-10 shrink-0" onClick={async () => { await navigator.clipboard.writeText(value).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 2000); }}>
        {done ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}{done ? 'اتنسخ' : 'انسخ'}
      </Button>
    </div>
  );
}

/** Where the owner pastes our link, in their store's own words. */
function Steps({ kind }: { kind: Store['kind'] }) {
  return kind === 'EASYORDERS' ? (
    <ol className="list-decimal ps-5 text-sm text-muted">
      <li>في لوحة EasyOrders افتح <b>Public API</b> وبعدين <b>Webhooks</b> و<b>Create Webhook</b>.</li>
      <li>الصق اللينك اللي فوق واحفظ.</li>
      <li>EasyOrders هيديك <b>secret</b>: انسخه وحطه في خانة السر هنا.</li>
    </ol>
  ) : (
    <ol className="list-decimal ps-5 text-sm text-muted">
      <li>من تطبيق المتجر في Shopify (Dev Dashboard) ضيف Webhooks للمواضيع: <span dir="ltr">orders/create, orders/updated, fulfillments/create, fulfillments/update</span>.</li>
      <li>الصق اللينك اللي فوق كعنوان الـ webhook بصيغة JSON.</li>
      <li>حط <b>Client secret</b> بتاع التطبيق في خانة السر هنا، عشان نتأكد إن الطلبات جاية من Shopify فعلًا.</li>
    </ol>
  );
}

function StoreRow({ s, onChange, onRemove }: { s: Store; onChange: (s: Store) => void; onRemove: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const save = async (patch: Partial<Store> & { secret?: string }) => {
    setErr(null); setSaving(true);
    try { onChange(await api<Store>(`/stores/${s.id}`, { method: 'PATCH', body: patch })); return true; } catch (e) { setErr((e as Error).message); return false; } finally { setSaving(false); }
  };
  const number = s.numbers.find(n => n.id === s.waNumberId) ?? s.numbers.find(n => n.status === 'CONNECTED');
  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <b>{s.name}</b><Pill tone="info">{STORE_KIND[s.kind]}</Pill><span className="text-muted">· {s.clientName}</span>
        <span className="ms-auto flex items-center gap-2">
          <Pill tone={s.lastError ? 'bad' : s.lastOrderAt ? 'good' : 'warn'}>{s.lastError ? 'فيه مشكلة' : s.lastOrderAt ? `آخر طلب ${ago(s.lastOrderAt)}` : 'مستني أول طلب'}</Pill>
          {asking
            ? <><span className="text-sm text-danger">هيتمسح المتجر وكل طلباته من دوسلي.</span><Button size="sm" variant="danger" onClick={onRemove}>افصله</Button><Button size="sm" variant="ghost" onClick={() => setAsking(false)}>لأ</Button></>
            : <Button size="sm" variant="ghost" onClick={() => setAsking(true)} aria-label={`فصل ${s.name}`}>فصل</Button>}
        </span>
      </div>
      {s.lastError && <p className="text-sm text-danger">{s.lastError}</p>}
      <Field label="لينك استقبال الطلبات (Webhook URL)"><CopyField value={s.webhookUrl} label="لينك استقبال الطلبات" /></Field>
      <details className="text-sm"><summary className="cursor-pointer font-semibold text-primary">إزاي أحطه في المتجر؟</summary><div className="mt-2"><Steps kind={s.kind} /></div></details>
      <form className="flex flex-wrap items-end gap-2" onSubmit={async e => { e.preventDefault(); if (await save({ secret })) setSecret(''); }}>
        <div className="min-w-56 flex-1">
          <Field label={s.hasSecret ? 'السر (secret) محفوظ. لو اتغير حط الجديد' : 'السر (secret) اللي المتجر اداهولك'} id={`sec-${s.id}`}>
            <Input id={`sec-${s.id}`} type="password" dir="ltr" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)} minLength={8} required />
          </Field>
        </div>
        <Button size="sm" variant="ghost" className="h-10">حفظ السر</Button>
      </form>
      <fieldset disabled={saving} className="flex flex-col gap-3 rounded-[var(--radius-sm)] bg-surface-2 p-3">
        <legend className="sr-only">تأكيد الطلبات على واتساب</legend>
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" checked={s.autoConfirm} onChange={e => save({ autoConfirm: e.target.checked })} className="size-4" />
          ابعت تأكيد على واتساب لكل طلب دفع عند الاستلام
        </label>
        {s.autoConfirm && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="من رقم" id={`num-${s.id}`}>
              <Select id={`num-${s.id}`} value={s.waNumberId ?? ''} onChange={e => save({ waNumberId: e.target.value || null, confirmTemplate: null })}>
                <option value="">أول رقم شغال للعميل</option>
                {s.numbers.map(n => <option key={n.id} value={n.id}>{n.displayPhone}</option>)}
              </Select>
            </Field>
            <Field label="قالب الرسالة" id={`tpl-${s.id}`}>
              <Select id={`tpl-${s.id}`} value={s.confirmTemplate ?? ''} onChange={e => save({ confirmTemplate: e.target.value || null })}>
                <option value="">اختار لوحدك</option>
                {number?.templates.map(t => <option key={t} value={t} dir="ltr">{t}</option>)}
              </Select>
            </Field>
            <Field label="لو العميل مردش خلال" id={`wait-${s.id}`}>
              <Select id={`wait-${s.id}`} value={s.confirmWaitMin} onChange={e => save({ confirmWaitMin: Number(e.target.value) })}>
                {[...new Set([...WAITS, s.confirmWaitMin])].sort((a, b) => a - b).map(m => <option key={m} value={m}>{waitLabel(m)}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {s.autoConfirm && (s.usingTemplate
          ? <p className="text-sm text-muted">هيتبعت قالب <b dir="ltr">{s.usingTemplate}</b> فيه زرار «تأكيد» وزرار «إلغاء». اللي ميردش هيظهر للمودريتور في صفحة الطلبات عشان يكلمه.</p>
          : <p className="text-sm text-warning">{number ? 'مفيش قالب متوافق عليه من ميتا ينفع للتأكيد على الرقم ده. اعمل قالب «خدمي» (Utility) فيه 3 متغيرات بالترتيب: اسم العميل، رقم الطلب، الإجمالي، وزرارين رد سريع: تأكيد ثم إلغاء.' : 'العميل ده ملوش رقم واتساب مربوط، فالطلبات هتظهر للمودريتور يكلمها بنفسه.'}</p>)}
      </fieldset>
      <ErrorText error={err} />
    </li>
  );
}

/** Store connections on the channels page: connect, copy the link into the store, settings for WhatsApp confirmations. */
export function StoresSection({ clients }: { clients?: Client[] }) {
  const { data: stores, mutate } = useSWR<Store[]>('/stores', fetcher as never);
  const [kind, setKind] = useState<Store['kind']>('EASYORDERS');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (!body.secret) delete body.secret;
    setBusy(true); setErr(null);
    try { await api('/stores', { body: { ...body, kind } }); form.reset(); await mutate(); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await api(`/stores/${id}`, { method: 'DELETE' }); await mutate(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <section id="stores" aria-labelledby="stores-h" className="flex scroll-mt-4 flex-col gap-4 lg:col-span-2">
      <h2 id="stores-h" className="font-display text-[22px] font-semibold">المتاجر (EasyOrders و Shopify)</h2>
      <p className="text-sm text-muted">كل طلب بيوصلنا لحظة ما يتعمل: بنبعت للعميل تأكيد على واتساب، ونحسب المبيعات الحقيقية جنب صرف الإعلانات، وبتشوف طلبات العميل جنب محادثته.</p>
      <ul className="flex flex-col gap-3">
        {stores?.map(s => <StoreRow key={s.id} s={s} onChange={n => mutate(list => list?.map(x => (x.id === n.id ? n : x)), { revalidate: false })} onRemove={() => remove(s.id)} />)}
      </ul>
      <form onSubmit={connect} className="grid gap-4 rounded-[var(--radius-md)] bg-surface-2 p-4 lg:grid-cols-3">
        <h3 className="font-semibold lg:col-span-3">ربط متجر</h3>
        <Field label="العميل" id="st-client">
          <Select id="st-client" name="clientId" required defaultValue=""><option value="" disabled>اختار العميل</option>{clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
        <Field label="المتجر على" id="st-kind">
          <Select id="st-kind" value={kind} onChange={e => setKind(e.target.value as Store['kind'])}><option value="EASYORDERS">EasyOrders</option><option value="SHOPIFY">Shopify</option></Select>
        </Field>
        <Field label="اسم المتجر" id="st-name" hint={kind === 'SHOPIFY' ? 'مثلًا lamsa.myshopify.com' : 'الاسم اللي هيظهر للفريق'}><Input id="st-name" name="name" required maxLength={120} /></Field>
        <div className="lg:col-span-3">
          <Field label="السر (secret)" id="st-secret" hint="ممكن تسيبه فاضي دلوقتي: هنديك لينك تحطه في المتجر، وبعدها تحط السر اللي المتجر هيديهولك.">
            <Input id="st-secret" name="secret" type="password" dir="ltr" autoComplete="off" minLength={8} />
          </Field>
        </div>
        <div className="flex flex-col gap-2 lg:col-span-3"><ErrorText error={err} /><Button disabled={busy} className="self-start">اربط المتجر</Button></div>
      </form>
    </section>
  );
}
