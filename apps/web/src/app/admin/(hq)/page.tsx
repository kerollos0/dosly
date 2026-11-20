'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { PageHeader } from '@/components/ui';

type Overview = { plans: Record<string, number>; suspended: number; newWeek: number; trialsEnding: number; mrrEgp: number; messagesWeek: number; postsWeek: number; failedPosts: number; failedHooks: number; demoSandboxes: number };
const nf = new Intl.NumberFormat('ar-EG-u-nu-latn');

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-line p-4">
      <span className="text-sm text-muted">{label}</span>
      <span className={`font-display text-3xl font-bold ${tone === 'bad' ? 'text-danger' : ''}`}>{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

export default function AdminOverview() {
  const { data: o } = useSWR<Overview>('/admin/overview', fetcher as never, { refreshInterval: 60_000 });
  const { data: me } = useSWR<{ readOnly: boolean }>('/admin/me', fetcher as never);
  if (!o) return <p className="p-8 text-muted">بيحمّل…</p>;
  const paying = o.plans.STARTER! + o.plans.GROWTH! + o.plans.AGENCY!;
  return (
    <>
      <PageHeader title="نظرة عامة" sub={me?.readOnly ? 'في الديمو الأرقام دي محسوبة من وكالات الديمو. في الحقيقة بتبقى للوكالات المشتركة بس.' : 'الأرقام دي للوكالات الحقيقية بس، من غير الديمو.'} />
      <div className="flex flex-col gap-8 p-8 max-md:p-4">
        <section aria-labelledby="biz" className="flex flex-col gap-3">
          <h2 id="biz" className="font-display text-xl font-bold">البيزنس</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
            <Tile label="دخل شهري متوقع" value={`${nf.format(o.mrrEgp)} ج.م`} sub="بأسعار الباقات الحالية" />
            <Tile label="وكالات بتدفع" value={nf.format(paying)} sub={`البداية ${o.plans.STARTER} · النمو ${o.plans.GROWTH} · الوكالة ${o.plans.AGENCY}`} />
            <Tile label="في التجربة" value={nf.format(o.plans.TRIAL!)} sub={`${nf.format(o.trialsEnding)} تجربتهم بتخلص خلال 3 أيام`} />
            <Tile label="اشتركوا الأسبوع ده" value={nf.format(o.newWeek)} />
            <Tile label="موقوفين" value={nf.format(o.suspended)} />
          </div>
        </section>
        <section aria-labelledby="use" className="flex flex-col gap-3">
          <h2 id="use" className="font-display text-xl font-bold">الاستخدام آخر 7 أيام</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
            <Tile label="رسايل واتساب" value={nf.format(o.messagesWeek)} />
            <Tile label="بوستات اتنشرت" value={nf.format(o.postsWeek)} />
            <Tile label="بوستات فشلت" value={nf.format(o.failedPosts)} tone={o.failedPosts ? 'bad' : undefined} />
            <Tile label="أحداث Meta متأخرة" value={nf.format(o.failedHooks)} sub="مستنية أكتر من 5 دقايق" tone={o.failedHooks ? 'bad' : undefined} />
          </div>
          {(o.failedPosts > 0 || o.failedHooks > 0) && <Link href="/admin/health" className="text-sm font-semibold text-faience-ink">شوف التفاصيل في صحة النظام</Link>}
        </section>
        <p className="text-sm text-muted">ساندبوكسات ديمو شغالة دلوقتي: <span className="num">{o.demoSandboxes}</span></p>
      </div>
    </>
  );
}
