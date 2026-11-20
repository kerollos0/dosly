'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { fetcher } from '@/lib/api';
import { PageHeader } from '@/components/ui';

type Health = {
  queues: Record<string, Record<string, number>> | null; pendingHooks: number; oldestHookAt: string | null; stuckPublishing: number;
  failedHooks24h: { id: string; receivedAt: string; error: string }[];
  failedPosts7d: { error: string | null; socialAccount: { platform: string; name: string }; post: { id: string; agency: { id: string; name: string } } }[];
};
const Q: Record<string, string> = { webhooks: 'أحداث Meta', posts: 'نشر البوستات', demo: 'محاكاة الديمو' };
const S: Record<string, string> = { waiting: 'مستني', active: 'شغال', delayed: 'متأجل', failed: 'فشل', completed: 'خلص' };

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <p className={`flex items-center gap-2 font-semibold ${ok ? 'text-success' : 'text-danger'}`}>{ok ? <CheckCircle2 size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}{children}</p>;
}

export default function AdminHealth() {
  const { data: h } = useSWR<Health>('/admin/health', fetcher as never, { refreshInterval: 15_000 });
  if (!h) return <p className="p-8 text-muted">بيحمّل…</p>;
  const lagMin = h.oldestHookAt ? Math.round((Date.now() - new Date(h.oldestHookAt).getTime()) / 60_000) : 0;
  return (
    <>
      <PageHeader title="صحة النظام" sub="بيتحدث كل 15 ثانية." />
      <div className="flex flex-col gap-8 p-8 max-md:p-4">
        <section className="flex flex-col gap-2">
          <Status ok={lagMin < 5}>{lagMin < 5 ? 'أحداث Meta بتتعالج في وقتها' : `أقدم حدث مستني من ${lagMin} دقيقة`}</Status>
          <Status ok={h.stuckPublishing === 0}>{h.stuckPublishing === 0 ? 'مفيش بوستات واقفة في النشر' : `${h.stuckPublishing} بوست واقف في النشر أكتر من 10 دقايق`}</Status>
        </section>
        {h.queues && (
          <section aria-labelledby="q-h" className="flex flex-col gap-2">
            <h2 id="q-h" className="font-display text-lg font-bold">الطوابير</h2>
            <table className="w-full max-w-2xl text-sm"><thead className="text-muted"><tr><th className="text-start font-medium">الطابور</th>{Object.keys(S).map(k => <th key={k} className="text-start font-medium">{S[k]}</th>)}</tr></thead>
              <tbody>{Object.entries(h.queues).map(([name, c]) => <tr key={name} className="border-t border-line"><td className="py-2">{Q[name] ?? name}</td>{Object.keys(S).map(k => <td key={k} className={`tabular-nums ${k === 'failed' && c[k] ? 'font-bold text-danger' : ''}`}>{c[k] ?? 0}</td>)}</tr>)}</tbody></table>
          </section>
        )}
        <section aria-labelledby="fp-h" className="flex flex-col gap-2">
          <h2 id="fp-h" className="font-display text-lg font-bold">بوستات فشلت آخر 7 أيام</h2>
          {h.failedPosts7d.length === 0 ? <p className="text-sm text-muted">ولا واحد.</p> : <ul className="flex flex-col gap-2 text-sm">{h.failedPosts7d.map((f, i) => <li key={i} className="rounded-[var(--radius-md)] border border-line p-3"><Link className="font-semibold text-faience-ink" href={`/admin/agencies/${f.post.agency.id}`}>{f.post.agency.name}</Link> · {f.socialAccount.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} {f.socialAccount.name}<br /><span className="text-danger" dir="ltr">{f.error}</span></li>)}</ul>}
        </section>
        <section aria-labelledby="fh-h" className="flex flex-col gap-2">
          <h2 id="fh-h" className="font-display text-lg font-bold">أحداث Meta فيها أخطاء آخر 24 ساعة</h2>
          {h.failedHooks24h.length === 0 ? <p className="text-sm text-muted">ولا واحد.</p> : <ul className="text-sm">{h.failedHooks24h.map(f => <li key={f.id} dir="ltr" className="text-danger">{f.receivedAt.slice(11, 19)} {f.error}</li>)}</ul>}
        </section>
      </div>
    </>
  );
}
