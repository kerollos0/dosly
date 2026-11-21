import type { TemplateShape } from './api';

/** WhatsApp broadcasts: types and plain-Arabic labels. Rules live in packages/shared/src/broadcast.ts. */

export type AudienceKind = 'all' | 'recent' | 'from_ad' | 'buyers' | 'no_order';
export type Audience = { kind: AudienceKind; days?: number };
export type BroadcastStats = {
  total: number; pending: number; sent: number; delivered: number; read: number; replied: number; failed: number; skipped: number;
  orders: number; sales: { currency: string; minor: number }[];
};
export type Broadcast = {
  id: string; clientId: string; waNumberId: string; name: string; templateName: string; language: string; category: string; audience: Audience;
  status: 'SCHEDULED' | 'SENDING' | 'DONE' | 'CANCELLED'; scheduledAt: string; startedAt: string | null; finishedAt: string | null; total: number; createdAt: string;
  client: { name: string }; waNumber: { displayPhone: string }; createdBy: { name: string } | null; hasHeader: boolean;
  preview: { header?: string; body: string; footer?: string; buttons: string[] } | null; stats: BroadcastStats;
};
export type Recipient = {
  id: string; name: string | null; phone: string | null; conversationId: string | null; state: string; repliedAt: string | null; sentAt: string | null; optedOut: boolean; error: string | null;
};
export type BroadcastTemplate = { id: string; name: string; language: string; category: string; shape: TemplateShape };
export type BroadcastOptions = { id: string; name: string; numbers: { id: string; displayPhone: string; verifiedName: string | null; templates: BroadcastTemplate[] }[] }[];
export type AudienceCount = { people: number; gotOneToday: number; optedOut: number; capped: boolean; costUsd: number; category: string; overNewLimit: boolean };

export const AUDIENCES: { kind: AudienceKind; label: string; hint: string }[] = [
  { kind: 'all', label: 'كل اللي كلّموا الرقم أو اشتروا', hint: 'كل عميل بعت رسالة أو طلب من المتجر قبل كده' },
  { kind: 'recent', label: 'اللي كلّموا مؤخرًا', hint: 'الأنسب للعروض: لسه فاكرينك' },
  { kind: 'buyers', label: 'اللي اشتروا قبل كده', hint: 'من طلبات المتجر اللي متلغتش' },
  { kind: 'no_order', label: 'اللي سألوا ومطلبوش', hint: 'فرصة تقفل معاهم بعرض' },
  { kind: 'from_ad', label: 'اللي جم من إعلان', hint: 'دوسوا على إعلان «ابعت رسالة واتساب»' }
];
export const audienceLabel = (a: Audience) => (a.kind === 'recent' ? `اللي كلّموا آخر ${a.days ?? 30} يوم` : AUDIENCES.find(x => x.kind === a.kind)?.label ?? '');

export const NAME_TOKEN = '[الاسم]';

/** The message with sample values, as the customer will read it. */
export const fillPreview = (text: string | undefined, values: Record<string, string>, prefix: string, sampleName = 'مريم') =>
  (text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_all, k: string) => (values[`${prefix}.${k}`]?.trim() ? values[`${prefix}.${k}`]!.split(NAME_TOKEN).join(sampleName) : '…'));

/** A template body with its blanks shown as "…", for the list of templates. */
export const blanks = (text: string) => text.replace(/\{\{\s*[a-z0-9_]+\s*\}\}/g, '…');

/** The words just before a blank, so a field can be labelled by where its text goes. */
export function wordsBefore(body: string, key: string) {
  const i = body.search(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`));
  if (i <= 0) return '';
  const before = blanks(body.slice(0, i)).trim().split(/\s+/).slice(-4).join(' ');
  return before;
}

const CAIRO = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "2026-11-21T19:30" as the wall clock in Cairo for an instant (what a datetime-local field holds). */
export function cairoLocal(d: Date) {
  const p = Object.fromEntries(CAIRO.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** The instant a Cairo wall-clock time means, whatever timezone the phone is set to (Egypt has summer time). */
export function fromCairoLocal(local: string) {
  const want = Date.parse(`${local}:00Z`);
  let t = want - 2 * 3600_000;
  for (let i = 0; i < 3; i++) t += want - Date.parse(`${cairoLocal(new Date(t))}:00Z`);
  return new Date(t);
}
export const badParam = (v: string) => /[\n\t]/.test(v) || / {5,}/.test(v);

/** "48%" of a base, or "" when there is nothing to divide by. */
export const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : '');
