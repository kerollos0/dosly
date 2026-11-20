'use client';
import { useState, type KeyboardEvent } from 'react';
import { CAMPAIGN_STATUS, clientCount, CLIENT_COST_LABEL, COST_LABEL, countLabel, currencyWord, dayLabel, money, nf, OBJECTIVE_LABEL, percent, RESULT_TITLE, type AdCampaign, type AdCurrencyBlock, type ReportCampaign, type ResultKind } from '@/lib/ads';
import { cx, Pill } from './ui';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-4 max-sm:p-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="font-display text-[24px] tabular-nums font-bold leading-8 [overflow-wrap:anywhere] max-sm:text-[20px] max-sm:leading-7">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

const SHOWN: ResultKind[] = ['messages', 'leads', 'purchases', 'linkClicks'];

/** "Every pound spent brought X pounds of sales" over the campaigns that aim at sales. */
function returnLine(b: AdCurrencyBlock) {
  const g = b.byResult.purchases;
  if (!g?.valueMinor || !g.spendMinor) return null;
  const r = Math.round((g.valueMinor / g.spendMinor) * 10) / 10;
  const w = currencyWord(b.currency);
  return `كل ${w} اتصرف على إعلانات البيع جاب ${nf.format(r)} ${w} مبيعات`;
}

/** One plain sentence for the business owner: what was spent and what it brought. */
export function adsSentence(b: AdCurrencyBlock, period = 'الشهر ده') {
  const got = (['messages', 'leads', 'purchases'] as const).filter(k => (b.byResult[k]?.results ?? 0) > 0).map(k => clientCount(b.byResult[k]!.results, k));
  const list = got.length > 1 ? `${got.slice(0, -1).join('، ')} و${got.at(-1)}` : got[0];
  return `اتصرف ${money(b.totals.spendMinor, b.currency)} على الإعلانات ${period}${list ? `، وجابت ${list}` : ''}.`;
}

/**
 * Headline numbers for one currency. Each result kind is priced by the campaigns aiming at it,
 * so "cost per message" is message campaigns' spend over their messages. `client` is the simpler
 * version for the business owner: no clicks, plain words.
 */
export function AdKpis({ block, client = false }: { block: AdCurrencyBlock; client?: boolean }) {
  const b = block, c = block.currency;
  const kinds = SHOWN.filter(k => (b.byResult[k]?.results ?? 0) > 0 && !(client && k === 'linkClicks'));
  const ctr = b.totals.impressions ? b.totals.linkClicks / b.totals.impressions : 0;
  const title = (k: ResultKind) => (client && k === 'leads' ? 'ناس سابوا رقمهم' : client && k === 'messages' ? 'محادثات بدأت من الإعلان' : RESULT_TITLE[k]);
  // The owner gets whole pounds and a plain "about"; the agency gets the exact cost.
  const clientCost = (k: ResultKind, minor: number | null) => `${k === 'leads' ? 'الواحد كلّف' : k === 'messages' ? 'المحادثة الواحدة كلّفت' : 'الواحدة كلّفت'} حوالي ${money(minor, c, true)}`;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      <Tile label={client ? 'اتصرف على الإعلانات' : 'الصرف'} value={money(b.totals.spendMinor, c, client)} sub={client ? undefined : `الإعلانات ظهرت ${nf.format(b.totals.impressions)} مرة`} />
      {kinds.map(k => {
        const g = b.byResult[k]!;
        const sub = k === 'purchases' && returnLine(b) ? returnLine(b)! : k === 'linkClicks'
          ? `${money(g.costPerResultMinor, c)} ${COST_LABEL[k]} · نسبة الضغط ${percent(ctr)}`
          : client ? clientCost(k, g.costPerResultMinor) : `${money(g.costPerResultMinor, c)} ${COST_LABEL[k]}`;
        return <Tile key={k} label={title(k)} value={nf.format(g.results)} sub={sub} />;
      })}
    </div>
  );
}

/** Spend per day for one currency: one series, one hue, no legend; the title names it. Arrow keys move along the days. */
export function SpendBars({ block, title = 'الصرف كل يوم' }: { block: AdCurrencyBlock; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = block.daily;
  if (!days.length) return null;
  const max = Math.max(1, ...days.map(d => d.spendMinor));
  const top = days.reduce((a, d) => (d.spendMinor > a.spendMinor ? d : a), days[0]!);
  const h = hover === null ? null : days[hover];
  // Days run right to left: the right arrow goes back in time.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover(i => Math.min(days.length - 1, Math.max(0, (i ?? days.length) + (e.key === 'ArrowLeft' ? 1 : -1))));
  };
  return (
    <figure className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-line bg-surface p-4">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-muted tabular-nums">{h ? `${dayLabel(h.day)}: ${money(h.spendMinor, block.currency)}` : top.spendMinor ? `أعلى يوم: ${dayLabel(top.day)} بـ ${money(top.spendMinor, block.currency)}` : ''}</span>
      </figcaption>
      <div tabIndex={0} role="img" onKeyDown={onKey} onBlur={() => setHover(null)} onMouseLeave={() => setHover(null)}
        aria-label={`${title} من ${dayLabel(days[0]!.day)} لـ ${dayLabel(days.at(-1)!.day)}. أعلى يوم ${dayLabel(top.day)} بـ ${money(top.spendMinor, block.currency)}. الجدول تحت فيه كل يوم.`}
        className="flex h-36 items-end gap-[2px] border-b border-line focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
        {days.map((d, i) => (
          <span key={d.day} aria-hidden onMouseEnter={() => setHover(i)} className="flex h-full min-w-0 flex-1 items-end">
            <span className={cx('w-full rounded-t-[4px]', hover === i ? 'bg-faience-ink' : 'bg-faience')} style={{ height: d.spendMinor ? `${Math.max(3, (d.spendMinor / max) * 100)}%` : '0' }} />
          </span>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted" aria-hidden><span>{dayLabel(days[0]!.day)}</span><span>{dayLabel(days.at(-1)!.day)}</span></div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">اعرضها كجدول</summary>
        <table className="mt-2 w-full">
          <caption className="sr-only">{title}</caption>
          <thead><tr><th scope="col" className="text-start">اليوم</th><th scope="col" className="text-start">الصرف</th></tr></thead>
          <tbody>{days.filter(d => d.spendMinor).map(d => <tr key={d.day}><td>{dayLabel(d.day)}</td><td className="tabular-nums">{money(d.spendMinor, block.currency)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

function budget(c: AdCampaign) {
  if (c.dailyBudgetMinor) return `${money(c.dailyBudgetMinor, c.currency)} في اليوم`;
  if (c.lifetimeBudgetMinor) return `${money(c.lifetimeBudgetMinor, c.currency)} للحملة كلها${c.budgetRemainingMinor !== null ? `، باقي ${money(c.budgetRemainingMinor, c.currency)}` : ''}`;
  return 'متقسمة على المجموعات';
}

export type AccountState = { label: string; tone: 'bad' | 'neutral'; stale?: boolean } | null;

/**
 * Campaigns sorted by spend. Scrolls sideways inside its own box on a phone; the page never does.
 * `compact` is the client report: no status (it is today's, not the month's) and no budget.
 */
export function CampaignTable({ rows, clientName, accountState, compact = false }: { rows: (AdCampaign | ReportCampaign)[]; clientName?: (id: string) => string; accountState?: (adAccountId: string) => AccountState; compact?: boolean }) {
  return (
    <div tabIndex={0} role="region" aria-label="جدول الحملات، بيتحرك يمين وشمال على الموبايل" className="overflow-x-auto rounded-[var(--radius-md)] border border-line bg-surface focus-visible:outline-2 focus-visible:outline-primary">
      <table className={cx('w-full text-sm', compact ? 'min-w-[480px]' : 'min-w-[680px]')}>
        <caption className="sr-only">الحملات مترتبة بالصرف</caption>
        <thead className="bg-surface-2 text-muted">
          <tr>
            <th scope="col" className="p-3 text-start font-semibold">الحملة</th>
            {!compact && <th scope="col" className="p-3 text-start font-semibold">الحالة</th>}
            {!compact && <th scope="col" className="p-3 text-start font-semibold">الميزانية</th>}
            <th scope="col" className="p-3 text-start font-semibold">الصرف</th>
            <th scope="col" className="p-3 text-start font-semibold">النتيجة</th>
            <th scope="col" className="p-3 text-start font-semibold">التكلفة</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const full = r as AdCampaign;
            const acc = !compact ? accountState?.(full.adAccountId) ?? null : null;
            const base = full.delivering === false && CAMPAIGN_STATUS[full.effectiveStatus]?.tone === 'good'
              ? { label: 'خلصت', tone: 'neutral' as const } // still ACTIVE on Meta but past its end date
              : CAMPAIGN_STATUS[full.effectiveStatus] ?? { label: full.effectiveStatus, tone: 'neutral' as const };
            const st = acc && !acc.stale && full.delivering ? acc : base;
            return (
              <tr key={r.id} className="border-t border-line align-top">
                <th scope="row" className="p-3 text-start font-normal">
                  <div className="font-semibold">{r.name}</div>
                  {!compact && <div className="text-xs text-muted">{[clientName && full.clientId ? clientName(full.clientId) : null, r.objective ? OBJECTIVE_LABEL[r.objective] ?? r.objective : null].filter(Boolean).join(' · ')}</div>}
                </th>
                {!compact && <td className="p-3"><Pill tone={st.tone}>{st.label}</Pill>{acc?.stale && <span className="mt-1 block text-xs text-muted">الأرقام مش متحدثة</span>}</td>}
                {!compact && <td className="p-3 text-muted">{budget(full)}</td>}
                <td className="p-3 font-semibold tabular-nums">{money(r.spendMinor, r.currency, compact)}</td>
                <td className="p-3">{r.results ? (compact ? clientCount : countLabel)(r.results, r.result) : '—'}</td>
                <td className="p-3 tabular-nums">{r.costPerResultMinor === null ? '—' : <>{money(r.costPerResultMinor, r.currency, compact)} <span className="text-xs text-muted">{(compact ? CLIENT_COST_LABEL : COST_LABEL)[r.result]}</span></>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
