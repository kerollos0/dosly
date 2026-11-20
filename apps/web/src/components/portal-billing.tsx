'use client';
import { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { fromMinor, lastReportRejected, PAYMENT_METHOD, toMinor, type Invoice, type PayMethods, type PaymentMethod } from '@/lib/billing';
import { Button, ErrorText, Field, Input, Select } from './ui';

/** The methods a client can say they used: the ones the agency listed, plus "other". Cash is settled in person. */
function methodsFor(pay: PayMethods): PaymentMethod[] {
  const m: PaymentMethod[] = [];
  if (pay.instapay || pay.instapayLink) m.push('INSTAPAY');
  if (pay.wallet) m.push('WALLET');
  if (pay.iban) m.push('BANK');
  if (pay.paypalLink) m.push('PAYPAL');
  return [...m, 'OTHER'];
}

/**
 * "أنا دفعت": after transferring, the client tells the agency with the transfer reference, so the agency
 * can match it in its bank or wallet. It counts once the agency confirms.
 */
export function ReportPaid({ inv, pay, onDone }: { inv: Invoice; pay: PayMethods; onDone: (inv: Invoice) => void }) {
  const methods = methodsFor(pay);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>(methods[0]!);
  const [reference, setReference] = useState('');
  const left = inv.totalMinor - inv.paidMinor;
  const [amount, setAmount] = useState(fromMinor(left));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (inv.status !== 'ISSUED') return null;
  if (inv.pendingPayments) return <p className="flex items-start gap-2 rounded-[var(--radius-md)] bg-sun/15 p-3 text-sm"><Check size={18} aria-hidden className="mt-0.5 shrink-0" />وصلنا إنك دفعت. الوكالة بتتأكد إن الفلوس وصلت، وهتلاقي الفاتورة «اتدفعت» هنا أول ما يأكدوا.</p>;
  const rejected = lastReportRejected(inv) && (
    <p role="status" className="flex items-start gap-2 rounded-[var(--radius-md)] bg-danger/10 p-3 text-sm"><AlertTriangle size={18} aria-hidden className="mt-0.5 shrink-0 text-danger" />الوكالة راجعت آخر تحويل بلّغت عنه وملقتش الفلوس. اتأكد من التحويل وبلّغ تاني، أو كلّم الوكالة.</p>
  );
  if (!open) return <div className="flex flex-col gap-2">{rejected}<Button size="lg" className="self-start max-sm:self-stretch" onClick={() => setOpen(true)}>أنا حوّلت الفلوس</Button></div>;
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const m = toMinor(amount);
    if (!m || m > left) { setErr(`اكتب المبلغ اللي حوّلته بالأرقام (لحد ${fromMinor(left)})`); return; }
    setBusy(true); setErr(null);
    try { const r = await api<{ invoice: Invoice }>(`/portal/invoices/${inv.id}/paid`, { body: { method, amountMinor: m, reference: reference.trim() || undefined } }); setOpen(false); onDone(r.invoice); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={send} className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line bg-surface-2 p-3">
      <Field label="حوّلت بإيه؟" id={`m-${inv.id}`}>
        <Select id={`m-${inv.id}`} value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} className="h-11 text-base">{methods.map(m => <option key={m} value={m}>{PAYMENT_METHOD[m]}</option>)}</Select>
      </Field>
      <Field label="حوّلت كام؟" id={`a-${inv.id}`}>
        <Input id={`a-${inv.id}`} value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" dir="ltr" className="h-11 text-end text-base" />
      </Field>
      <Field label="رقم العملية أو الرقم اللي حوّلت منه (اختياري)" id={`r-${inv.id}`} hint="بيساعد الوكالة تلاقي تحويلك بسرعة">
        <Input id={`r-${inv.id}`} value={reference} onChange={e => setReference(e.target.value)} maxLength={120} dir="ltr" className="h-11 text-base" />
      </Field>
      <ErrorText error={err} />
      <div className="grid grid-cols-2 gap-2"><Button size="lg" disabled={busy}>ابعت للوكالة</Button><Button size="lg" type="button" variant="ghost" onClick={() => setOpen(false)}>رجوع</Button></div>
    </form>
  );
}
