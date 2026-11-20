import { createHash } from 'node:crypto';
import { addDays, dayIn } from './meta-ads.js';

/**
 * Demo Marketing API: ad accounts, campaigns and daily insights shaped like Meta's, generated
 * from the account id so every sync of the same day returns the same numbers. The last digit of
 * a demo account id picks the business (0 cafe, 1 perfume shop, 2 dental clinic, 3 language
 * academy), so campaign names match the client.
 */

type DemoCampaign = {
  key: string; name: string; objective: string; status: 'ACTIVE' | 'PAUSED'; effective: string;
  daily?: number; lifetime?: number; lifetimeLeft?: number; // whole currency units
  startDaysAgo: number; stopDaysAgo?: number; endsInDays?: number; // stopDaysAgo: last day it delivered
  cpm: number; ctr: number; costPerMessage?: number; costPerLead?: number; costPerPurchase?: number; orderValue?: number;
  issues?: { error_code: number; error_summary: string; error_message: string; level: string; error_type: string }[];
};
type DemoAccount = { name: string; currency: string; status: number; disable?: number; spendCap?: number; spent?: number; campaigns: DemoCampaign[] };

const ACCOUNTS: DemoAccount[] = [
  { name: 'Nesma Cafe Ads', currency: 'EGP', status: 1, campaigns: [
    { key: '1', name: 'رسايل واتساب | منيو الشتا', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective: 'ACTIVE', daily: 350, startDaysAgo: 75, cpm: 28, ctr: 0.014, costPerMessage: 9 },
    { key: '2', name: 'وعي | عرض الويك إند', objective: 'OUTCOME_AWARENESS', status: 'ACTIVE', effective: 'ACTIVE', daily: 150, startDaysAgo: 40, cpm: 14, ctr: 0.006 },
    { key: '3', name: 'حجوزات أعياد الميلاد', objective: 'OUTCOME_LEADS', status: 'PAUSED', effective: 'PAUSED', daily: 200, startDaysAgo: 60, stopDaysAgo: 12, cpm: 35, ctr: 0.012, costPerLead: 32 }
  ] },
  { name: 'Lamsa Perfumes', currency: 'EGP', status: 1, spendCap: 150_000, spent: 129_400, campaigns: [
    { key: '1', name: 'مبيعات | عود ملكي', objective: 'OUTCOME_SALES', status: 'ACTIVE', effective: 'ACTIVE', daily: 1200, startDaysAgo: 90, cpm: 45, ctr: 0.017, costPerPurchase: 165, orderValue: 1250, costPerMessage: 22 },
    { key: '2', name: 'رسايل | هدايا عيد الأم', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective: 'ACTIVE', lifetime: 18_000, lifetimeLeft: 2_100, startDaysAgo: 24, endsInDays: 4, cpm: 32, ctr: 0.015, costPerMessage: 14 },
    { key: '3', name: 'ريتارجتنج | زوار الموقع', objective: 'OUTCOME_SALES', status: 'ACTIVE', effective: 'WITH_ISSUES', daily: 400, startDaysAgo: 50, stopDaysAgo: 2, cpm: 60, ctr: 0.021, costPerPurchase: 120, orderValue: 1100,
      issues: [{ error_code: 1487890, error_summary: 'الإعلان اترفض', error_message: 'Your ad was rejected because it does not comply with our advertising policies (demo).', level: 'AD', error_type: 'HARD_ERROR' }] }
  ] },
  { name: 'Dr Salma Dental', currency: 'EGP', status: 1, campaigns: [
    { key: '1', name: 'رسايل | تبييض الأسنان', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective: 'ACTIVE', daily: 300, startDaysAgo: 80, cpm: 30, ctr: 0.011, costPerMessage: 16 },
    { key: '2', name: 'فورم | استشارة تقويم مجانية', objective: 'OUTCOME_LEADS', status: 'PAUSED', effective: 'PAUSED', daily: 250, startDaysAgo: 33, stopDaysAgo: 0, cpm: 38, ctr: 0.009, costPerLead: 48 }
  ] },
  { name: 'Khatwa Academy', currency: 'USD', status: 3, campaigns: [
    { key: '1', name: 'Leads | Kids English', objective: 'OUTCOME_LEADS', status: 'ACTIVE', effective: 'ACTIVE', daily: 12, startDaysAgo: 70, stopDaysAgo: 3, cpm: 0.9, ctr: 0.013, costPerLead: 1.1 },
    { key: '2', name: 'Messages | French group', objective: 'OUTCOME_ENGAGEMENT', status: 'ACTIVE', effective: 'ACTIVE', daily: 8, startDaysAgo: 45, stopDaysAgo: 3, cpm: 0.7, ctr: 0.012, costPerMessage: 0.35 }
  ] }
];
const TZ = 'Africa/Cairo';

const rand = (seed: string) => createHash('sha256').update(seed).digest().readUInt32BE(0) / 0xffffffff;
const accountOf = (id: string) => ACCOUNTS[Number(id.slice(-1)) % ACCOUNTS.length]!;
/** Demo campaign ids are the account id plus the campaign key, so the demo seed can refer to them. */
export const demoCampaignId = (accountId: string, key: string) => `${accountId}${key}`;
const campaignId = demoCampaignId;

function campaignJson(accountId: string, c: DemoCampaign, now: Date) {
  const today = dayIn(TZ, now);
  return {
    id: campaignId(accountId, c.key), name: c.name, objective: c.objective, status: c.status, effective_status: c.effective,
    ...(c.daily ? { daily_budget: String(Math.round(c.daily * 100)) } : {}),
    ...(c.lifetime ? { lifetime_budget: String(c.lifetime * 100), budget_remaining: String((c.lifetimeLeft ?? 0) * 100) } : { budget_remaining: '0' }),
    start_time: `${addDays(today, -c.startDaysAgo)}T10:00:00+0200`,
    ...(c.endsInDays ? { stop_time: `${addDays(today, c.endsInDays)}T23:59:00+0200` } : {}),
    ...(c.issues ? { issues_info: c.issues } : {})
  };
}

/** One campaign's numbers for one day, or null when it did not deliver that day. */
function dayRow(accountId: string, acc: DemoAccount, c: DemoCampaign, day: string, now: Date) {
  const today = dayIn(TZ, now);
  const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400_000);
  if (age < 0 || age > c.startDaysAgo) return null;
  if (c.stopDaysAgo !== undefined && age < c.stopDaysAgo) return null;
  const r = (k: string) => rand(`${accountId}:${c.key}:${day}:${k}`);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const budget = c.daily ?? (c.lifetime ? c.lifetime / (c.startDaysAgo + (c.endsInDays ?? 0)) : 0);
  let spend = budget * (0.78 + r('s') * 0.2) * (weekday === 4 || weekday === 5 ? 1.05 : 1);
  if (age === 0) { // today is still running: only the hours so far
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
    spend *= Math.max(0.02, h / 24);
  }
  const impressions = Math.round((spend / (c.cpm * (0.85 + r('c') * 0.3))) * 1000);
  const clicks = Math.round(impressions * c.ctr * (0.8 + r('t') * 0.4));
  const count = (cost?: number) => (cost ? Math.max(0, Math.round((spend / cost) * (0.75 + r(String(cost)) * 0.5))) : 0);
  const messages = count(c.costPerMessage), leads = count(c.costPerLead), purchases = count(c.costPerPurchase);
  const actions = [
    { action_type: 'link_click', value: String(clicks) },
    ...(messages ? [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(messages) }] : []),
    ...(leads ? [{ action_type: 'lead', value: String(leads) }, { action_type: 'onsite_conversion.lead_grouped', value: String(leads) }] : []),
    ...(purchases ? [{ action_type: 'omni_purchase', value: String(purchases) }, { action_type: 'purchase', value: String(purchases) }] : [])
  ];
  const value = purchases * (c.orderValue ?? 0) * (0.85 + r('v') * 0.3);
  return {
    campaign_id: campaignId(accountId, c.key), date_start: day, date_stop: day,
    spend: spend.toFixed(2), impressions: String(impressions), reach: String(Math.round(impressions / (1.25 + r('f') * 0.5))),
    inline_link_clicks: String(clicks), actions,
    ...(purchases ? { action_values: [{ action_type: 'omni_purchase', value: value.toFixed(2) }, { action_type: 'purchase', value: value.toFixed(2) }] } : {})
  };
}

const PAGE = 100;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json',
  'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 3, reset_time_duration: 0, ads_api_access_tier: 'standard_access' })
} });

/** Answers GET act_<id>, act_<id>/campaigns and act_<id>/insights. Returns null for anything else. */
export function demoAdsGraph(url: URL, now = new Date()): Response | null {
  const path = url.pathname.replace(/^\/v[\d.]+\//, '');
  const m = path.match(/^act_(\d+)(?:\/(campaigns|insights))?$/);
  if (!m) return null;
  const [, accountId, edge] = m as unknown as [string, string, string | undefined];
  const acc = accountOf(accountId);
  if (!edge) {
    return json({
      id: `act_${accountId}`, name: acc.name, currency: acc.currency, timezone_name: TZ, account_status: acc.status, disable_reason: acc.disable ?? 0,
      spend_cap: String((acc.spendCap ?? 0) * 100), amount_spent: String(Math.round((acc.spent ?? 0) * 100))
    });
  }
  const offset = Number(url.searchParams.get('after') ?? 0) || 0;
  const page = (rows: unknown[]) => json({
    data: rows.slice(offset, offset + PAGE),
    paging: { cursors: { before: String(offset), after: String(offset + PAGE) }, ...(offset + PAGE < rows.length ? { next: 'https://graph.facebook.com/demo-next' } : {}) }
  });
  if (edge === 'campaigns') return page(acc.campaigns.map(c => campaignJson(accountId, c, now)));
  const range = JSON.parse(url.searchParams.get('time_range') ?? 'null') as { since: string; until: string } | null;
  const until = range?.until ?? dayIn(TZ, now);
  const since = range?.since ?? addDays(until, -6);
  const rows = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    for (const c of acc.campaigns) { const row = dayRow(accountId, acc, c, d, now); if (row && Number(row.spend) > 0) rows.push(row); }
  }
  return page(rows);
}
