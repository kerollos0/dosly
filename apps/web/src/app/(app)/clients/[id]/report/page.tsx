'use client';
import Link from 'next/link';
import { use } from 'react';
import useSWR from 'swr';
import { fetcher, type Client } from '@/lib/api';
import { PageHeader } from '@/components/ui';
import { MonthlyReport } from '@/components/report';

export default function ClientReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const client = clients?.find(c => c.id === id);
  return (
    <>
      <PageHeader title={client ? `تقرير ${client.name}` : 'التقرير'} sub="نفس الأرقام اللي العميل بيشوفها في البوابة." action={<Link href="/clients" className="text-sm font-semibold text-faience-ink">رجوع للعملاء</Link>} />
      <div className="p-8 max-md:p-4"><MonthlyReport path={`/clients/${id}/report`} title="الأرقام" /></div>
    </>
  );
}
