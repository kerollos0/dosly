/**
 * Dates the way people say them in Egypt: "بكرة الساعة 7 بالليل", "الخميس 12 ديسمبر الساعة 10:30 الصبح".
 * Always in Cairo time: the business is in Egypt, even when the owner opens the page while travelling.
 */
const TZ = 'Africa/Cairo';
const WEEKDAY = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long', timeZone: TZ });
const DAY_MONTH = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', timeZone: TZ });
const PARTS = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

function cairo(d: Date) {
  const p = Object.fromEntries(PARTS.formatToParts(d).map(x => [x.type, x.value]));
  return { day: Date.UTC(+p.year!, +p.month! - 1, +p.day!), hour: +p.hour! % 24, minute: +p.minute! };
}

export function dayWord(date: Date, now = new Date()) {
  const diff = Math.round((cairo(date).day - cairo(now).day) / 86_400_000);
  if (diff === 0) return 'النهارده';
  if (diff === 1) return 'بكرة';
  if (diff === -1) return 'امبارح';
  // Within the coming week the weekday is enough; further out people want the date too.
  if (diff > 1 && diff < 7) return WEEKDAY.format(date);
  return `${WEEKDAY.format(date)} ${DAY_MONTH.format(date)}`;
}

export function timeWord(date: Date) {
  const { hour: h, minute: m } = cairo(date);
  const h12 = h % 12 || 12;
  const part = h < 5 ? 'بالليل' : h < 12 ? 'الصبح' : h < 15 ? 'الضهر' : h < 18 ? 'العصر' : 'بالليل';
  return `الساعة ${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${part}`;
}

export const when = (iso: string, now = new Date()) => { const d = new Date(iso); return `${dayWord(d, now)} ${timeWord(d)}`; };

/** "فيسبوك وإنستجرام" */
export function joinAnd(items: string[]) {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join('، ')} و${items.at(-1)}`;
}

/** Egyptian counting: 1 and 2 have their own words, 3 to 10 take the plural, 11 and up the singular. */
export function count(n: number, one: string, two: string, few: string, many: string) {
  if (n === 1) return one;
  if (n === 2) return two;
  const last = n % 100;
  return `${new Intl.NumberFormat('ar-EG-u-nu-latn').format(n)} ${last >= 3 && last <= 10 ? few : many}`;
}
