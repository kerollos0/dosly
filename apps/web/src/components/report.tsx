'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetcher } from '@/lib/api';
import { Button } from './ui';

export type Report = {
  from: string; to: string;
  posts: { published: number; failed: number; upcoming: number; awaitingYou: number; byPlatform: { FACEBOOK_PAGE: number; INSTAGRAM: number } };
  inbox: { newConversations: number; inbound: number; outbound: number; customerTurns: number; answered: number; medianFirstResponseSec: number | null; open: number };
  daily: { day: string; inbound: number }[];
};

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const nf = new Intl.NumberFormat('ar-EG-u-nu-latn');

function duration(sec: number | null) {
  if (sec === null) return '—';
  if (sec < 90) return `${nf.format(Math.max(1, Math.round(sec)))} ثانية`;
  // Arabic counts 3 to 10 take the plural: 3 دقايق, but 15 دقيقة.
  if (sec < 90 * 60) { const m = Math.round(sec / 60); return `${nf.format(m)} ${m >= 3 && m <= 10 ? 'دقايق' : 'دقيقة'}`; }
  const h = Math.round(sec / 360) / 10;
  return `${nf.format(h)} ${h >= 3 && h <= 10 && Number.isInteger(h) ? 'ساعات' : 'ساعة'}`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-4">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-display text-3xl font-bold">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

/** Customer messages per day: one series, so one hue, no legend; the title names it. */
function DailyBars({ r }: { r: Report }) {
  const [hover, setHover] = useState<number | null>(null);
  const start = new Date(r.from), end = new Date(r.to);
  const days: { day: string; inbound: number }[] = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1)); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, inbound: r.daily.find(x => x.day === key)?.inbound ?? 0 });
  }
  const max = Math.max(1, ...days.map(d => d.inbound));
  const h = hover === null ? null : days[hover];
  return (
    <figure className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line bg-surface p-4">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">رسايل العملاء كل يوم</span>
        <span className="num text-sm text-muted" aria-live="polite">{h ? `${Number(h.day.slice(8))} ${MONTHS[Number(h.day.slice(5, 7)) - 1]}: ${nf.format(h.inbound)} رسالة` : `أعلى يوم: ${nf.format(max)}`}</span>
      </figcaption>
      {/* Days run right to left like the rest of the page; bars are 2px apart with rounded tops on the baseline. */}
      <div className="flex h-36 items-end gap-[2px] border-b border-line" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <button key={d.day} type="button" aria-label={`${Number(d.day.slice(8))}: ${d.inbound} رسالة`}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
            className="flex h-full flex-1 items-end focus-visible:outline-2 focus-visible:outline-primary">
            <span className={`w-full rounded-t-[4px] ${hover === i ? 'bg-faience-ink' : 'bg-faience'}`} style={{ height: d.inbound ? `${Math.max(3, (d.inbound / max) * 100)}%` : '0' }} />
          </button>
        ))}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">اعرضها كجدول</summary>
        <table className="mt-2 w-full text-start"><thead><tr><th className="text-start">اليوم</th><th className="text-start">الرسايل</th></tr></thead>
          <tbody>{days.filter(d => d.inbound).map(d => <tr key={d.day}><td className="num">{d.day}</td><td className="num">{d.inbound}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

/** The monthly report, shared by the client portal and the agency's view of the same client. */
export function MonthlyReport({ path, title }: { path: string; title?: string }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const { data: r } = useSWR<Report>(`${path}?year=${ym.y}&month=${ym.m}`, fetcher as never);
  const shift = (n: number) => setYm(({ y, m }) => { const d = new Date(y, m - 1 + n, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const isCurrent = ym.y === now.getFullYear() && ym.m === now.getMonth() + 1;
  const rate = r && r.inbox.customerTurns ? Math.round((r.inbox.answered / r.inbox.customerTurns) * 100) : null;

  return (
    <section aria-labelledby="rep-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="rep-h" className="font-display text-2xl font-bold">{title ?? 'تقرير الشهر'}</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="الشهر اللي فات"><ChevronRight size={16} aria-hidden /></Button>
          <span className="min-w-28 text-center font-semibold">{MONTHS[ym.m - 1]} <span className="num">{ym.y}</span></span>
          <Button size="sm" variant="ghost" onClick={() => shift(1)} disabled={isCurrent} aria-label="الشهر اللي بعده"><ChevronLeft size={16} aria-hidden /></Button>
        </div>
      </div>
      {!r ? <p className="text-muted">بيحمّل…</p> : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            <Tile label="بوستات اتنشرت" value={nf.format(r.posts.published)} sub={`فيسبوك ${nf.format(r.posts.byPlatform.FACEBOOK_PAGE)} · إنستجرام ${nf.format(r.posts.byPlatform.INSTAGRAM)}`} />
            <Tile label="رسايل من العملاء" value={nf.format(r.inbox.inbound)} sub={`${nf.format(r.inbox.newConversations)} عميل جديد كلّمكم`} />
            <Tile label="متوسط وقت الرد" value={duration(r.inbox.medianFirstResponseSec)} sub="من رسالة العميل لحد أول رد" />
            <Tile label="اترد عليهم" value={rate === null ? '—' : `${nf.format(rate)}%`} sub={`${nf.format(r.inbox.answered)} من ${nf.format(r.inbox.customerTurns)} مرة العميل كتب`} />
          </div>
          <DailyBars r={r} />
        </>
      )}
    </section>
  );
}
