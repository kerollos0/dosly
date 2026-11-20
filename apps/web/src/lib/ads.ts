/** Ads types and formatting. Money arrives in the currency's minor unit (Meta's offset: 100 for EGP and USD). */

export type AdTotals = { spendMinor: number; impressions: number; linkClicks: number; messages: number; leads: number; purchases: number; purchaseValueMinor: number };
export type ResultKind = 'messages' | 'leads' | 'purchases' | 'linkClicks' | 'impressions';
export type AdCampaign = AdTotals & {
  id: string; name: string; objective: string | null; status: string; effectiveStatus: string; delivering: boolean; currency: string; clientId: string; adAccountId: string;
  dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; budgetRemainingMinor: number | null; stopTime: string | null;
  result: ResultKind; results: number; costPerResultMinor: number | null;
};
/** The slimmer campaign rows the client report carries. */
export type ReportCampaign = Pick<AdCampaign, 'id' | 'name' | 'objective' | 'currency' | 'spendMinor' | 'result' | 'results' | 'costPerResultMinor' | 'purchaseValueMinor'>;
export type AdResultBlock = { spendMinor: number; results: number; costPerResultMinor: number | null; valueMinor: number };
export type AdCurrencyBlock = { currency: string; totals: AdTotals; byResult: Partial<Record<ResultKind, AdResultBlock>>; daily: { day: string; spendMinor: number }[] };
export type AdsOverview = { from: string; to: string; currencies: AdCurrencyBlock[]; campaigns: AdCampaign[]; accounts: number; accountsWithErrors: number; syncedAt: string | null };
export type AdAccount = {
  id: string; clientId: string; externalId: string; name: string; currency: string; timezoneName: string; accountStatus: number; disableReason: number;
  spendCapMinor: number | null; amountSpentMinor: number | null; status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR'; lastError: string | null; lastSyncAt: string | null; throttledUntil: string | null;
};
export type AdAlertKind = 'ACCOUNT_PROBLEM' | 'SPEND_CAP_NEAR' | 'CAMPAIGN_ISSUES' | 'CAMPAIGN_STOPPED' | 'BUDGET_LOW';
export type AdAlert = {
  id: string; kind: AdAlertKind; openedAt: string; clientId: string; campaignId: string | null;
  detail: Record<string, unknown> | null;
  adAccount: { id: string; name: string; currency: string; accountStatus: number; status: string };
};

const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
const offset = (c: string) => (OFFSET_ONE.has(c) ? 1 : 100);
export const nf = new Intl.NumberFormat('ar-EG-u-nu-latn');
const pf = new Intl.NumberFormat('ar-EG-u-nu-latn', { style: 'percent', maximumFractionDigits: 2 });
export const percent = (ratio: number) => `\u2068${pf.format(ratio)}\u2069`;
/** Words people say, instead of currency codes. */
const CURRENCY_WORD: Record<string, string> = { EGP: 'جنيه', USD: 'دولار', SAR: 'ريال', AED: 'درهم', EUR: 'يورو' };
export const CURRENCY_NAME: Record<string, string> = { EGP: 'بالجنيه المصري', USD: 'بالدولار', SAR: 'بالريال السعودي', AED: 'بالدرهم الإماراتي', EUR: 'باليورو' };
export const currencyWord = (c: string) => CURRENCY_WORD[c] ?? c;
const nfCache = new Map<string, Intl.NumberFormat>();

/**
 * "1,234 جنيه", with piasters/cents only for small amounts. Wrapped in bidi isolates so it reads
 * right inside an Arabic sentence.
 */
export function money(minor: number | null | undefined, currency: string) {
  if (minor === null || minor === undefined) return '—';
  const v = minor / offset(currency);
  const digits = Math.abs(v) < 100 && offset(currency) > 1 && !Number.isInteger(v) ? 2 : 0;
  let f = nfCache.get(String(digits));
  if (!f) { f = new Intl.NumberFormat('ar-EG-u-nu-latn', { minimumFractionDigits: digits, maximumFractionDigits: digits }); nfCache.set(String(digits), f); }
  return `\u2068${f.format(v)} ${currencyWord(currency)}\u2069`;
}

/** Egyptian Arabic counting: 1 and 2 have their own words, 3 to 10 take the plural, 11 and up the singular. */
const WORDS: Record<ResultKind, [one: string, two: string, few: string, many: string]> = {
  messages: ['محادثة واحدة', 'محادثتين', 'محادثات', 'محادثة'],
  leads: ['عميل محتمل واحد', 'عميلين محتملين', 'عملاء محتملين', 'عميل محتمل'],
  purchases: ['عملية شراء واحدة', 'عمليتين شراء', 'عمليات شراء', 'عملية شراء'],
  linkClicks: ['ضغطة واحدة', 'ضغطتين', 'ضغطات', 'ضغطة'],
  impressions: ['مرة ظهور واحدة', 'مرتين ظهور', 'مرات ظهور', 'مرة ظهور']
};
export function countLabel(n: number, kind: ResultKind) {
  const w = WORDS[kind];
  if (n === 1) return w[0];
  if (n === 2) return w[1];
  const last = n % 100;
  return `${nf.format(n)} ${last >= 3 && last <= 10 ? w[2] : w[3]}`;
}
export const COST_LABEL: Record<ResultKind, string> = { messages: 'للمحادثة', leads: 'للعميل المحتمل', purchases: 'لعملية الشراء', linkClicks: 'للضغطة', impressions: 'لكل 1000 مرة ظهور' };
export const RESULT_TITLE: Record<ResultKind, string> = { messages: 'محادثات جديدة', leads: 'عملاء محتملين', purchases: 'عمليات شراء', linkClicks: 'ضغطات على اللينك', impressions: 'مرات ظهور' };

export const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_AWARENESS: 'الوعي', OUTCOME_TRAFFIC: 'الزيارات', OUTCOME_ENGAGEMENT: 'التفاعل والرسايل',
  OUTCOME_LEADS: 'العملاء المحتملين', OUTCOME_SALES: 'المبيعات', OUTCOME_APP_PROMOTION: 'التطبيقات'
};

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: 'good' | 'bad' | 'warn' | 'info' | 'neutral' }> = {
  ACTIVE: { label: 'شغالة', tone: 'good' },
  IN_PROCESS: { label: 'بتتعدّل', tone: 'info' },
  PAUSED: { label: 'متوقفة', tone: 'neutral' },
  CAMPAIGN_PAUSED: { label: 'متوقفة', tone: 'neutral' },
  WITH_ISSUES: { label: 'واقفة: فيها مشكلة', tone: 'bad' },
  ARCHIVED: { label: 'متأرشفة', tone: 'neutral' },
  DELETED: { label: 'اتمسحت', tone: 'neutral' }
};

export const ACCOUNT_STATUS: Record<number, string> = {
  1: 'شغال', 2: 'موقوف من ميتا', 3: 'عليه فلوس متأخرة', 7: 'تحت مراجعة', 8: 'مستني تسوية الدفع', 9: 'في فترة سماح', 100: 'بيتقفل', 101: 'مقفول'
};

/** One sentence per alert, written for the person who has to act on it. */
export function alertText(a: AdAlert): { title: string; body: string } {
  const d = (a.detail ?? {}) as Record<string, unknown>;
  const name = typeof d.name === 'string' ? `«${d.name}»` : '';
  switch (a.kind) {
    case 'ACCOUNT_PROBLEM':
      if (d.reason === 'token') return { title: 'الربط بالحساب وقف', body: 'مش هنقدر نجيب أرقام جديدة لحد ما الحساب يتربط تاني بمفتاح جديد من صفحة القنوات. الإعلانات نفسها شغالة عادي في ميتا.' };
      return { title: `الحساب الإعلاني ${ACCOUNT_STATUS[Number(d.accountStatus)] ?? 'فيه مشكلة'}`, body: Number(d.accountStatus) === 3 || Number(d.accountStatus) === 8 || Number(d.accountStatus) === 9
        ? 'الإعلانات مش هتشتغل لحد ما الفاتورة تتدفع. راجع وسيلة الدفع في Ads Manager.'
        : 'الإعلانات واقفة على الحساب ده. افتح Account Quality في ميتا وشوف السبب.' };
    case 'SPEND_CAP_NEAR': {
      const pct = Number(d.capMinor) ? Math.round((Number(d.spentMinor) / Number(d.capMinor)) * 100) : 0;
      return { title: `حد الصرف قرّب يخلص (${percent(pct / 100)})`, body: `اتصرف ${money(Number(d.spentMinor), a.adAccount.currency)} من حد ${money(Number(d.capMinor), a.adAccount.currency)}، ولما يوصل للحد كل الحملات هتقف. ارفع الحد من إعدادات الدفع في Ads Manager لو محتاجين نكمل.` };
    }
    case 'CAMPAIGN_ISSUES':
      return { title: `الحملة ${name} واقفة بسبب مشكلة`, body: typeof d.summary === 'string' ? `ميتا بتقول: ${d.summary}` : 'ميتا وقفت توصيل الحملة. افتحها في Ads Manager وشوف التفاصيل.' };
    case 'CAMPAIGN_STOPPED':
      return { title: `الحملة ${name} وقفت`, body: d.to === 'ENDED' ? 'وصلت لتاريخ نهايتها. لو محتاجين نكمل، مدّد الحملة من Ads Manager.' : 'كانت شغالة في آخر مرة شيكنا ودلوقتي مش بتصرف. لو حد وقفها بقصد، اقفل التنبيه.' };
    case 'BUDGET_LOW':
      return { title: `ميزانية ${name} قرّبت تخلص`, body: `باقي ${money(Number(d.remainingMinor), a.adAccount.currency)} من ميزانية ${money(Number(d.lifetimeMinor), a.adAccount.currency)}، فالحملة هتقف قريب لو مزوّدناش الميزانية.` };
  }
}

export const dayLabel = (day: string) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
