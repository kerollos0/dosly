import { Prisma, type Db } from '@dosly/db';
import {
  CAMPAIGN_STATUSES, AD_ACCOUNT_FIELDS, AdsGraphError, adsGraph, adsGraphAll, addDays, CAMPAIGN_FIELDS, dayIn, DELIVERING, INSIGHT_FIELDS, minorField, parseInsight, resultKind,
  decrypt, type AdsUsage, type GraphAdAccount, type GraphCampaign, type GraphInsight, type InsightRow, type ResultKind
} from '@dosly/shared';
import type { Publisher } from './events.js';

/**
 * Ads sync: copies an ad account's health, its campaigns and their daily numbers from the
 * Marketing API, then opens or clears alerts. Meta keeps adjusting a day's numbers for 28 days
 * (late conversions), so every sync re-reads the last 28 days; the first sync reads 90.
 */

export const ADS_SYNC_EVERY_MS = 15 * 60_000; // insights refresh every 15 minutes on Meta's side
export const ADS_RESYNC_DAYS = 28;
export const ADS_FIRST_DAYS = 90;
const SPEND_CAP_WARN = 0.8;
const LIFETIME_LOW = 0.2;

export type AdsDeps = { db: Db; key: Buffer; pub: Publisher; fetch?: typeof fetch };
export type SyncResult = { status: 'synced'; campaigns: number; days: number; alertsOpened: number } | { status: 'skipped' | 'throttled' | 'token_error'; reason?: string };

/** Graph account fields to row fields. */
export function accountFields(a: GraphAdAccount) {
  const cap = minorField(a.spend_cap);
  return {
    name: a.name ?? `act_${a.id.replace(/^act_/, '')}`,
    currency: (a.currency ?? 'USD').toUpperCase(),
    timezoneName: a.timezone_name ?? 'Africa/Cairo',
    accountStatus: Number(a.account_status ?? 1) || 1,
    disableReason: Number(a.disable_reason ?? 0) || 0,
    spendCapMinor: cap ? BigInt(cap) : null, // 0 means "no limit"
    amountSpentMinor: BigInt(minorField(a.amount_spent) ?? 0)
  };
}

/** Reads insights for [since, until], halving the range when Meta says the query is too big. */
async function readInsights(accountId: string, token: string, since: string, until: string, f: typeof fetch | undefined, usage: AdsUsage): Promise<GraphInsight[]> {
  const q = new URLSearchParams({
    level: 'campaign', time_increment: '1', fields: INSIGHT_FIELDS, time_range: JSON.stringify({ since, until }), limit: '500',
    use_unified_attribution_setting: 'true' // the same attribution Ads Manager shows the agency
  });
  try {
    const r = await adsGraphAll<GraphInsight>(`act_${accountId}/insights?${q}`, token, f, 200);
    usage.pct = Math.max(usage.pct, r.usage.pct); usage.waitSec = Math.max(usage.waitSec, r.usage.waitSec);
    return r.data;
  } catch (e) {
    if (!(e instanceof AdsGraphError) || !e.tooBig || since === until) throw e;
    const days = Math.round((Date.parse(until) - Date.parse(since)) / 86400_000);
    const mid = addDays(since, Math.floor(days / 2));
    return [...await readInsights(accountId, token, since, mid, f, usage), ...await readInsights(accountId, token, addDays(mid, 1), until, f, usage)];
  }
}

const big = (v: number | null) => (v === null ? null : BigInt(v));

/** First day to read: 90 days on the first sync; afterwards 28 days before the older of today and the last good sync, so an outage leaves no gap. */
export function syncFrom(today: string, timeZone: string, lastSyncAt: Date | null, insightsFrom: string | null): string {
  const oldest = addDays(today, -(ADS_FIRST_DAYS - 1));
  if (!lastSyncAt || !insightsFrom) return oldest;
  const from = addDays(dayIn(timeZone, lastSyncAt), -(ADS_RESYNC_DAYS - 1));
  const recent = addDays(today, -(ADS_RESYNC_DAYS - 1));
  const pick = from < recent ? from : recent;
  return pick < oldest ? oldest : pick;
}

/**
 * Reads one ad account from Meta and stores it. `force` skips the freshness check (a person pressed "update").
 * Two syncs of one account never write at the same time: the write runs under a per-account advisory lock.
 */
export async function syncAdAccount(deps: AdsDeps, adAccountId: string, now = new Date(), force = false): Promise<SyncResult> {
  const { db, key, pub } = deps;
  const acc = await db.adAccount.findUnique({ where: { id: adAccountId } });
  if (!acc) return { status: 'skipped', reason: 'gone' };
  if (acc.status === 'ERROR') return { status: 'skipped', reason: 'token' };
  if (acc.throttledUntil && acc.throttledUntil > now) return { status: 'throttled' };
  if (!force && acc.lastSyncAt && acc.lastSyncAt.getTime() > now.getTime() - ADS_SYNC_EVERY_MS + 60_000) return { status: 'skipped', reason: 'fresh' };
  await db.adAccount.update({ where: { id: acc.id }, data: { lastAttemptAt: now } });
  const token = decrypt(acc.accessTokenEnc, key);
  const usage: AdsUsage = { pct: 0, waitSec: 0 };
  const track = (u: AdsUsage) => { usage.pct = Math.max(usage.pct, u.pct); usage.waitSec = Math.max(usage.waitSec, u.waitSec); };

  try {
    const info = await adsGraph<GraphAdAccount>(`act_${acc.externalId}?fields=${AD_ACCOUNT_FIELDS}`, token, deps.fetch);
    track(info.usage);
    const fields = accountFields(info.data);
    const camps = await adsGraphAll<GraphCampaign>(`act_${acc.externalId}/campaigns?fields=${CAMPAIGN_FIELDS}&effective_status=${encodeURIComponent(CAMPAIGN_STATUSES)}&limit=200`, token, deps.fetch);
    track(camps.usage);
    const today = dayIn(fields.timezoneName, now);
    const since = syncFrom(today, fields.timezoneName, acc.lastSyncAt, acc.insightsFrom);
    const insights = await readInsights(acc.externalId, token, since, today, deps.fetch, usage);

    // Campaigns first, outside the transaction: one upsert each keeps the locked part short on big accounts.
    const ids = new Map<string, string>();
    for (const c of camps.data) {
      const data = {
        name: c.name ?? c.id, objective: c.objective ?? null, status: c.status ?? 'ACTIVE', effectiveStatus: c.effective_status ?? c.status ?? 'ACTIVE',
        dailyBudgetMinor: big(minorField(c.daily_budget)), lifetimeBudgetMinor: big(minorField(c.lifetime_budget)), budgetRemainingMinor: big(minorField(c.budget_remaining)),
        issues: c.issues_info?.length ? (c.issues_info as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        startTime: c.start_time ? new Date(c.start_time) : null, stopTime: c.stop_time ? new Date(c.stop_time) : null
      };
      const row = await db.adCampaign.upsert({ where: { adAccountId_externalId: { adAccountId: acc.id, externalId: c.id } }, create: { adAccountId: acc.id, externalId: c.id, ...data }, update: data, select: { id: true } });
      ids.set(c.id, row.id);
    }
    const known = await db.adCampaign.findMany({ where: { adAccountId: acc.id }, select: { id: true, externalId: true } });
    const gone = known.filter(k => !ids.has(k.externalId));
    // Not returned even with every status asked for: gone on Meta's side. It keeps its history but is no longer running.
    if (gone.length) await db.adCampaign.updateMany({ where: { id: { in: gone.map(k => k.id) } }, data: { status: 'DELETED', effectiveStatus: 'DELETED' } });
    for (const k of gone) ids.set(k.externalId, k.id);
    // Spend from a campaign we have never seen (removed long ago) still counts: keep it under a stub.
    for (const r of insights) {
      if (!r.campaign_id || ids.has(r.campaign_id)) continue;
      const row = await db.adCampaign.upsert({
        where: { adAccountId_externalId: { adAccountId: acc.id, externalId: r.campaign_id } },
        create: { adAccountId: acc.id, externalId: r.campaign_id, name: r.campaign_name ?? r.campaign_id, status: 'DELETED', effectiveStatus: 'DELETED', checkedStatus: 'DELETED' },
        update: {}, select: { id: true }
      });
      ids.set(r.campaign_id, row.id);
    }
    const rows: Prisma.AdInsightDailyCreateManyInput[] = [];
    for (const r of insights) {
      const campaignId = r.campaign_id ? ids.get(r.campaign_id) : undefined;
      const x = parseInsight(r, fields.currency);
      if (campaignId && x.date) rows.push({ ...x, spendMinor: BigInt(x.spendMinor), purchaseValueMinor: BigInt(x.purchaseValueMinor), campaignId });
    }

    const saved = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ads:' + acc.id}))`;
      await tx.adAccount.update({ where: { id: acc.id }, data: { ...fields, lastSyncAt: now, lastError: null, insightsFrom: acc.insightsFrom && acc.insightsFrom < since ? acc.insightsFrom : since } });
      await tx.adInsightDaily.deleteMany({ where: { campaign: { adAccountId: acc.id }, date: { gte: since, lte: today } } });
      if (rows.length) await tx.adInsightDaily.createMany({ data: rows, skipDuplicates: true });
      return { campaigns: camps.data.length, days: new Set(rows.map(r => r.date)).size };
    }, { timeout: 60_000 });

    const opened = await evaluateAlerts(db, pub, acc.id, now);
    // Close to Meta's limit: leave the account alone until the window resets.
    if (usage.pct >= 75 || usage.waitSec > 0) {
      await db.adAccount.update({ where: { id: acc.id }, data: { throttledUntil: new Date(now.getTime() + Math.max(usage.waitSec, 15 * 60) * 1000) } });
    }
    await pub.publish(acc.agencyId, { type: 'ads.synced', adAccountId: acc.id, clientId: acc.clientId });
    return { status: 'synced', ...saved, alertsOpened: opened };
  } catch (e) {
    if (e instanceof AdsGraphError && e.throttled) {
      const wait = Math.max(e.usage.waitSec, usage.waitSec, 10 * 60);
      await db.adAccount.update({ where: { id: acc.id }, data: { throttledUntil: new Date(now.getTime() + wait * 1000), lastError: 'ميتا طلبت نبطّأ الطلبات، هنحاول تاني بعد شوية' } });
      return { status: 'throttled' };
    }
    if (e instanceof AdsGraphError && e.auth) {
      await db.adAccount.update({ where: { id: acc.id }, data: { status: 'ERROR', lastError: `الربط وقف: ${e.message}`.slice(0, 500) } });
      await upsertAlert(db, pub, acc, 'ACCOUNT_PROBLEM', 'token', null, { reason: 'token', message: e.message.slice(0, 300) }, true);
      return { status: 'token_error', reason: e.message };
    }
    // Anything else (a Meta hiccup, a timeout, our database): note it; the job retries, and the next tick waits a full interval.
    await db.adAccount.update({ where: { id: acc.id }, data: { lastError: (e as Error).message.slice(0, 500) } }).catch(() => {});
    throw e;
  }
}

type AccountRef = { id: string; agencyId: string; clientId: string };
/** Opens an alert, or refreshes its detail. A dismissed alert stays dismissed while its problem lasts. */
async function upsertAlert(db: Db, pub: Publisher, acc: AccountRef, kind: Prisma.AdAlertCreateInput['kind'], objectKey: string, campaignId: string | null, detail: object, reopen = false) {
  const where = { adAccountId_kind_objectKey: { adAccountId: acc.id, kind, objectKey } };
  const existing = await db.adAlert.findUnique({ where });
  if (existing && !(reopen && existing.resolvedAt)) {
    await db.adAlert.update({ where, data: { detail: detail as Prisma.InputJsonValue } });
    return false;
  }
  await db.adAlert.upsert({ where, create: { agencyId: acc.agencyId, clientId: acc.clientId, adAccountId: acc.id, campaignId, kind, objectKey, detail: detail as Prisma.InputJsonValue }, update: { detail: detail as Prisma.InputJsonValue, resolvedAt: null, openedAt: new Date() } });
  await pub.publish(acc.agencyId, { type: 'ads.alert', clientId: acc.clientId, kind });
  return true;
}

/** Spending right now: running on Meta, switched on, and not past its end date (Meta leaves ended campaigns ACTIVE). */
export function isDelivering(c: { status: string; effectiveStatus: string; stopTime: Date | null }, now = new Date()) {
  return DELIVERING.has(c.effectiveStatus) && c.status !== 'PAUSED' && (!c.stopTime || c.stopTime > now);
}

/**
 * Turns the account's current state into alerts. Conditions (account problem, spending limit,
 * campaign issues, low lifetime budget) open while true and are deleted when they clear.
 * "Stopped" is a change: a campaign that was delivering when alerts were last checked and is not
 * now. The checked state is stored on the campaign, so a failed run is caught by the next one.
 */
export async function evaluateAlerts(db: Db, pub: Publisher, adAccountId: string, now = new Date()) {
  const acc = await db.adAccount.findUniqueOrThrow({ where: { id: adAccountId }, include: { campaigns: true } });
  const want = new Set<string>();
  let opened = 0;
  const open = async (kind: Prisma.AdAlertCreateInput['kind'], objectKey: string, campaignId: string | null, detail: object, reopen = false) => {
    want.add(`${kind}:${objectKey}`);
    if (await upsertAlert(db, pub, acc, kind, objectKey, campaignId, detail, reopen)) opened++;
  };

  if (acc.accountStatus !== 1) await open('ACCOUNT_PROBLEM', acc.id, null, { accountStatus: acc.accountStatus, disableReason: acc.disableReason });
  if (acc.spendCapMinor && acc.spendCapMinor > 0n && Number(acc.amountSpentMinor) >= Number(acc.spendCapMinor) * SPEND_CAP_WARN) {
    await open('SPEND_CAP_NEAR', acc.id, null, { spentMinor: Number(acc.amountSpentMinor), capMinor: Number(acc.spendCapMinor), currency: acc.currency });
  }
  for (const c of acc.campaigns) {
    const running = isDelivering(c, now);
    const label = running ? 'DELIVERING' : c.effectiveStatus;
    const removed = c.status === 'DELETED' || c.status === 'ARCHIVED'; // taken down on purpose: not a surprise stop
    if (c.checkedStatus === 'DELIVERING' && !running && c.effectiveStatus !== 'WITH_ISSUES' && !removed) {
      await open('CAMPAIGN_STOPPED', c.id, c.id, { name: c.name, to: c.stopTime && c.stopTime <= now ? 'ENDED' : c.effectiveStatus }, true);
    } else if (!running && !removed) {
      want.add(`CAMPAIGN_STOPPED:${c.id}`); // keep an existing one until the campaign runs again (or is removed)
    }
    if (c.checkedStatus !== label) await db.adCampaign.update({ where: { id: c.id }, data: { checkedStatus: label } });
    if (removed) continue;
    const issues = Array.isArray(c.issues) ? (c.issues as { error_summary?: string; error_message?: string }[]) : [];
    if (c.effectiveStatus === 'WITH_ISSUES' || (issues.length && c.status === 'ACTIVE')) {
      await open('CAMPAIGN_ISSUES', c.id, c.id, { name: c.name, summary: issues[0]?.error_summary ?? null, message: issues[0]?.error_message ?? null });
    }
    if (c.lifetimeBudgetMinor && c.budgetRemainingMinor !== null && running && Number(c.budgetRemainingMinor) <= Number(c.lifetimeBudgetMinor) * LIFETIME_LOW) {
      await open('BUDGET_LOW', c.id, c.id, { name: c.name, remainingMinor: Number(c.budgetRemainingMinor), lifetimeMinor: Number(c.lifetimeBudgetMinor), currency: acc.currency, stopTime: c.stopTime });
    }
  }
  const stale = (await db.adAlert.findMany({ where: { adAccountId }, select: { id: true, kind: true, objectKey: true } }))
    .filter(a => !want.has(`${a.kind}:${a.objectKey}`));
  if (stale.length) await db.adAlert.deleteMany({ where: { id: { in: stale.map(a => a.id) } } });
  return opened;
}

// ---------- Reading ----------

type Totals = { spendMinor: number; impressions: number; reach: number; linkClicks: number; messages: number; leads: number; purchases: number; purchaseValueMinor: number };
const zero = (): Totals => ({ spendMinor: 0, impressions: 0, reach: 0, linkClicks: 0, messages: 0, leads: 0, purchases: 0, purchaseValueMinor: 0 });
const TOTAL_KEYS = Object.keys(zero()) as (keyof Totals)[];
const add = (t: Totals, r: Record<keyof Totals, number | bigint>) => { for (const k of TOTAL_KEYS) t[k] += Number(r[k]); };

export type AdsCampaignRow = Omit<Totals, 'reach'> & {
  id: string; name: string; objective: string | null; status: string; effectiveStatus: string; delivering: boolean; currency: string; clientId: string; adAccountId: string;
  dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; budgetRemainingMinor: number | null; stopTime: string | null;
  result: ResultKind; results: number; costPerResultMinor: number | null;
};
/** Per result kind: what campaigns aiming at it spent and got, so "cost per message" divides message campaigns' spend only. */
export type AdsResultBlock = { spendMinor: number; results: number; costPerResultMinor: number | null; valueMinor: number };
export type AdsCurrencyBlock = { currency: string; totals: Omit<Totals, 'reach'>; byResult: Partial<Record<ResultKind, AdsResultBlock>>; daily: { day: string; spendMinor: number }[] };
export type AdsOverview = { from: string; to: string; currencies: AdsCurrencyBlock[]; campaigns: AdsCampaignRow[] };

const resultCount = (kind: ResultKind, t: Omit<Totals, 'reach'>) => t[kind];
/** Cost per result in minor units; impressions are priced per 1000 (CPM). */
export const costPer = (kind: ResultKind, spendMinor: number, n: number) => (n ? Math.round((spendMinor / n) * (kind === 'impressions' ? 1000 : 1)) : null);
const noReach = ({ reach: _r, ...t }: Totals) => t;

/**
 * Spend and results for a set of clients over [from, to] (days, inclusive, in each account's own
 * time zone). Money never mixes currencies: totals and the daily series come per currency.
 * Totals include every campaign; the list leaves out ones that neither spent nor run.
 */
export async function adsOverview(db: Db, o: { agencyId: string; clientIds: string[] | 'all'; from: string; to: string; now?: Date }): Promise<AdsOverview> {
  const now = o.now ?? new Date();
  const accountWhere = { agencyId: o.agencyId, ...(o.clientIds === 'all' ? {} : { clientId: { in: o.clientIds } }) };
  const campaigns = await db.adCampaign.findMany({
    where: { adAccount: accountWhere },
    select: { id: true, name: true, objective: true, status: true, effectiveStatus: true, dailyBudgetMinor: true, lifetimeBudgetMinor: true, budgetRemainingMinor: true, stopTime: true, adAccount: { select: { id: true, currency: true, clientId: true } } }
  });
  const days = await db.adInsightDaily.findMany({
    where: { campaignId: { in: campaigns.map(c => c.id) }, date: { gte: o.from, lte: o.to } },
    select: { campaignId: true, date: true, spendMinor: true, impressions: true, reach: true, linkClicks: true, messages: true, leads: true, purchases: true, purchaseValueMinor: true }
  });
  const perCampaign = new Map<string, Totals>();
  for (const d of days) { let t = perCampaign.get(d.campaignId); if (!t) perCampaign.set(d.campaignId, (t = zero())); add(t, d); }
  const num = (v: bigint | null) => (v === null ? null : Number(v));

  const all: AdsCampaignRow[] = campaigns.map(c => {
    const t = noReach(perCampaign.get(c.id) ?? zero());
    const result = resultKind(c.objective, t);
    const results = resultCount(result, t);
    return {
      id: c.id, name: c.name, objective: c.objective, status: c.status, effectiveStatus: c.effectiveStatus, delivering: isDelivering(c, now),
      currency: c.adAccount.currency, clientId: c.adAccount.clientId, adAccountId: c.adAccount.id,
      dailyBudgetMinor: num(c.dailyBudgetMinor), lifetimeBudgetMinor: num(c.lifetimeBudgetMinor), budgetRemainingMinor: num(c.budgetRemainingMinor), stopTime: c.stopTime?.toISOString() ?? null,
      ...t, result, results, costPerResultMinor: costPer(result, t.spendMinor, results)
    };
  });
  const byCampaign = new Map(all.map(r => [r.id, r]));

  const blocks = new Map<string, AdsCurrencyBlock & { dayMap: Map<string, number> }>();
  const block = (currency: string) => {
    let b = blocks.get(currency);
    if (!b) blocks.set(currency, (b = { currency, totals: noReach(zero()), byResult: {}, daily: [], dayMap: new Map() }));
    return b;
  };
  for (const r of all) {
    if (!r.spendMinor && !r.results) continue;
    const b = block(r.currency);
    add(b.totals as Totals, { ...r, reach: 0 });
    const g = (b.byResult[r.result] ??= { spendMinor: 0, results: 0, costPerResultMinor: null, valueMinor: 0 });
    g.spendMinor += r.spendMinor; g.results += r.results; g.valueMinor += r.purchaseValueMinor;
  }
  for (const d of days) {
    const r = byCampaign.get(d.campaignId);
    if (!r) continue;
    const b = block(r.currency);
    b.dayMap.set(d.date, (b.dayMap.get(d.date) ?? 0) + Number(d.spendMinor));
  }
  const currencies = [...blocks.values()].map(b => {
    for (const [k, g] of Object.entries(b.byResult) as [ResultKind, AdsResultBlock][]) g.costPerResultMinor = costPer(k, g.spendMinor, g.results);
    const daily: AdsCurrencyBlock['daily'] = [];
    for (let day = o.from; day <= o.to; day = addDays(day, 1)) daily.push({ day, spendMinor: b.dayMap.get(day) ?? 0 });
    return { currency: b.currency, totals: b.totals, byResult: b.byResult, daily };
  }).sort((a, b) => b.totals.spendMinor - a.totals.spendMinor);
  const campaignsShown = all.filter(r => r.spendMinor > 0 || r.delivering || r.effectiveStatus === 'WITH_ISSUES').sort((a, b) => b.spendMinor - a.spendMinor);
  return { from: o.from, to: o.to, currencies, campaigns: campaignsShown };
}

/** Accounts due for a sync: connected, not throttled, and neither read nor tried in the last 15 minutes. */
export function adAccountsDue(db: Db, now = new Date()) {
  const before = new Date(now.getTime() - ADS_SYNC_EVERY_MS + 30_000);
  return db.adAccount.findMany({
    where: {
      status: 'CONNECTED',
      AND: [
        { OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: before } }] },
        { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: before } }] },
        { OR: [{ throttledUntil: null }, { throttledUntil: { lt: now } }] }
      ]
    },
    select: { id: true }, take: 500, orderBy: { lastSyncAt: { sort: 'asc', nulls: 'first' } }
  });
}
