'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher, ROLE_LABEL, type Role } from '@/lib/api';
import { Button, ErrorText, Field, Input, Modal, PageHeader, Pill, Select } from '@/components/ui';
import { PLAN_LABEL, PLAN_PRICE, planPill } from '@/lib/plans';

type Detail = {
  id: string; name: string; plan: string; status: string; suspendedReason: string | null; trialEndsAt: string | null; paidUntil: string | null; createdAt: string; demoExpiresAt: string | null;
  memberships: { role: Role; createdAt: string; user: { id: string; name: string; email: string } }[];
  payments: { id: string; plan: string; amountEgp: number; months: number; method: string; reference: string | null; createdAt: string }[];
  counts: { clients: number; waNumbers: number; socialAccounts: number; messages30d: number; posts30d: number; conversationsOpen: number };
  limits: { clients: number | null; members: number | null; portal: boolean };
  lastActivityAt: string | null;
  doslyLog: { id: string; action: string; createdAt: string; meta: Record<string, unknown> }[];
};
type Action = 'payment' | 'trial' | 'suspend' | 'support' | null;
const METHODS = { instapay: 'InstaPay', bank: 'تحويل بنكي', vodafone_cash: 'فودافون كاش', cash: 'كاش', other: 'غير كده' };
const LOG: Record<string, string> = { 'dosly.payment': 'تسجيل دفع', 'dosly.plan_change': 'تغيير الباقة', 'dosly.suspend': 'إيقاف', 'dosly.unsuspend': 'رجوع الحساب', 'dosly.support_login': 'دخول دعم فني' };
const d = (s: string | null) => (s ? s.slice(0, 10) : '—');

export default function AgencyDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: a, mutate } = useSWR<Detail>(`/admin/agencies/${id}`, fetcher as never);
  const { data: me } = useSWR<{ readOnly: boolean }>('/admin/me', fetcher as never);
  const [action, setAction] = useState<Action>(null);
  const [plan, setPlan] = useState('GROWTH');
  const [months, setMonths] = useState(1);
  const [error, setError] = useState<string | null>(null);
  if (!a) return <p className="p-8 text-muted">بيحمّل…</p>;
  const ro = me?.readOnly ?? true;

  async function run(path: string, body: unknown, after?: () => void) {
    setError(null);
    try { await api(`/admin/agencies/${id}/${path}`, { body }); setAction(null); after ? after() : await mutate(); } catch (e) { setError((e as Error).message); }
  }
  const form = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; };

  return (
    <>
      <PageHeader title={a.name} sub={`اشتركت ${d(a.createdAt)} · آخر نشاط ${d(a.lastActivityAt)}`} action={<Link href="/admin/agencies" className="text-sm font-semibold text-faience-ink">كل الوكالات</Link>} />
      <div className="grid gap-6 p-8 max-md:p-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          <section className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-line p-4">
            <Pill tone={planPill(a.plan)}>{PLAN_LABEL[a.plan]}</Pill>
            {a.status === 'SUSPENDED' ? <Pill tone="bad">موقوفة: {a.suspendedReason}</Pill> : <Pill tone="good">شغالة</Pill>}
            {a.demoExpiresAt && <Pill>ديمو</Pill>}
            <span className="text-sm text-muted">{a.plan === 'TRIAL' ? `التجربة لحد ${d(a.trialEndsAt)}` : `مدفوع لحد ${d(a.paidUntil)}`}</span>
          </section>
          <section aria-labelledby="use-h" className="flex flex-col gap-3">
            <h2 id="use-h" className="font-display text-lg font-bold">الاستخدام</h2>
            <dl className="grid grid-cols-3 gap-3 max-sm:grid-cols-2">
              {[['العملاء', `${a.counts.clients}${a.limits.clients ? ` من ${a.limits.clients}` : ''}`], ['أرقام واتساب', a.counts.waNumbers], ['صفحات وحسابات', a.counts.socialAccounts], ['رسايل آخر 30 يوم', a.counts.messages30d], ['بوستات آخر 30 يوم', a.counts.posts30d], ['محادثات مفتوحة', a.counts.conversationsOpen]].map(([k, v]) => (
                <div key={k} className="rounded-[var(--radius-md)] border border-line p-3"><dt className="text-sm text-muted">{k}</dt><dd className="font-display text-2xl font-bold tabular-nums">{v}</dd></div>
              ))}
            </dl>
          </section>
          <section aria-labelledby="team-h" className="flex flex-col gap-2">
            <h2 id="team-h" className="font-display text-lg font-bold">الفريق <span className="text-muted">({a.memberships.length}{a.limits.members ? ` من ${a.limits.members}` : ''})</span></h2>
            <ul className="divide-y divide-line">{a.memberships.map(m => <li key={m.user.id} className="flex justify-between py-2"><span>{m.user.name} <span className="text-sm text-muted" dir="ltr">{m.user.email.includes('.invalid') ? '' : m.user.email}</span></span><span className="text-sm text-muted">{ROLE_LABEL[m.role]}</span></li>)}</ul>
          </section>
          <section aria-labelledby="pay-h" className="flex flex-col gap-2">
            <h2 id="pay-h" className="font-display text-lg font-bold">المدفوعات</h2>
            {a.payments.length === 0 ? <p className="text-sm text-muted">مفيش مدفوعات لسه.</p> : (
              <table className="w-full text-sm"><thead className="text-muted"><tr><th className="text-start font-medium">التاريخ</th><th className="text-start font-medium">الباقة</th><th className="text-start font-medium">المبلغ</th><th className="text-start font-medium">الطريقة</th></tr></thead>
                <tbody>{a.payments.map(p => <tr key={p.id}><td className="num py-1">{d(p.createdAt)}</td><td>{PLAN_LABEL[p.plan]} × {p.months}</td><td className="num">{p.amountEgp} ج.م</td><td>{METHODS[p.method as keyof typeof METHODS]} {p.reference && <span className="text-muted" dir="ltr">{p.reference}</span>}</td></tr>)}</tbody></table>
            )}
          </section>
          <section aria-labelledby="log-h" className="flex flex-col gap-2">
            <h2 id="log-h" className="font-display text-lg font-bold">اللي دوسلي عمله في الحساب</h2>
            <p className="text-sm text-muted">ده بيظهر للوكالة كمان في سجل النشاط بتاعها.</p>
            <ul className="text-sm">{a.doslyLog.map(l => <li key={l.id} className="py-1"><span className="num text-muted">{l.createdAt.slice(0, 16).replace('T', ' ')}</span> · {LOG[l.action] ?? l.action} · {String(l.meta.admin ?? '')} {l.meta.reason ? `· ${String(l.meta.reason)}` : ''}</li>)}</ul>
          </section>
        </div>
        <aside aria-label="إجراءات" className="flex flex-col gap-2 self-start rounded-[var(--radius-md)] border border-line p-4">
          <h2 className="mb-1 font-semibold">إجراءات</h2>
          {ro && <p className="text-sm text-muted">في الديمو الإجراءات للعرض بس.</p>}
          <Button disabled={ro} onClick={() => setAction('payment')}>سجّل دفع</Button>
          <Button disabled={ro} variant="ghost" onClick={() => setAction('trial')}>مدّ التجربة أو غيّر الباقة</Button>
          <Button disabled={ro} variant="ghost" onClick={() => setAction('support')}>ادخل كدعم فني (للعرض بس)</Button>
          {a.status === 'SUSPENDED'
            ? <Button disabled={ro} variant="ghost" onClick={() => run('unsuspend', {})}>رجّع الحساب</Button>
            : <Button disabled={ro} variant="danger" onClick={() => setAction('suspend')}>أوقف الحساب</Button>}
        </aside>
      </div>

      <Modal open={action === 'payment'} onClose={() => setAction(null)} title="تسجيل دفع">
        <form className="flex flex-col gap-3" onSubmit={e => { const f = form(e); void run('payments', { plan: f.plan, months: Number(f.months), amountEgp: Number(f.amountEgp), method: f.method, reference: f.reference || undefined }); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="الباقة" id="plan"><Select id="plan" name="plan" value={plan} onChange={e => setPlan(e.target.value)}>{['STARTER', 'GROWTH', 'AGENCY'].map(p => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}</Select></Field>
            <Field label="عدد الشهور" id="months"><Input id="months" name="months" type="number" min={1} max={24} value={months} onChange={e => setMonths(Number(e.target.value))} /></Field>
          </div>
          <Field label="المبلغ اللي وصل (ج.م)" id="amount"><Input id="amount" name="amountEgp" type="number" min={0} key={`${plan}-${months}`} defaultValue={PLAN_PRICE[plan]! * months} /></Field>
          <Field label="طريقة الدفع" id="method"><Select id="method" name="method">{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="رقم العملية" id="ref"><Input id="ref" name="reference" dir="ltr" /></Field>
          <ErrorText error={error} /><Button>سجّل</Button>
        </form>
      </Modal>
      <Modal open={action === 'trial'} onClose={() => setAction(null)} title="الباقة والتجربة">
        <form className="flex flex-col gap-3" onSubmit={e => { const f = form(e); void run('plan', { plan: f.plan, trialEndsAt: f.trialEndsAt || undefined }); }}>
          <Field label="الباقة" id="p2"><Select id="p2" name="plan" defaultValue={a.plan}>{Object.entries(PLAN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="التجربة لحد" id="t2"><Input id="t2" name="trialEndsAt" type="date" defaultValue={a.trialEndsAt?.slice(0, 10)} /></Field>
          <ErrorText error={error} /><Button>حفظ</Button>
        </form>
      </Modal>
      <Modal open={action === 'suspend'} onClose={() => setAction(null)} title="إيقاف الحساب">
        <form className="flex flex-col gap-3" onSubmit={e => { const f = form(e); void run('suspend', { reason: f.reason }); }}>
          <p className="text-sm text-muted">الوكالة هتقدر تشوف بياناتها بس مش هتقدر ترد أو تنشر. الرسايل الجديدة هتفضل تتسجل.</p>
          <Field label="السبب (هيظهر للوكالة)" id="r1"><Input id="r1" name="reason" required minLength={3} /></Field>
          <ErrorText error={error} /><Button variant="danger">أوقف</Button>
        </form>
      </Modal>
      <Modal open={action === 'support'} onClose={() => setAction(null)} title="دخول كدعم فني">
        <form className="flex flex-col gap-3" onSubmit={e => { const f = form(e); void run('impersonate', { reason: f.reason }, () => router.push('/today')); }}>
          <p className="text-sm text-muted">هتشوف اللوحة زي صاحب الوكالة بالظبط لمدة ساعة، من غير ما تقدر تبعت أو تنشر. الدخول ده بيتسجل في سجل نشاط الوكالة.</p>
          <Field label="السبب" id="r2"><Input id="r2" name="reason" required minLength={3} placeholder="مثلًا: بيقول الرسايل مش بتوصل" /></Field>
          <ErrorText error={error} /><Button>ادخل</Button>
        </form>
      </Modal>
    </>
  );
}
