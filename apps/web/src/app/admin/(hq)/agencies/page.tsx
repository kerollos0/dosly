'use client';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { Input, PageHeader, Pill } from '@/components/ui';
import { PLAN_LABEL, planPill } from '@/lib/admin';

type Row = { id: string; name: string; plan: string; status: string; trialEndsAt: string | null; paidUntil: string | null; createdAt: string; owner: { name: string; email: string } | null; clients: number; members: number };

export default function AdminAgencies() {
  const [q, setQ] = useState('');
  const { data } = useSWR<{ items: Row[] }>(`/admin/agencies?q=${encodeURIComponent(q)}`, fetcher as never);
  return (
    <>
      <PageHeader title="الوكالات" action={<Input type="search" placeholder="دوّر بالاسم أو إيميل صاحب الوكالة" value={q} onChange={e => setQ(e.target.value)} className="w-80 max-sm:w-full" aria-label="بحث" />} />
      <div className="overflow-x-auto p-8 max-md:p-4">
        <table className="w-full min-w-[720px] text-start">
          <thead className="border-b border-line text-sm text-muted"><tr><th className="py-2 text-start font-medium">الوكالة</th><th className="text-start font-medium">صاحبها</th><th className="text-start font-medium">الباقة</th><th className="text-start font-medium">لحد</th><th className="text-start font-medium">العملاء</th><th className="text-start font-medium">الفريق</th></tr></thead>
          <tbody className="divide-y divide-line">
            {data?.items.map(a => (
              <tr key={a.id} className="hover:bg-surface-2">
                <td className="py-3"><Link href={`/admin/agencies/${a.id}`} className="font-semibold text-faience-ink">{a.name}</Link>{a.status === 'SUSPENDED' && <> <Pill tone="bad">موقوفة</Pill></>}</td>
                <td className="text-sm">{a.owner?.name}<br /><span className="text-muted" dir="ltr">{a.owner?.email.includes('.invalid') ? '' : a.owner?.email}</span></td>
                <td><Pill tone={planPill(a.plan)}>{PLAN_LABEL[a.plan]}</Pill></td>
                <td className="num text-sm">{(a.plan === 'TRIAL' ? a.trialEndsAt : a.paidUntil)?.slice(0, 10) ?? '—'}</td>
                <td className="num">{a.clients}</td>
                <td className="num">{a.members}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.items.length === 0 && <p className="py-8 text-center text-muted">مفيش نتايج</p>}
      </div>
    </>
  );
}
