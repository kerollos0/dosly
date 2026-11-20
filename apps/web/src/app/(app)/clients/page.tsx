'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { api, can, fetcher, type Client, type Member } from '@/lib/api';
import { useMe } from '@/lib/me';
import Link from 'next/link';
import { Button, Empty, ErrorText, Field, Input, Modal, PageHeader, Pill, Textarea } from '@/components/ui';
import { PortalPanel } from '@/components/portal-panel';

export default function ClientsPage() {
  const me = useMe();
  const { data: clients, mutate } = useSWR<Client[]>('/clients', fetcher as never);
  const { data: team } = useSWR<{ members: Member[] }>('/team', fetcher as never);
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState<Client | null>(null);
  const [portal, setPortal] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = can.manage(me.role);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try { await api('/clients', { body: f }); setAdding(false); setError(null); await mutate(); } catch (err) { setError((err as Error).message); }
  }
  async function saveAssignments(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const userIds = new FormData(e.currentTarget).getAll('userIds') as string[];
    try { await api(`/clients/${assigning!.id}/assignments`, { method: 'PUT', body: { userIds } }); setAssigning(null); await mutate(); } catch (err) { setError((err as Error).message); }
  }
  const nameOf = (id: string) => team?.members.find(m => m.id === id)?.name;

  return (
    <>
      <PageHeader title="العملاء" sub="كل عميل ليه أرقام واتساب وصفحات، وفريق متعين عليه." action={manage && <Button onClick={() => setAdding(true)}>إضافة عميل</Button>} />
      {clients?.length === 0 && <Empty title="ضيف أول عميل">بعد ما تضيفه، اربط رقم الواتساب وصفحة الفيسبوك بتوعه من صفحة القنوات.</Empty>}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-6 p-8 max-md:p-4">
        {clients?.map(c => (
          <li key={c.id} className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold">{c.name}</h2>
              {c.unreadConversations > 0 && <Pill tone="sun"><span className="num">{c.unreadConversations}</span> {c.unreadConversations === 1 ? 'مستني رد' : 'مستنيين رد'}</Pill>}
            </div>
            {c.notes && <p className="text-sm text-muted">{c.notes}</p>}
            <div className="flex flex-wrap gap-2">
              {c.waNumbers.map(w => <Pill key={w.id} tone={w.status === 'CONNECTED' ? 'good' : 'bad'}>WhatsApp <span className="num">{w.displayPhone}</span></Pill>)}
              {c.socialAccounts.map(s => <Pill key={s.id} tone="info">{s.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} · {s.name}</Pill>)}
              {c.waNumbers.length + c.socialAccounts.length === 0 && <span className="text-sm text-muted">مفيش قنوات متربطة لسه</span>}
            </div>
            <p className="text-sm"><span className="text-muted">الفريق:</span> {c.assigneeIds.map(nameOf).filter(Boolean).join('، ') || 'مفيش حد متعين'}</p>
            <div className="mt-auto flex flex-wrap gap-2">
              {manage && <Button size="sm" variant="ghost" onClick={() => setAssigning(c)}>مين شغال عليه</Button>}
              <Button size="sm" variant="ghost" onClick={() => setPortal(c)}>صفحة العميل للموافقة</Button>
              <Link href={`/clients/${c.id}/report`} className="inline-flex h-8 items-center rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2">التقرير</Link>
            </div>
          </li>
        ))}
      </ul>

      <Modal open={adding} onClose={() => setAdding(false)} title="عميل جديد">
        <form onSubmit={create} className="flex flex-col gap-4">
          <Field label="اسم العميل" id="name"><Input id="name" name="name" required /></Field>
          <Field label="ملاحظات" id="notes"><Textarea id="notes" name="notes" rows={3} placeholder="مثلًا: مواعيد الرد، نوع المنتجات، أسعار الشحن" /></Field>
          <ErrorText error={error} />
          <Button>إضافة</Button>
        </form>
      </Modal>

      <Modal open={!!portal} onClose={() => setPortal(null)} title={`بوابة ${portal?.name ?? ''}`}>
        {portal && <PortalPanel client={portal} canManage={manage} />}
      </Modal>

      <Modal open={!!assigning} onClose={() => setAssigning(null)} title={`فريق ${assigning?.name ?? ''}`}>
        <form onSubmit={saveAssignments} className="flex flex-col gap-3">
          <p className="text-sm text-muted">المودريتور وكاتب المحتوى بيشوفوا بس العملاء المتعينين عليهم. المديرين بيشوفوا الكل.</p>
          {team?.members.filter(m => m.role === 'MODERATOR' || m.role === 'WRITER').map(m => (
            <label key={m.id} className="flex items-center gap-2"><input type="checkbox" name="userIds" value={m.id} defaultChecked={assigning?.assigneeIds.includes(m.id)} /> {m.name}</label>
          ))}
          <ErrorText error={error} />
          <Button>حفظ</Button>
        </form>
      </Modal>
    </>
  );
}
