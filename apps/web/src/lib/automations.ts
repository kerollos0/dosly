/** Automatic replies as the API returns them. Mirrors autoRuleSchema in @dosly/shared (the API validates). */
export type AutoKind = 'WELCOME' | 'AWAY' | 'KEYWORD' | 'COMMENT';
export type ChatChannel = 'WHATSAPP' | 'MESSENGER' | 'INSTAGRAM';
export type Platform = 'FACEBOOK_PAGE' | 'INSTAGRAM';
export type Hours = { days: number[]; from: string; to: string };
export type AutoRule = {
  id: string; clientId: string; kind: AutoKind; name: string | null; enabled: boolean;
  channels: ChatChannel[]; platforms: Platform[]; keywords: string[]; postExternalId: string | null; postLabel: string | null;
  reply: string | null; publicReplies: string[]; hours: Hours | null;
  fired: number; lastFiredAt: string | null; lastError: string | null; createdAt: string;
};
export type AutoClient = { id: string; name: string; channels: ChatChannel[]; platforms: Platform[]; active: number };
export type AutoPost = { externalId: string; platform: Platform; caption: string; image: string | null; publishedAt: string | null };

export const CHANNEL_LABEL: Record<ChatChannel, string> = { WHATSAPP: 'واتساب', MESSENGER: 'ماسنجر', INSTAGRAM: 'إنستجرام' };
export const PLATFORM_LABEL: Record<Platform, string> = { FACEBOOK_PAGE: 'فيسبوك', INSTAGRAM: 'إنستجرام' };
export const DAYS = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
export const NAME_TOKEN = '[الاسم]';

/** "بكام، السعر, price" → ['بكام', 'السعر', 'price']. */
export const splitWords = (s: string) => [...new Set(s.split(/[,،؛;\n]/).map(x => x.trim()).filter(Boolean))];

/** "الأحد لـ الخميس" for a run of days, else a list. */
export function daysLabel(days: number[]) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'كل يوم';
  // A run may wrap past Saturday: Saturday to Thursday is the usual Egyptian week.
  if (d.length > 2) {
    for (const start of d) {
      if (d.includes((start + 6) % 7)) continue;
      const run = d.map((_, i) => (start + i) % 7);
      if (run.every(x => d.includes(x))) return `من ${DAYS[start]} لـ${DAYS[run.at(-1)!]}`;
    }
  }
  return d.map(x => DAYS[x]).join('، ');
}

/** "10:00" → "10 الصبح", "22:30" → "10:30 بالليل". */
export function timeLabel(hm: string) {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  const h12 = h % 12 || 12;
  const part = h < 4 ? 'بالليل' : h < 6 ? 'الفجر' : h < 12 ? 'الصبح' : h < 15 ? 'الضهر' : h < 18 ? 'العصر' : 'بالليل';
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${part}`;
}

export const timesLabel = (n: number) => (n === 0 ? 'لسه ما اشتغلش' : n === 1 ? 'اشتغل مرة واحدة' : n === 2 ? 'اشتغل مرتين' : n <= 10 ? `اشتغل ${n} مرات` : `اشتغل ${n} مرة`);

/** Half-hour steps for the working-hours pickers (the browser's own time box shows English AM/PM). */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
