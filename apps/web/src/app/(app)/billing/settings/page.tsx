'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Check } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import type { BillingSettings } from '@/lib/billing';
import { BillingTabs } from '@/components/billing';
import { PayBox } from '@/components/invoice';
import { Button, ErrorText, Field, Input, PageHeader, Textarea } from '@/components/ui';

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-5 max-sm:p-4">
      <legend className="px-1 font-display text-lg font-bold">{title}</legend>
      {sub && <p className="-mt-2 text-sm text-muted">{sub}</p>}
      {children}
    </fieldset>
  );
}

const TEXT_FIELDS = ['legalName', 'taxId', 'commercialReg', 'address', 'phone', 'invoicePrefix', 'instapay', 'instapayLink', 'wallet', 'walletName', 'bankName', 'bankAccountName', 'iban', 'paypalLink', 'payNote'] as const;

/** Who issues the invoices, VAT, and how clients pay. What clients will see is previewed on the side. */
export default function BillingSettingsPage() {
  const { data: s, mutate } = useSWR<BillingSettings>('/billing/settings', fetcher as never);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BillingSettings | null>(null);
  if (!s) return <p role="status" className="p-8 text-muted">بيحمّل…</p>;
  const shown = preview ?? s;

  function read(form: HTMLFormElement) {
    const f = new FormData(form);
    const body: Record<string, unknown> = {};
    for (const k of TEXT_FIELDS) body[k] = String(f.get(k) ?? '').trim();
    if (!body.invoicePrefix) delete body.invoicePrefix; // empty keeps the current prefix
    body.vatRegistered = f.get('vatRegistered') === 'on';
    body.autoIssue = f.get('autoIssue') === 'on';
    body.dueDays = Number(f.get('dueDays') || 7);
    return body;
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(null); setSaved(false);
    try { await mutate(await api<BillingSettings>('/billing/settings', { method: 'PUT', body: read(e.currentTarget) }), { revalidate: false }); setSaved(true); setPreview(null); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="الفواتير" sub="البيانات اللي بتتكتب على فواتيرك، وإزاي عملاءك يدفعولك." />
      <BillingTabs />
      <div className="grid items-start gap-6 p-8 max-md:p-4 lg:grid-cols-[1fr_360px]">
        <form onSubmit={save} onChange={e => setPreview({ ...s, ...(read(e.currentTarget) as Partial<BillingSettings>) })} className="flex flex-col gap-6">
          <Section title="طرق الدفع" sub="دي اللي العميل بيشوفها تحت كل فاتورة، وكل رقم جنبه زرار نسخ.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="عنوان InstaPay أو رقمه" id="b-ipa" hint="زي noon@instapay"><Input id="b-ipa" name="instapay" dir="ltr" defaultValue={s.instapay ?? ''} /></Field>
              <Field label="لينك InstaPay (اختياري)" id="b-ipl" hint="من التطبيق: شارك عنوانك، وانسخ اللينك اللي بيبدأ بـ https://ipn.eg"><Input id="b-ipl" name="instapayLink" dir="ltr" defaultValue={s.instapayLink ?? ''} placeholder="https://ipn.eg/S/..." /></Field>
              <Field label="رقم المحفظة (فودافون كاش وغيرها)" id="b-w"><Input id="b-w" name="wallet" dir="ltr" inputMode="tel" defaultValue={s.wallet ?? ''} placeholder="010..." /></Field>
              <Field label="المحفظة باسم مين" id="b-wn" hint="عشان العميل يتأكد قبل ما يحوّل"><Input id="b-wn" name="walletName" defaultValue={s.walletName ?? ''} /></Field>
              <Field label="البنك (اختياري)" id="b-bank"><Input id="b-bank" name="bankName" defaultValue={s.bankName ?? ''} placeholder="البنك الأهلي المصري" /></Field>
              <Field label="اسم صاحب الحساب" id="b-ban"><Input id="b-ban" name="bankAccountName" defaultValue={s.bankAccountName ?? ''} /></Field>
              <Field label="IBAN" id="b-iban" hint="بيبدأ بـ EG وبعده 27 رقم"><Input id="b-iban" name="iban" dir="ltr" defaultValue={s.iban ?? ''} /></Field>
              <Field label="لينك PayPal (للعملاء اللي بره مصر)" id="b-pp"><Input id="b-pp" name="paypalLink" dir="ltr" defaultValue={s.paypalLink ?? ''} placeholder="https://paypal.me/..." /></Field>
            </div>
            <Field label="ملحوظة تحت طرق الدفع (اختياري)" id="b-note"><Textarea id="b-note" name="payNote" rows={2} defaultValue={s.payNote ?? ''} maxLength={500} placeholder='مثلًا: هنأكدلك وصول الفلوس خلال يوم عمل' /></Field>
          </Section>

          <Section title="بيانات الوكالة على الفاتورة" sub="بتتكتب في خانة «من». لو سبت الاسم فاضي هيتكتب اسم الوكالة.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="الاسم الرسمي" id="b-ln"><Input id="b-ln" name="legalName" defaultValue={s.legalName ?? ''} placeholder="مثلًا: نون للتسويق الرقمي ش.ذ.م.م" /></Field>
              <Field label="رقم التسجيل الضريبي" id="b-tax" hint="9 أرقام"><Input id="b-tax" name="taxId" dir="ltr" inputMode="numeric" defaultValue={s.taxId ?? ''} /></Field>
              <Field label="رقم السجل التجاري" id="b-cr"><Input id="b-cr" name="commercialReg" dir="ltr" defaultValue={s.commercialReg ?? ''} /></Field>
              <Field label="تليفون" id="b-ph"><Input id="b-ph" name="phone" dir="ltr" defaultValue={s.phone ?? ''} /></Field>
            </div>
            <Field label="العنوان" id="b-ad"><Input id="b-ad" name="address" defaultValue={s.address ?? ''} /></Field>
          </Section>

          <Section title="الضريبة والترقيم">
            <label className="flex items-start gap-2">
              <input type="checkbox" name="vatRegistered" defaultChecked={s.vatRegistered} className="mt-1" />
              <span><span className="font-semibold">الوكالة مسجلة في ضريبة القيمة المضافة</span><span className="block text-sm text-muted">هتتضاف {s.vatRateBp / 100}% على الفواتير الجديدة. التسجيل إجباري لو مبيعاتك في السنة عدّت 500 ألف جنيه. ولو مسجّل، لازم تسجل فواتير الشركات على منظومة الفاتورة الإلكترونية، ومبيعات الأفراد على منظومة الإيصال الإلكتروني حسب مرحلتك، وتلصق رقم الفاتورة (UUID) على فاتورتها في دوسلي. (الربط المباشر بالمنظومة مرحلة جاية.)</span></span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="أول الرقم" id="b-pre" hint={`الفاتورة الجاية: ${shown.invoicePrefix || 'INV'}-${new Date().getFullYear()}-${String(s.nextNumber).padStart(4, '0')}`}><Input id="b-pre" name="invoicePrefix" dir="ltr" defaultValue={s.invoicePrefix} maxLength={8} /></Field>
              <Field label="العميل يدفع خلال كام يوم" id="b-due"><Input id="b-due" name="dueDays" type="number" min={0} max={90} defaultValue={s.dueDays} /></Field>
            </div>
            <label className="flex items-start gap-2">
              <input type="checkbox" name="autoIssue" defaultChecked={s.autoIssue} className="mt-1" />
              <span><span className="font-semibold">فواتير الباقات تتبعت للعميل لوحدها</span><span className="block text-sm text-muted">لو شلت العلامة، فاتورة كل شهر هتستناك كمسودة تراجعها وتبعتها إنت.</span></span>
            </label>
          </Section>

          <ErrorText error={err} />
          {saved && <p role="status" className="flex items-center gap-2 font-semibold text-success"><Check size={18} aria-hidden />اتحفظ</p>}
          <Button size="lg" disabled={busy} className="self-start">احفظ</Button>
        </form>

        <aside aria-label="العميل هيشوف كده" className="sticky top-4 flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface-2 p-4">
          <h2 className="font-semibold">العميل هيشوف كده</h2>
          <PayBox pay={shown} amount="المبلغ" />
        </aside>
      </div>
    </>
  );
}
