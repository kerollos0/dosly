'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { ArrowRight, Eye, Printer, Send } from 'lucide-react';
import { api, fetcher, type Client } from '@/lib/api';
import { money } from '@/lib/ads';
import { day, fromMinor, PAYMENT_METHOD, toMinor, type BillingClient, type BillingSettings, type Invoice, type Package, type PaymentMethod } from '@/lib/billing';
import { dueWords, InvoiceEditor, PendingPayment } from '@/components/billing';
import { InvoiceDocument } from '@/components/invoice';
import { Button, ErrorText, Field, Input, Modal, Select } from '@/components/ui';
import { ago, cairoDayKey } from '@/lib/when';
import { useLiveRefresh } from '@/lib/realtime';

const METHODS: PaymentMethod[] = ['INSTAPAY', 'WALLET', 'BANK', 'CASH', 'PAYPAL', 'OTHER'];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4"><h2 className="font-semibold">{title}</h2>{children}</section>;
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: inv, error, mutate } = useSWR<Invoice>(`/billing/invoices/${id}`, fetcher as never);
  const { data: settings } = useSWR<BillingSettings>('/billing/settings', fetcher as never);
  const { data: bclients } = useSWR<BillingClient[]>(inv?.status === 'DRAFT' ? '/billing/clients' : null, fetcher as never);
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const { data: packages } = useSWR<Package[]>('/billing/packages', fetcher as never);
  useLiveRefresh('invoice.', () => mutate());
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('INSTAPAY');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [reason, setReason] = useState('');
  const [eta, setEta] = useState<string | null>(null);
  const today = cairoDayKey(new Date());

  if (error && !inv) return <p className="p-8"><ErrorText error={(error as Error).message} /></p>;
  if (!inv) return <p role="status" className="p-8 text-muted">بيحمّل…</p>;
  const left = inv.totalMinor - inv.paidMinor;
  const bc = bclients?.find(c => c.id === inv.clientId);

  async function run(path: string, body?: unknown, method = 'POST') {
    setBusy(true); setErr(null);
    try { const out = await api<Invoice>(path, { method, body }); await mutate(out, { revalidate: false }); return out; }
    catch (e) { setErr((e as Error).message); return null; } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api(`/billing/invoices/${inv!.id}`, { method: 'DELETE' }); router.replace('/billing'); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-8 max-md:p-4 print:p-0">
      <Link href="/billing" className="flex items-center gap-1 self-start text-sm font-semibold text-primary print:hidden"><ArrowRight size={16} aria-hidden />كل الفواتير</Link>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px] print:block">
        <InvoiceDocument inv={inv}
          seller={settings ? { name: settings.legalName ?? '', taxId: settings.taxId, commercialReg: settings.commercialReg, address: settings.address, phone: settings.phone, vatRegistered: settings.vatRegistered } : null}
          buyer={bc ? { name: bc.legalName ?? bc.name, displayName: bc.name, taxId: bc.taxId, address: bc.billingAddress } : null} />

        <aside aria-label="اللي تقدر تعمله" className="flex flex-col gap-4 print:hidden">
          <ErrorText error={err} />
          {inv.status === 'DRAFT' && (
            <Card title="المسودة دي لسه عندك">
              <p className="text-sm text-muted">العميل مش شايفها. لما تبعتها هتاخد رقم وتظهر له في البوابة مع طرق الدفع.</p>
              <Button size="lg" disabled={busy} onClick={() => run(`/billing/invoices/${inv.id}/issue`)}><Send size={18} aria-hidden />ابعتها للعميل</Button>
              {deleting ? (
                <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-2 p-3">
                  <p className="text-sm">المسودة هتتمسح خالص. متأكد؟</p>
                  <div className="grid grid-cols-2 gap-2"><Button variant="danger" disabled={busy} onClick={remove}>أيوه، امسحها</Button><Button variant="ghost" onClick={() => setDeleting(false)}>رجوع</Button></div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="ghost" onClick={() => setEditing(true)}>عدّل</Button>
                  <Button variant="danger" onClick={() => setDeleting(true)}>امسحها</Button>
                </div>
              )}
            </Card>
          )}

          {inv.status === 'ISSUED' && (
            <>
              <Card title={left < inv.totalMinor ? `فاضل ${money(left, inv.currency)}` : `مستنية ${money(left, inv.currency)}`}>
                <p className={inv.overdue ? 'font-semibold text-danger' : 'text-sm text-muted'}>{dueWords(inv, today)}</p>
                <p className="flex items-center gap-1 text-sm text-muted"><Eye size={15} aria-hidden />{inv.viewedAt ? `العميل فتحها ${ago(inv.viewedAt)}` : 'العميل لسه مفتحهاش في البوابة'}</p>
                {inv.payments.filter(p => p.state === 'PENDING').map(p => <PendingPayment key={p.id} p={p} currency={inv.currency} onDone={x => mutate(x, { revalidate: false })} />)}
              </Card>
              <Card title="سجّل دفعة وصلتك">
                <form className="flex flex-col gap-3" onSubmit={async e => {
                  e.preventDefault();
                  const m = amount ? toMinor(amount) : left;
                  if (!m) { setErr('اكتب المبلغ بالأرقام'); return; }
                  const out = await run(`/billing/invoices/${inv.id}/payments`, { amountMinor: m, method, reference: reference.trim() || null, ...(paidOn && { paidOn }) });
                  if (out) { setAmount(''); setReference(''); }
                }}>
                  <Field label="المبلغ" id="pay-amount" hint={`لو سبته فاضي هيتسجل الباقي كله (${fromMinor(left)})`}><Input id="pay-amount" inputMode="decimal" dir="ltr" className="text-end" value={amount} onChange={e => setAmount(e.target.value)} placeholder={fromMinor(left)} /></Field>
                  <Field label="اتدفع إزاي" id="pay-method"><Select id="pay-method" value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}>{METHODS.map(m => <option key={m} value={m}>{PAYMENT_METHOD[m]}</option>)}</Select></Field>
                  <Field label="رقم العملية (اختياري)" id="pay-ref"><Input id="pay-ref" value={reference} onChange={e => setReference(e.target.value)} maxLength={120} /></Field>
                  <Field label="يوم الدفع" id="pay-day"><Input id="pay-day" type="date" max={today} value={paidOn} onChange={e => setPaidOn(e.target.value)} /></Field>
                  <Button disabled={busy}>سجّل الدفعة</Button>
                </form>
              </Card>
            </>
          )}

          {inv.status !== 'DRAFT' && (
            <Card title="الفاتورة">
              <Button variant="ghost" onClick={() => window.print()}><Printer size={16} aria-hidden />اطبعها أو احفظها PDF</Button>
              {inv.status === 'PAID' && inv.paidAt && <p className="text-sm text-success">اتدفعت بالكامل {day(inv.paidAt.slice(0, 10))}.</p>}
              {inv.status !== 'VOID' && (
                <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void run(`/billing/invoices/${inv.id}`, { etaUuid: (eta ?? inv.etaUuid ?? '').trim() || null }, 'PATCH'); }}>
                  <Field label="رقم الفاتورة الإلكترونية (اختياري)" id="eta" hint={settings?.vatRegistered ? 'لو مسجّل في الضرايب لازم الفاتورة تتسجل كمان على منظومة الفاتورة الإلكترونية. سجّلها هناك والصق الـ UUID هنا عشان يظهر للعميل.' : 'لو بتسجل فواتيرك على منظومة الفاتورة الإلكترونية، الصق الـ UUID هنا.'}>
                    <Input id="eta" dir="ltr" value={eta ?? inv.etaUuid ?? ''} onChange={e => setEta(e.target.value)} maxLength={500} placeholder="الـ UUID أو لينك المشاركة" />
                  </Field>
                  <Button size="sm" variant="ghost" disabled={busy}>احفظ</Button>
                </form>
              )}
              {inv.status === 'ISSUED' && !inv.paidMinor && (
                voiding ? (
                  <form className="flex flex-col gap-2" onSubmit={async e => { e.preventDefault(); if (await run(`/billing/invoices/${inv.id}/void`, { reason })) setVoiding(false); }}>
                    <Field label="ليه هتلغيها؟" id="void-reason"><Input id="void-reason" value={reason} onChange={e => setReason(e.target.value)} required minLength={2} maxLength={300} autoFocus /></Field>
                    <p className="text-xs text-muted">الفاتورة هتفضل برقمها وتظهر للعميل إنها اتلغت ومش مطلوب دفعها.</p>
                    <div className="grid grid-cols-2 gap-2"><Button variant="danger" disabled={busy}>ألغيها</Button><Button type="button" variant="ghost" onClick={() => setVoiding(false)}>رجوع</Button></div>
                  </form>
                ) : <Button variant="ghost" className="text-danger" onClick={() => setVoiding(true)}>ألغي الفاتورة</Button>
              )}
              {inv.status === 'ISSUED' && inv.paidMinor > 0 && <p className="text-xs text-muted">مينفعش تلغيها بعد ما اتدفع جزء منها. لو فيها غلط، اعمل فاتورة جديدة بالفرق أو كلّم العميل.</p>}
            </Card>
          )}
        </aside>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="عدّل المسودة">
        {editing && clients && settings && (
          <InvoiceEditor inv={inv} clients={clients} packages={packages ?? []} vatRateBp={settings.vatRateBp} vatDefault={settings.vatRegistered}
            onSaved={x => { setEditing(false); void mutate(x, { revalidate: true }); }} />
        )}
      </Modal>
    </div>
  );
}
