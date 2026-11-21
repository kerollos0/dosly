import { z } from 'zod';

/**
 * Automatic replies (ردود تلقائية), per client.
 * Rules followed (Meta docs, 2025-2026):
 * - Chats: a reply is only sent right after the customer wrote, so it is always inside the 24h window.
 * - Comments: one private message per comment, within 7 days of it (Messenger and Instagram private replies).
 *   Instagram allows 750 private replies per hour per account; we stay far below with one per person per post.
 * - Bots answering bots loop forever: at most one automatic reply per chat every 2 minutes,
 *   and none while a person from the team is talking to the customer.
 */

export const AUTO_KINDS = ['WELCOME', 'AWAY', 'KEYWORD', 'COMMENT'] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
export const AUTO_CHANNELS = ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'] as const;
export const AUTO_PLATFORMS = ['FACEBOOK_PAGE', 'INSTAGRAM'] as const;

/** No automatic reply while a person from the team wrote in the chat within this time. */
export const HUMAN_PAUSE_MS = 30 * 60_000;
/** At most one automatic reply per chat in this time. */
export const AUTO_GAP_MS = 2 * 60_000;
/** The "we're closed" message goes to the same person at most once in this time. */
export const AWAY_GAP_MS = 12 * 3600_000;
export const MAX_KEYWORDS = 20;
export const MAX_PUBLIC_REPLIES = 5;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'الوقت لازم يكون زي 10:00');
export const hoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1, 'اختار يوم واحد على الأقل').max(7),
  from: time,
  to: time
}).refine(h => h.from !== h.to, { message: 'وقت البداية والنهاية زي بعض' });
export type WorkHours = z.infer<typeof hoursSchema>;

const text = (max: number) => z.string().trim().min(1, 'اكتب الرد').max(max, 'الرد طويل، قصّره شوية');
const keywords = z.array(z.string().trim().min(1).max(60, 'في كلمة طويلة أوي، خليها أقل من 60 حرف').refine(k => normalizeAr(k).length > 0, 'الكلمة لازم يكون فيها حروف أو أرقام، مش إيموجي بس')).max(MAX_KEYWORDS, `بحد أقصى ${MAX_KEYWORDS} كلمة`);

/** What the agency fills in for each kind. Text limits: Instagram DMs are 1000 characters, so chat replies stay under it. */
export const autoRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('WELCOME'), channels: z.array(z.enum(AUTO_CHANNELS)).min(1, 'اختار قناة واحدة على الأقل'), reply: text(1000) }),
  z.object({ kind: z.literal('AWAY'), channels: z.array(z.enum(AUTO_CHANNELS)).min(1, 'اختار قناة واحدة على الأقل'), reply: text(1000), hours: hoursSchema }),
  z.object({ kind: z.literal('KEYWORD'), name: z.string().trim().max(80).optional(), channels: z.array(z.enum(AUTO_CHANNELS)).min(1, 'اختار قناة واحدة على الأقل'), keywords: keywords.min(1, 'اكتب كلمة واحدة على الأقل'), reply: text(1000) }),
  z.object({
    kind: z.literal('COMMENT'), name: z.string().trim().max(80).optional(), platforms: z.array(z.enum(AUTO_PLATFORMS)).min(1, 'اختار فيسبوك أو إنستجرام'),
    keywords, postExternalId: z.string().max(200).nullable().optional(), postLabel: z.string().max(200).nullable().optional(),
    publicReplies: z.array(z.string().trim().min(1).max(2200, 'الرد تحت الكومنت طويل، قصّره شوية')).max(MAX_PUBLIC_REPLIES, `بحد أقصى ${MAX_PUBLIC_REPLIES} ردود تحت الكومنت`), reply: z.string().trim().max(1000, 'الرسالة طويلة، قصّرها شوية').optional()
  }).refine(r => r.publicReplies.length > 0 || !!r.reply, { message: 'اكتب رد تحت الكومنت أو رسالة في الخاص', path: ['reply'] })
]);
export type AutoRuleInput = z.infer<typeof autoRuleSchema>;

/** Arabic written loosely: hamza forms, ta marbuta, alef maqsura, Persian letters, diacritics, tatweel, Arabic digits, case, stretched letters. */
export function normalizeAr(s: string) {
  return s.toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/[ىیي]/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ک/g, 'ك')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1') // "بكاااام" → "بكام"
    .replace(/\s+/g, ' ').trim();
}

/** Letters Arabic glues to the front of a word ("وبكام", "بالسعر", "للتوصيل"), longest first. */
const PREFIXES = ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ب', 'ف', 'ك', 'ل'];
/** Endings that keep the meaning ("سعره", "سعرها", "عنوانكم"). Plurals like "ات" are left out on purpose: "سعرات" is not "سعر". */
const SUFFIXES = ['', 'ه', 'ها', 'هم', 'ك', 'كم', 'ي', 'نا'];
const stems = (w: string) => [w, ...PREFIXES.filter(p => w.startsWith(p) && w.length - p.length >= 2).map(p => w.slice(p.length))];
const bareKeyword = (k: string) => (k.startsWith('ال') && k.length > 3 ? k.slice(2) : k);

/**
 * The first keyword found in the text, or null. Single words match whole words, with the usual Arabic
 * prefixes and possessive endings allowed ("وبكام" has "بكام", "كامل" does not have "كام"); phrases match as phrases.
 */
export function matchKeyword(text: string | null | undefined, words: string[]): string | null {
  if (!text) return null;
  const t = normalizeAr(text);
  if (!t) return null;
  const tokens = t.split(' ');
  for (const w of words) {
    const k = normalizeAr(w);
    if (!k) continue;
    if (k.includes(' ')) { if (` ${t} `.includes(` ${k} `) || ` ${t} `.includes(` ال${k} `)) return w; continue; }
    const targets = new Set([k, bareKeyword(k)]);
    if (tokens.some(tok => stems(tok).some(st => [...targets].some(kw => SUFFIXES.some(sf => st === kw + sf))))) return w;
  }
  return null;
}

/** Day (Sunday = 0) and minutes since midnight in Cairo (Egypt moves its clock in summer). */
export function cairoNow(at: Date) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => p.find(x => x.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Open now? A shift past midnight ("18:00" to "02:00") belongs to the day it started. */
export function isOpen(h: WorkHours, at: Date) {
  const { day, minutes } = cairoNow(at);
  const from = mins(h.from), to = mins(h.to);
  if (from < to) return h.days.includes(day) && minutes >= from && minutes < to;
  return (h.days.includes(day) && minutes >= from) || (h.days.includes((day + 6) % 7) && minutes < to);
}

export const DAY_NAMES_AR = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
