'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { ArrowRight, Printer } from 'lucide-react';
import { fetcher } from '@/lib/api';
import { money } from '@/lib/ads';
import type { Invoice, PayMethods } from '@/lib/billing';
import { InvoiceDocument, PayBox } from '@/components/invoice';
import { ReportPaid } from '@/components/portal-billing';
import { Button, ErrorText } from '@/components/ui';

export default function PortalInvoice() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate } = useSWR<{ invoice: Invoice; pay: PayMethods }>(`/portal/invoices/${id}`, fetcher as never);
  if (error && !data) return <ErrorText error={(error as Error).message} />;
  if (!data) return <p role="status" className="text-muted">بيحمّل…</p>;
  const inv = data.invoice;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href="/portal/billing" className="flex items-center gap-1 font-semibold text-primary"><ArrowRight size={16} aria-hidden />كل الفواتير</Link>
        <Button variant="ghost" onClick={() => window.print()}><Printer size={16} aria-hidden />اطبع أو احفظ PDF</Button>
      </div>
      <InvoiceDocument inv={inv} client />
      {inv.status === 'ISSUED' && (
        <section aria-labelledby="pay-h" className="flex flex-col gap-3 print:hidden">
          <h2 id="pay-h" className="font-display text-xl font-bold">تدفع إزاي</h2>
          {!inv.pendingPayments && <PayBox pay={data.pay} amount={money(inv.totalMinor - inv.paidMinor, inv.currency, true)} />}
          <ReportPaid inv={inv} pay={data.pay} onDone={x => mutate({ ...data, invoice: x }, { revalidate: false })} />
        </section>
      )}
    </div>
  );
}
