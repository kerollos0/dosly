import { describe, expect, it } from 'vitest';
import { AdsGraphError, adsGraphAll, currencyOffset, demoAdsGraph, normalizeAdAccountId, parseAdsUsage, parseInsight, resultKind, toMinor } from '../src/index.js';

describe('ads helpers', () => {
  it('converts whole-unit spend to minor units by the currency offset', () => {
    expect(currencyOffset('EGP')).toBe(100);
    expect(currencyOffset('JPY')).toBe(1);
    expect(toMinor('2352.45', 'EGP')).toBe(235245);
    expect(toMinor(2352.45, 'USD')).toBe(235245);
    expect(toMinor('1500', 'JPY')).toBe(1500);
    expect(toMinor(undefined, 'EGP')).toBe(0);
  });

  it('normalizes ad account ids', () => {
    expect(normalizeAdAccountId('act_1234567')).toBe('1234567');
    expect(normalizeAdAccountId(' 1234567 ')).toBe('1234567');
    expect(normalizeAdAccountId('act_12ab')).toBeNull();
  });

  it('counts each result once even when Meta reports it under several action types', () => {
    const r = parseInsight({
      date_start: '2026-11-01', spend: '100.50', impressions: '1000', reach: 800, inline_link_clicks: '12',
      actions: [
        { action_type: 'omni_purchase', value: '3' }, { action_type: 'purchase', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
        { action_type: 'lead', value: 2 }, { action_type: 'onsite_conversion.lead_grouped', value: '2' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '7' }
      ],
      action_values: [{ action_type: 'omni_purchase', value: '3600.00' }, { action_type: 'purchase', value: '3600.00' }]
    }, 'EGP');
    expect(r).toEqual({ date: '2026-11-01', spendMinor: 10050, impressions: 1000, reach: 800, linkClicks: 12, messages: 7, leads: 2, purchases: 3, purchaseValueMinor: 360000 });
  });

  it('picks the result by objective, falling back to messages for click-to-message sales campaigns', () => {
    expect(resultKind('OUTCOME_SALES', { messages: 5, leads: 0, purchases: 2 })).toBe('purchases');
    expect(resultKind('OUTCOME_SALES', { messages: 5, leads: 0, purchases: 0 })).toBe('messages');
    expect(resultKind('OUTCOME_LEADS', { messages: 0, leads: 0, purchases: 0 })).toBe('leads');
    expect(resultKind('OUTCOME_TRAFFIC', { messages: 5, leads: 0, purchases: 0 })).toBe('linkClicks');
    expect(resultKind('OUTCOME_ENGAGEMENT', { messages: 5, leads: 0, purchases: 0 })).toBe('messages');
    expect(resultKind('OUTCOME_AWARENESS', { messages: 0, leads: 0, purchases: 0 })).toBe('impressions');
    expect(resultKind('LINK_CLICKS', { messages: 0, leads: 0, purchases: 0 })).toBe('linkClicks'); // pre-v17 objective
  });

  it('reads the worst usage figure from the three rate-limit headers', () => {
    const h = new Headers({
      'x-business-use-case-usage': JSON.stringify({ '123': [{ type: 'ads_insights', call_count: 40, total_cputime: 91, total_time: 20, estimated_time_to_regain_access: 3 }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 10, reset_time_duration: 0 }),
      'x-fb-ads-insights-throttle': JSON.stringify({ app_id_util_pct: 5, acc_id_util_pct: 12 })
    });
    expect(parseAdsUsage(h)).toEqual({ pct: 91, waitSec: 180 });
    expect(parseAdsUsage(new Headers({ 'x-ad-account-usage': 'not json' }))).toEqual({ pct: 0, waitSec: 0 });
  });

  it('classifies Meta errors', () => {
    const e = (code: number, sub?: number) => new AdsGraphError('x', 400, code, sub, { pct: 0, waitSec: 0 });
    expect(e(17, 2446079).throttled).toBe(true);
    expect(e(80004).throttled).toBe(true);
    expect(e(4, 1504022).throttled).toBe(true);
    expect(e(190).auth).toBe(true);
    expect(e(200).auth).toBe(true);
    expect(e(100, 1504018).tooBig).toBe(true);
    expect(e(100).tooBig).toBe(false);
    expect(e(100, 1487534).tooBig).toBe(true);
    expect(new AdsGraphError('Please reduce the amount of data you\'re asking for, then retry your request', 500, 1, undefined, { pct: 0, waitSec: 0 }).tooBig).toBe(true);
    expect(e(100, 33).auth).toBe(true);
    expect(e(100, 33).throttled).toBe(false);
  });

  it('follows paging cursors', async () => {
    const f = (async (u: string) => demoAdsGraph(new URL(u), new Date('2026-11-20T12:00:00Z'))!) as typeof fetch;
    const r = await adsGraphAll<{ date_start: string }>(`act_1234561/insights?level=campaign&time_increment=1&time_range=${encodeURIComponent(JSON.stringify({ since: '2026-08-23', until: '2026-11-20' }))}`, 't', f);
    expect(r.data.length).toBeGreaterThan(100); // more than one demo page
    expect(new Set(r.data.map(d => d.date_start)).size).toBeGreaterThan(80);
  });
});
