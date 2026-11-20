'use client';
import { useState, type KeyboardEvent } from 'react';
import useSWR from 'swr';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { count } from '@/lib/when';
import { fetcher } from '@/lib/api';
import { Button } from './ui';
import { AdKpis, adsSentence, CampaignTable, SpendBars } from './ads';
import { CURRENCY_NAME, dayLabel, money, type AdCurrencyBlock, type ReportCampaign } from '@/lib/ads';
import type { SalesBlock } from '@/lib/orders';
import { roasLine, SalesTiles } from './orders';

export type Report = {
  from: string; to: string;
  posts: { published: number; failed: number; upcoming: number; awaitingYou: number; byPlatform: { FACEBOOK_PAGE: number; INSTAGRAM: number } };
  inbox: { newConversations: number; inbound: number; outbound: number; customerTurns: number; answered: number; medianFirstResponseSec: number | null; open: number };
  daily: { day: string; inbound: number }[];
  ads: { currencies: AdCurrencyBlock[]; campaigns: ReportCampaign[] } | null;
  store?: {
    sales: SalesBlock[];
    roas: { currency: string; spendMinor: number; soldValueMinor: number; roas: number | null }[];
    campaigns: { id: string; name: string; currency: string; spendMinor: number; orders: number; sold: number; soldValueMinor: number; roas: number | null }[];
  } | null;
};

/** "30 orders, 24 sold for 31,200 pounds" and the return on ads, as two plain sentences. */
function storeSentences(st: NonNullable<Report['store']>, period: string) {
  return st.sales.flatMap(s => {
    const r = st.roas.find(x => x.currency === s.currency);
    return [
      `جالك ${count(s.orders, 'طلب واحد', 'طلبين', 'طلبات', 'طلب')} من المتجر ${period}، واتباع منهم ${count(s.sold, 'طلب واحد', 'طلبين', 'طلبات', 'طلب')} بـ ${money(s.soldValueMinor, s.currency, true)}.`,
      ...(r?.roas !== null && r?.roas !== undefined ? [`${roasLine(r.roas, s.currency)}.`] : [])
    ];
  });
}

function CampaignSales({ rows }: { rows: NonNullable<Report['store']>['campaigns'] }) {
  return (
    <div tabIndex={0} role="region" aria-label="مبيعات كل حملة، بيتحرك يمين وشمال على الموبايل" className="overflow-x-auto rounded-[var(--radius-md)] border border-line bg-surface focus-visible:outline-2 focus-visible:outline-primary">
      <table className="w-full min-w-[480px] text-sm">
        <caption className="sr-only">المبيعات اللي جت من كل حملة</caption>
        <thead className="bg-surface-2 text-muted"><tr>
          <th scope="col" className="p-3 text-start font-semibold">الحملة</th><th scope="col" className="p-3 text-start font-semibold">الصرف</th>
          <th scope="col" className="p-3 text-start font-semibold">طلبات اتباعت</th><th scope="col" className="p-3 text-start font-semibold">المبيعات</th><th scope="col" className="p-3 text-start font-semibold">الرجوع</th>
        </tr></thead>
        <tbody>{rows.map(c => (
          <tr key={c.id} className="border-t border-line">
            <th scope="row" className="p-3 text-start font-semibold">{c.name}</th>
            <td className="p-3 tabular-nums">{money(c.spendMinor, c.currency, true)}</td>
            <td className="p-3 tabular-nums">{nf.format(c.sold)} <span className="text-xs text-muted">من {nf.format(c.orders)}</span></td>
            <td className="p-3 font-semibold tabular-nums">{money(c.soldValueMinor, c.currency, true)}</td>
            <td className="p-3 tabular-nums">{c.roas === null ? '—' : `${nf.format(c.roas)}×`}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const nf = new Intl.NumberFormat('ar-EG-u-nu-latn');

function duration(sec: number | null) {
  if (sec === null) return '—';
  if (sec < 90) return count(Math.max(1, Math.round(sec)), 'ثانية واحدة', 'ثانيتين', 'ثواني', 'ثانية');
  if (sec < 90 * 60) return count(Math.round(sec / 60), 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة');
  const h = Math.round(sec / 3600);
  return count(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة');
}
const messages = (n: number) => count(n, 'رسالة واحدة', 'رسالتين', 'رسايل', 'رسالة');

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-4 max-sm:p-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-display text-3xl font-bold [overflow-wrap:anywhere] max-sm:text-2xl">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

/** "9 من كل 10" reads easier than 91%. */
function share(answered: number, total: number) {
  if (!total) return null;
  if (answered >= total) return 'كل';
  const tenths = Math.round((answered / total) * 10);
  return tenths >= 10 ? 'تقريبًا كل' : `${nf.format(Math.max(1, tenths))} من كل 10`;
}

/** Two or three plain sentences: what happened this month, before any number tiles. */
function summary(r: Report, current: boolean) {
  const out: string[] = [];
  const p = r.posts, fb = p.byPlatform.FACEBOOK_PAGE, ig = p.byPlatform.INSTAGRAM;
  const where = fb && ig ? ' على فيسبوك وإنستجرام' : fb ? ' على فيسبوك' : ig ? ' على إنستجرام' : '';
  const verb = current ? 'اتنشر لحد النهارده' : 'اتنشر';
  out.push(p.published ? `${verb} ${count(p.published, 'بوست واحد', 'بوستين', 'بوستات', 'بوست')}${where}.` : current ? 'لسه مفيش بوستات اتنشرت الشهر ده.' : 'مفيش بوستات اتنشرت الشهر ده.');
  const i = r.inbox;
  if (i.newConversations) {
    const sh = share(i.answered, i.customerTurns);
    const reply = sh ? `، واترد على ${sh} ${sh.endsWith('كل') ? 'الرسايل' : 'رسايل'}${i.medianFirstResponseSec !== null ? `، والرد كان بياخد حوالي ${duration(i.medianFirstResponseSec)}` : ''}` : '';
    out.push(`كلّمكم ${count(i.newConversations, 'عميل جديد واحد', 'عميلين جداد', 'عملاء جداد', 'عميل جديد')}${reply}.`);
  }
  return out;
}

/** Customer messages per day: one series, so one hue, no legend; the title names it. Arrow keys move along the days. */
function DailyBars({ r }: { r: Report }) {
  const [hover, setHover] = useState<number | null>(null);
  const start = new Date(r.from), end = new Date(r.to);
  const days: { day: string; inbound: number }[] = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1)); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, inbound: r.daily.find(x => x.day === key)?.inbound ?? 0 });
  }
  if (!days.length) return null;
  const max = Math.max(1, ...days.map(d => d.inbound));
  const top = days.reduce((a, d) => (d.inbound > a.inbound ? d : a), days[0]!);
  const h = hover === null ? null : days[hover];
  // One tab stop for the whole chart; the right arrow goes back in time because days run right to left.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover(i => Math.min(days.length - 1, Math.max(0, (i ?? days.length) + (e.key === 'ArrowLeft' ? 1 : -1))));
  };
  return (
    <figure className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line bg-surface p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">رسايل العملاء كل يوم</span>
        <span className="text-sm text-muted tabular-nums">{h ? `${dayLabel(h.day)}: ${messages(h.inbound)}` : top.inbound ? `أكتر يوم: ${dayLabel(top.day)} بـ ${messages(top.inbound)}` : ''}</span>
      </figcaption>
      <div tabIndex={0} role="img" onKeyDown={onKey} onBlur={() => setHover(null)} onMouseLeave={() => setHover(null)}
        aria-label={`رسايل العملاء كل يوم.${top.inbound ? ` أكتر يوم ${dayLabel(top.day)} بـ ${messages(top.inbound)}.` : ''} الجدول تحت فيه كل يوم.`}
        className="flex h-36 items-end gap-[2px] border-b border-line focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
        {days.map((d, i) => (
          <span key={d.day} aria-hidden onMouseEnter={() => setHover(i)} className="flex h-full min-w-0 flex-1 items-end">
            <span className={`w-full rounded-t-[4px] ${hover === i ? 'bg-faience-ink' : 'bg-faience'}`} style={{ height: d.inbound ? `${Math.max(3, (d.inbound / max) * 100)}%` : '0' }} />
          </span>
        ))}
      </div>
      <details className="text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-muted">اعرضها كجدول</summary>
        <table className="mt-2 w-full text-start"><caption className="sr-only">رسايل العملاء كل يوم</caption><thead><tr><th scope="col" className="text-start">اليوم</th><th scope="col" className="text-start">الرسايل</th></tr></thead>
          <tbody>{days.filter(d => d.inbound).map(d => <tr key={d.day}><td>{dayLabel(d.day)}</td><td className="tabular-nums">{nf.format(d.inbound)}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

/** A folded section that looks tappable: a chevron that turns when open, and a hint. */
function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-[var(--radius-md)] border border-line bg-surface">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 font-semibold [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="flex items-center gap-1 text-sm font-normal text-muted"><span className="group-open:hidden">دوس عشان تشوف</span><ChevronDown size={18} aria-hidden className="transition-transform group-open:rotate-180" /></span>
      </summary>
      <div className="p-2 pt-0">{children}</div>
    </details>
  );
}

/**
 * The monthly report, shared by the client portal and the agency's view of the same client.
 * `simple` is the client's version: the page's own h1, a summary and few numbers up front, details folded away.
 */
export function MonthlyReport({ path, title, simple = false }: { path: string; title?: string; simple?: boolean }) {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const { data: r, error } = useSWR<Report>(`${path}?year=${ym.y}&month=${ym.m}`, fetcher as never);
  const shift = (n: number) => setYm(({ y, m }) => { const d = new Date(y, m - 1 + n, 1); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const isCurrent = ym.y === now.getFullYear() && ym.m === now.getMonth() + 1;
  const H1 = simple ? 'h1' : 'h2', H2 = simple ? 'h2' : 'h3', H3 = simple ? 'h3' : 'h4';
  const period = isCurrent ? 'الشهر ده لحد النهارده' : 'في الشهر ده';

  return (
    <section aria-labelledby="rep-h" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <H1 id="rep-h" className="font-display text-2xl font-bold">{title ?? 'تقرير الشهر'}</H1>
        {simple ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto">
            <Button size="lg" variant="ghost" onClick={() => shift(-1)}><ChevronRight size={18} aria-hidden />الشهر اللي فات</Button>
            <span aria-live="polite" className="font-semibold">{MONTHS[ym.m - 1]} <span className="tabular-nums">{ym.y}</span></span>
            {isCurrent ? <span className="w-[136px] max-sm:hidden" /> : <Button size="lg" variant="ghost" onClick={() => shift(1)}>الشهر اللي بعده<ChevronLeft size={18} aria-hidden /></Button>}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="الشهر اللي فات"><ChevronRight size={16} aria-hidden /></Button>
            <span className="min-w-28 text-center font-semibold">{MONTHS[ym.m - 1]} <span className="tabular-nums">{ym.y}</span></span>
            <Button size="sm" variant="ghost" onClick={() => shift(1)} disabled={isCurrent} aria-label="الشهر اللي بعده"><ChevronLeft size={16} aria-hidden /></Button>
          </div>
        )}
      </div>
      {error && !r ? <p role="alert" className="text-danger">مش قادرين نجيب التقرير دلوقتي. جرّب تاني بعد شوية.</p> : !r ? <p role="status" className="text-muted">بيحمّل…</p> : (
        <>
          <div className="flex flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-4 text-lg leading-8">
            <H2 className="text-sm font-semibold text-muted">الخلاصة</H2>
            {summary(r, isCurrent).map(t => <p key={t}>{t}</p>)}
            {r.ads?.currencies.map(b => <p key={b.currency}>{adsSentence(b, period)}</p>)}
            {r.store && storeSentences(r.store, period).map(t => <p key={t}>{t}</p>)}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
            <Tile label="بوستات اتنشرت" value={nf.format(r.posts.published)} sub={simple ? undefined : `فيسبوك ${nf.format(r.posts.byPlatform.FACEBOOK_PAGE)} · إنستجرام ${nf.format(r.posts.byPlatform.INSTAGRAM)}`} />
            <Tile label="رسايل من العملاء" value={nf.format(r.inbox.inbound)} sub={r.inbox.newConversations ? `من ${count(r.inbox.newConversations, 'عميل جديد واحد', 'عميلين جداد', 'عملاء جداد', 'عميل جديد')}` : undefined} />
            <Tile label="الرد بياخد قد إيه" value={duration(r.inbox.medianFirstResponseSec)} sub={r.inbox.customerTurns ? `واترد على ${nf.format(r.inbox.answered)} من ${messages(r.inbox.customerTurns)}` : 'من رسالة العميل لحد أول رد'} />
          </div>
          {simple ? <Fold title="الرسايل يوم بيوم"><DailyBars r={r} /></Fold> : <DailyBars r={r} />}
          {r.ads && (r.ads.currencies.length > 0 ? (
            <section aria-labelledby="rep-ads-h" className="flex flex-col gap-3">
              <H2 id="rep-ads-h" className="font-display text-xl font-bold">الإعلانات</H2>
              {r.ads.currencies.map(b => (
                <div key={b.currency} className="flex flex-col gap-3">
                  {r.ads!.currencies.length > 1 && <H3 className="font-semibold">الحسابات {CURRENCY_NAME[b.currency] ?? b.currency}</H3>}
                  <AdKpis block={b} client />
                  {!simple && <SpendBars block={b} title="صرف الإعلانات كل يوم" />}
                </div>
              ))}
              {r.ads.campaigns.length > 0 && (simple
                ? <Fold title="كل حملة جابت إيه"><CampaignTable rows={r.ads.campaigns} compact /></Fold>
                : <><H3 className="font-semibold">كل حملة جابت إيه</H3><CampaignTable rows={r.ads.campaigns} compact /></>)}
            </section>
          ) : <p className="text-muted">مفيش صرف على الإعلانات في الشهر ده.</p>)}
          {r.store && (
            <section aria-labelledby="rep-store-h" className="flex flex-col gap-3">
              <H2 id="rep-store-h" className="font-display text-xl font-bold">المبيعات من المتجر</H2>
              {r.store.sales.length === 0 && <p className="text-muted">مفيش طلبات في الشهر ده.</p>}
              {r.store.sales.map(s => (
                <div key={s.currency} className="flex flex-col gap-3">
                  {r.store!.sales.length > 1 && <H3 className="font-semibold">{CURRENCY_NAME[s.currency] ?? s.currency}</H3>}
                  <SalesTiles s={s} roas={r.store!.roas.find(x => x.currency === s.currency)?.roas ?? undefined} client={simple} />
                </div>
              ))}
              <p className="text-xs text-muted">«مبيعات حقيقية» يعني طلبات اتأكدت أو اتشحنت أو اتسلمت، من غير اللي اتلغى أو رجع.</p>
              {r.store.campaigns.length > 0 && (simple
                ? <Fold title="كل حملة باعت قد إيه"><CampaignSales rows={r.store.campaigns} /></Fold>
                : <><H3 className="font-semibold">كل حملة باعت قد إيه</H3><CampaignSales rows={r.store.campaigns} /></>)}
            </section>
          )}
        </>
      )}
    </section>
  );
}
