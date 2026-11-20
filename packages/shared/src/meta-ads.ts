import { GRAPH_URL, GraphError } from './whatsapp.js';

/**
 * Meta Marketing API, read side (ads_read): ad account health, campaigns, and daily insights.
 * Research and sources: /mnt/project-files/agency-dashboard/research/ads.md
 */

/**
 * Meta's currency "offset": how many minor units make one unit. Budgets, spend caps and bids are
 * given in minor units ("cents for USD"); insights `spend` is given in whole units with decimals.
 * EGP and USD are 100 (Meta currencies page). Currencies with offset 1 have no minor unit on Meta.
 */
const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export const currencyOffset = (currency: string) => (OFFSET_ONE.has(currency.toUpperCase()) ? 1 : 100);

/** A Graph number (Meta sends numbers as strings or numbers) in whole units, to integer minor units. */
export function toMinor(value: unknown, currency: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * currencyOffset(currency)) : 0;
}
/** A Graph integer field already in minor units (budgets, spend_cap, amount_spent). */
export function minorField(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const int = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };

/** "act_123" or "123" to "123"; null when it is not an ad account id. */
export function normalizeAdAccountId(input: string): string | null {
  const id = input.trim().replace(/^act_/i, '');
  return /^\d{5,25}$/.test(id) ? id : null;
}

export const ACCOUNT_STATUS_AR: Record<number, string> = {
  1: 'شغال',
  2: 'موقوف من ميتا',
  3: 'عليه فلوس متأخرة',
  7: 'تحت مراجعة المخاطر',
  8: 'مستني تسوية الدفع',
  9: 'في فترة سماح',
  100: 'في طريقه للإغلاق',
  101: 'مقفول'
};

export const OBJECTIVE_AR: Record<string, string> = {
  OUTCOME_AWARENESS: 'الوعي',
  OUTCOME_TRAFFIC: 'الزيارات',
  OUTCOME_ENGAGEMENT: 'التفاعل والرسايل',
  OUTCOME_LEADS: 'العملاء المحتملين',
  OUTCOME_SALES: 'المبيعات',
  OUTCOME_APP_PROMOTION: 'التطبيقات'
};

/** Campaign effective_status values that mean "it is spending money right now". */
export const DELIVERING = new Set(['ACTIVE', 'IN_PROCESS']);

// ---------- Graph calls with Meta's rate-limit headers ----------

export type AdsUsage = { pct: number; waitSec: number };

/**
 * Reads the three usage headers Meta returns on Marketing API calls and keeps the worst figure.
 * X-Business-Use-Case-Usage: {"<business id>": [{call_count, total_cputime, total_time, estimated_time_to_regain_access (minutes)}]}
 * X-Ad-Account-Usage: {acc_id_util_pct, reset_time_duration (seconds)}
 * X-FB-Ads-Insights-Throttle: {app_id_util_pct, acc_id_util_pct}
 */
export function parseAdsUsage(headers: Headers): AdsUsage {
  let pct = 0, waitSec = 0;
  const read = (name: string) => { try { const v = headers.get(name); return v ? JSON.parse(v) : null; } catch { return null; } };
  const buc = read('x-business-use-case-usage');
  if (buc && typeof buc === 'object') {
    for (const list of Object.values(buc as Record<string, unknown>)) {
      for (const u of Array.isArray(list) ? list : []) {
        pct = Math.max(pct, int(u?.call_count), int(u?.total_cputime), int(u?.total_time));
        waitSec = Math.max(waitSec, int(u?.estimated_time_to_regain_access) * 60);
      }
    }
  }
  const acc = read('x-ad-account-usage');
  if (acc) { pct = Math.max(pct, int(acc.acc_id_util_pct)); if (int(acc.acc_id_util_pct) >= 100) waitSec = Math.max(waitSec, int(acc.reset_time_duration)); }
  const ins = read('x-fb-ads-insights-throttle');
  if (ins) pct = Math.max(pct, int(ins.app_id_util_pct), int(ins.acc_id_util_pct));
  return { pct, waitSec };
}

export class AdsGraphError extends GraphError {
  constructor(message: string, status: number, code: number | undefined, readonly subcode: number | undefined, readonly usage: AdsUsage) {
    super(message, status, code);
  }
  /** Meta asked us to slow down (app, account or business use case limits). */
  get throttled() {
    const c = this.code ?? 0;
    return c === 4 || c === 17 || c === 32 || c === 341 || c === 368 || c === 613 || (c >= 80000 && c <= 80014);
  }
  /** The token no longer works or lost the permission: retrying will not help until someone reconnects. */
  get auth() {
    const c = this.code ?? 0;
    // 100/33: the token is no longer allowed on this ad account; 1404163: the advertiser is blocked from advertising.
    return c === 190 || c === 102 || c === 10 || (c >= 200 && c < 300) || (c === 100 && this.subcode === 33) || c === 1404163;
  }
  /** The query asked for too much at once; a smaller date range works. */
  get tooBig() {
    // Documented: 100/1487534 (data per call). Seen in practice: code 1 "Please reduce the amount of data", and timeouts.
    return (this.code === 100 && (this.subcode === 1487534 || this.subcode === 1504018)) || (this.code === 2 && this.subcode === 1504038)
      || this.subcode === 1504045 || (this.code === 1 && /reduce the amount of data/i.test(this.message));
  }
}

export async function adsGraph<T>(path: string, token: string, fetchImpl: typeof fetch = fetch): Promise<{ data: T; usage: AdsUsage }> {
  const res = await fetchImpl(`${GRAPH_URL}/${path.replace(/^\//, '')}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90_000) });
  const usage = parseAdsUsage(res.headers);
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
  if (!res.ok || json.error) throw new AdsGraphError(json.error?.message ?? `Graph API ${res.status}`, res.status, json.error?.code, json.error?.error_subcode, usage);
  return { data: json, usage };
}

/** Follows `paging.cursors.after` until the last page. */
export async function adsGraphAll<T>(path: string, token: string, fetchImpl: typeof fetch = fetch, maxPages = 50): Promise<{ data: T[]; usage: AdsUsage }> {
  const out: T[] = [];
  let usage: AdsUsage = { pct: 0, waitSec: 0 };
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await adsGraph<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(after ? `${path}${sep}after=${encodeURIComponent(after)}` : path, token, fetchImpl);
    usage = { pct: Math.max(usage.pct, r.usage.pct), waitSec: Math.max(usage.waitSec, r.usage.waitSec) };
    out.push(...(r.data.data ?? []));
    after = r.data.paging?.next ? r.data.paging.cursors?.after : undefined;
    if (!after) return { data: out, usage };
  }
  // Stopping early would look like "no data" for the rest and erase it, so treat it like a query that is too big.
  throw new AdsGraphError('Please reduce the amount of data (page limit reached)', 400, 1, undefined, usage);
}

export const AD_ACCOUNT_FIELDS = 'id,name,currency,timezone_name,account_status,disable_reason,spend_cap,amount_spent';
/** The campaigns edge hides archived and deleted campaigns unless asked; their history and status changes matter. */
export const CAMPAIGN_STATUSES = JSON.stringify(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES']);
export const CAMPAIGN_FIELDS = 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,issues_info';
export const INSIGHT_FIELDS = 'campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,actions,action_values';

export type GraphAdAccount = { id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number | string; disable_reason?: number | string; spend_cap?: string; amount_spent?: string };
export type GraphCampaign = {
  id: string; name?: string; objective?: string; status?: string; effective_status?: string;
  daily_budget?: string; lifetime_budget?: string; budget_remaining?: string; start_time?: string; stop_time?: string;
  issues_info?: { level?: string; error_code?: number; error_summary?: string; error_message?: string; error_type?: string }[];
};
type ActionRow = { action_type?: string; value?: string | number };
export type GraphInsight = {
  campaign_id?: string; campaign_name?: string; date_start?: string; date_stop?: string; spend?: string | number; impressions?: string | number; reach?: string | number;
  inline_link_clicks?: string | number; actions?: ActionRow[]; action_values?: ActionRow[];
};

// Several action types count the same event at different scopes; the first one present wins so nothing is counted twice.
const MESSAGE_ACTIONS = ['onsite_conversion.messaging_conversation_started_7d'];
const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const PURCHASE_ACTIONS = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];
function firstAction(rows: ActionRow[] | undefined, types: string[]): number {
  if (!rows?.length) return 0;
  for (const t of types) { const r = rows.find(a => a.action_type === t); if (r) return Number(r.value) || 0; }
  return 0;
}

export type InsightRow = { date: string; spendMinor: number; impressions: number; reach: number; linkClicks: number; messages: number; leads: number; purchases: number; purchaseValueMinor: number };
export function parseInsight(r: GraphInsight, currency: string): InsightRow {
  return {
    date: String(r.date_start ?? ''),
    spendMinor: toMinor(r.spend, currency),
    impressions: int(r.impressions), reach: int(r.reach), linkClicks: int(r.inline_link_clicks),
    messages: Math.round(firstAction(r.actions, MESSAGE_ACTIONS)),
    leads: Math.round(firstAction(r.actions, LEAD_ACTIONS)),
    purchases: Math.round(firstAction(r.actions, PURCHASE_ACTIONS)),
    purchaseValueMinor: toMinor(firstAction(r.action_values, PURCHASE_ACTIONS), currency)
  };
}

/** Awareness uses impressions (cost per 1000), not reach: daily reach cannot be added up into period reach. */
export type ResultKind = 'messages' | 'leads' | 'purchases' | 'linkClicks' | 'impressions';

/** Objectives from before the v17 simplification, mapped to today's. */
const LEGACY_OBJECTIVE: Record<string, string> = {
  LINK_CLICKS: 'OUTCOME_TRAFFIC', REACH: 'OUTCOME_AWARENESS', BRAND_AWARENESS: 'OUTCOME_AWARENESS', VIDEO_VIEWS: 'OUTCOME_AWARENESS',
  LEAD_GENERATION: 'OUTCOME_LEADS', CONVERSIONS: 'OUTCOME_SALES', PRODUCT_CATALOG_SALES: 'OUTCOME_SALES', MESSAGES: 'OUTCOME_ENGAGEMENT',
  POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT', PAGE_LIKES: 'OUTCOME_ENGAGEMENT', APP_INSTALLS: 'OUTCOME_APP_PROMOTION'
};

/**
 * What counts as "the result" of a campaign, by objective. Egyptian campaigns often optimise for
 * messages under the Sales or Leads objective (click to WhatsApp or Messenger), so when the
 * objective's own result is zero and messages are not, messages are the result.
 */
export function resultKind(objective: string | null | undefined, t: { messages: number; leads: number; purchases: number }): ResultKind {
  objective = objective ? LEGACY_OBJECTIVE[objective] ?? objective : objective;
  const primary: ResultKind = objective === 'OUTCOME_SALES' ? 'purchases' : objective === 'OUTCOME_LEADS' ? 'leads'
    : objective === 'OUTCOME_TRAFFIC' ? 'linkClicks' : objective === 'OUTCOME_AWARENESS' ? 'impressions' : 'messages';
  if ((primary === 'purchases' || primary === 'leads') && t[primary] === 0 && t.messages > 0) return 'messages';
  return primary;
}

/** Calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
export function dayIn(timeZone: string, at = new Date()): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return at.toISOString().slice(0, 10); }
}
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
