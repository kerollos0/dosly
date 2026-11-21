import { z } from 'zod';

/**
 * WhatsApp broadcasts (حملات واتساب): one approved template to many customers of a client.
 * Rules followed (WhatsApp Business Platform docs, 2025-2026):
 * - Only approved templates can start a conversation; only people who agreed to hear from the business.
 * - Marketing messages are capped per person by Meta (error 131049: don't retry within 24h);
 *   131050 means the person stopped marketing messages from this business, so we never send them offers again.
 * - Throughput is 80 messages/second per number by default; 130429 / 131056 mean slow down and retry.
 * - Business-initiated messages to new people per 24h are limited per business portfolio
 *   (250 unverified, then 2K, 10K, 100K, unlimited).
 */

export const BROADCAST_AUDIENCES = ['all', 'recent', 'from_ad', 'buyers', 'no_order'] as const;
export type BroadcastAudienceKind = (typeof BROADCAST_AUDIENCES)[number];

export const broadcastAudienceSchema = z.object({
  kind: z.enum(BROADCAST_AUDIENCES),
  /** "recent": wrote within this many days. */
  days: z.number().int().min(1).max(365).optional()
});
export type BroadcastAudience = z.infer<typeof broadcastAudienceSchema>;

export const BROADCAST_AUDIENCE_AR: Record<BroadcastAudienceKind, string> = {
  all: 'كل اللي كلموا الرقم ده',
  recent: 'اللي كلموا الرقم ده مؤخرًا',
  from_ad: 'اللي جم من إعلان',
  buyers: 'اللي اشتروا قبل كده',
  no_order: 'اللي كلموا ومطلبوش لسه'
};

/** Typed in a template field, it becomes each customer's first name. */
export const NAME_TOKEN = '[الاسم]';
export const NAME_FALLBACK = 'حضرتك';
export const firstNameOf = (name: string | null | undefined) => {
  const n = (name ?? '').trim().split(/\s+/)[0] ?? '';
  // WhatsApp profile names are sometimes emoji or a phone number; those read badly in "أهلاً ...".
  return n && /\p{L}/u.test(n) && n.length <= 30 ? n : NAME_FALLBACK;
};
export const fillName = (v: string, name: string | null | undefined) => v.split(NAME_TOKEN).join(firstNameOf(name));

/**
 * Approximate Meta price per delivered template message in Egypt, in US cents (third-party rate cards,
 * effective July 2026; Meta bills in USD and adds VAT). Shown to the agency only as an estimate.
 */
export const EG_PRICE_CENTS: Record<string, number> = { MARKETING: 6.44, UTILITY: 0.36, AUTHENTICATION: 0.36 };
export function estimateCostUsd(category: string, people: number) {
  return Math.round((EG_PRICE_CENTS[category] ?? EG_PRICE_CENTS.MARKETING!) * people) / 100;
}

/** New senders start at 250 people a day until the business is verified. */
export const UNVERIFIED_DAILY_LIMIT = 250;
export const BROADCAST_MAX_RECIPIENTS = 50_000;

/** "I don't want offers": the customer's words or the template's stop button. */
/** Unmistakable: always means "no more offers". */
const CLEAR_STOP = ['إيقاف العروض', 'إلغاء الاشتراك', 'unsubscribe', 'stop promotions', 'مش عايز رسايل', 'مش عايزة رسايل', 'مش عايز عروض', 'مش عايزة عروض', 'بطلوا رسايل', 'بطلوا تبعتولي', 'وقفوا الرسايل', 'إيقاف الرسائل', 'إيقاف'];
/** Short words that could also be about an order ("وقف الطلب"): an opt-out only right after an offer. */
const SHORT_STOP = ['وقف', 'stop', 'كفاية', 'الغاء'];
const norm = (s: string) => s.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ');
const CLEAR = new Set(CLEAR_STOP.map(norm));
const SHORT = new Set(SHORT_STOP.map(norm));
/** "clear" (always an opt-out), "short" (only right after an offer), or false. The whole message must be the stop phrase. */
export function isStopRequest(text: string | null | undefined): 'clear' | 'short' | false {
  if (!text) return false;
  const t = norm(text);
  if (t.length > 40) return false;
  return CLEAR.has(t) ? 'clear' : SHORT.has(t) ? 'short' : false;
}

/** Plain-Arabic reason for a message WhatsApp did not deliver, from Meta's error code. */
export function broadcastErrorAr(code: number | null | undefined, fallback?: string | null) {
  switch (code) {
    case 131049: return 'واتساب منعها عشان الشخص ده وصله عروض كتير مؤخرًا. متبعتلوش تاني قبل يوم.';
    case 131050: return 'الشخص ده وقف رسايل العروض من البيزنس.';
    case 131026: return 'الرقم ده مش عليه واتساب، أو مش قادر يستقبل الرسالة.';
    case 131047: return 'محتاج قالب متوافق عليه، الرسالة العادية مش مسموحة.';
    case 132000: case 132018: return 'خانات القالب مش مظبوطة.';
    case 132001: return 'القالب مش موجود أو اتغيّر في ميتا.';
    case 132015: case 132016: return 'ميتا وقفت القالب ده بسبب شكاوى أو جودة ضعيفة.';
    case 131048: return 'ميتا قللت الإرسال من الرقم ده بسبب شكاوى سبام.';
    case 130429: case 131056: return 'الإرسال كان أسرع من المسموح، واتعاد كذا مرة ومنفعش.';
    case 368: return 'الرقم ده متوقف مؤقتًا من ميتا.';
    default: return fallback ? `واتساب رفضها: ${fallback}`.slice(0, 300) : 'واتساب رفض الرسالة.';
  }
}

/** Pulls Meta's numeric code out of a stored error such as "131049: This message was not delivered...". */
export const errorCodeOf = (error: string | null | undefined) => {
  const m = error?.match(/^(\d{3,6})\b/);
  return m ? Number(m[1]) : null;
};
