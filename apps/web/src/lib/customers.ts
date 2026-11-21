/** Customers of the agency's clients (الزباين): a light pipeline and where each one came from. */
export type Stage = 'NEW' | 'INTERESTED' | 'ORDERED' | 'WON' | 'LOST';
export const STAGES: { v: Stage; label: string; tone: 'neutral' | 'info' | 'sun' | 'good' | 'bad' }[] = [
  { v: 'NEW', label: 'جديد', tone: 'neutral' },
  { v: 'INTERESTED', label: 'مهتم', tone: 'info' },
  { v: 'ORDERED', label: 'طلب', tone: 'sun' },
  { v: 'WON', label: 'اشترى', tone: 'good' },
  { v: 'LOST', label: 'مش مهتم', tone: 'bad' }
];
export const stageOf = (s: Stage) => STAGES.find(x => x.v === s)!;

export type Money = { currency: string; minor: number };
export type Customer = {
  id: string; name: string | null; username: string | null; waId: string | null; stage: Stage; stageAt: string | null; tags: string[]; note: string | null;
  source: 'ad' | 'comment' | 'direct'; adTitle: string | null; createdAt: string; client: { id: string; name: string };
  conversation: { id: string; channel: 'WHATSAPP' | 'MESSENGER' | 'INSTAGRAM'; lastMessageAt: string; lastPreview: string | null } | null;
  ad: { id: string; campaign: { id: string; name: string } | null } | null;
  orders: (Money & { count: number })[];
};
export type SourceRow = { key: string; kind: 'campaign' | 'ad' | 'comment' | 'direct'; label: string | null; people: number; ordered: number; buyers: number; sales: Money[] };
export type Summary = { stages: Partial<Record<Stage, number>>; sources: SourceRow[]; tags: string[] };
export type CustomerDetail = {
  id: string; clientId: string; name: string | null; stage: Stage; tags: string[]; note: string | null; source: 'ad' | 'comment' | 'direct';
  adId: string | null; adTitle: string | null; campaign: { id: string; name: string } | null; clientTags: string[];
};

export function sourceLabel(r: { kind: SourceRow['kind']; label: string | null }) {
  if (r.kind === 'campaign') return r.label ? `إعلان: ${r.label}` : 'إعلان';
  if (r.kind === 'ad') return r.label ? `إعلان: ${r.label}` : 'إعلان مش متوصّل بدوسلي';
  if (r.kind === 'comment') return 'من كومنت على بوست';
  return 'بعتوا لوحدهم (من غير إعلان)';
}

/** Where one customer came from, in a few words. */
export function customerSource(c: { source: Customer['source']; adTitle: string | null; ad?: Customer['ad']; campaign?: { name: string } | null }) {
  if (c.source === 'ad') { const name = c.ad?.campaign?.name ?? c.campaign?.name ?? c.adTitle; return name ? `من إعلان: ${name}` : 'من إعلان'; }
  if (c.source === 'comment') return 'من كومنت على بوست';
  return 'بعت للعميل لوحده (من غير إعلان)';
}
