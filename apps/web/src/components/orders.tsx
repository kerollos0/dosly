'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Check, MessageCircle, PhoneCall, RotateCw, Truck, X } from 'lucide-react';
import { api } from '@/lib/api';
import { currencyWord, money, nf } from '@/lib/ads';
import { confirmLabel, followUpReason, ORDER_STATUS, SHIPMENT, type Order, type SalesBlock } from '@/lib/orders';
import { ago, count, when } from '@/lib/when';
import { Button, cx, ErrorText, Pill } from './ui';

const itemsLine = (o: Order) => o.items.map(i => `${i.qty > 1 ? `${nf.format(i.qty)} × ` : ''}${i.name}${i.variant ? ` (${i.variant})` : ''}`).join('، ');

/** A phone number people can tap to call, written left to right inside Arabic text. */
function Phone({ phone }: { phone: string }) {
  return <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} dir="ltr" className="num font-semibold text-primary underline-offset-2 hover:underline">{phone}</a>;
}

function Shipping({ o }: { o: Order }) {
  if (!o.trackingNumber && !o.shipmentStatus) return null;
  const text = [o.shipmentStatus ? SHIPMENT[o.shipmentStatus] ?? o.shipmentStatus : null, o.trackingCompany].filter(Boolean).join(' · ');
  return (
    <p className="flex flex-wrap items-center gap-1 text-sm text-muted">
      <Truck size={15} aria-hidden className="shrink-0" />{text}
      {o.trackingNumber && (o.trackingUrl ? <a href={o.trackingUrl} target="_blank" rel="noreferrer" className="num text-primary underline" dir="ltr">{o.trackingNumber}</a> : <span className="num" dir="ltr">{o.trackingNumber}</span>)}
    </p>
  );
}

/**
 * One order. `compact` is the side panel beside a chat; otherwise it is the orders page card,
 * with the follow-up buttons when the order needs a call.
 */
export function OrderCard({ o, compact = false, showClient = false, onChange }: { o: Order; compact?: boolean; showClient?: boolean; onChange?: (o: Order) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const st = ORDER_STATUS[o.status];
  const conf = confirmLabel(o);
  const needsCall = (o.confirm === 'NO_ANSWER' || o.confirm === 'NOT_SENT' || o.confirm === 'DECLINED') && !o.followUpDoneAt && !['CANCELLED', 'RETURNED', 'FAILED'].includes(o.status);
  async function act(action: 'confirm' | 'cancel' | 'resend' | 'done') {
    setBusy(action); setErr(null);
    try { onChange?.(await api<Order>(`/orders/${o.id}/action`, { body: { action } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  return (
    <article aria-label={`طلب ${o.number}`} className={cx('flex flex-col gap-2 rounded-[var(--radius-md)] border bg-surface', compact ? 'p-3' : 'p-4', needsCall && !compact ? 'border-warning/50' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">طلب <span className="num" dir="ltr">{o.number}</span></span>
        {!(o.status === 'PENDING' && conf) && <Pill tone={st.tone}>{st.label}</Pill>}
        {conf && <Pill tone={conf.tone}>{conf.label}</Pill>}
        <span className="ms-auto font-display text-lg font-bold tabular-nums">{money(o.totalMinor, o.currency, true)}</span>
      </div>
      {!compact && (
        <p className="text-sm">
          <span className="font-semibold">{o.customerName ?? 'عميل'}</span>
          {o.phone && <> · <Phone phone={o.phone} /></>}
          {o.city && <span className="text-muted"> · {o.city}</span>}
          {showClient && <span className="text-muted"> · {o.client.name}</span>}
        </p>
      )}
      <p className="text-sm text-muted">{itemsLine(o) || 'من غير منتجات'}</p>
      <Shipping o={o} />
      <p className="text-xs text-muted">
        {when(o.placedAt)}{o.cod ? ' · الدفع عند الاستلام' : ' · مدفوع أونلاين'}
        {o.campaign && <> · جه من حملة «{o.campaign.name}»</>}
      </p>
      {needsCall && !compact && (
        <div className="mt-1 flex flex-col gap-2 rounded-[var(--radius-sm)] bg-warning/8 p-3">
          <p className="flex items-start gap-2 text-sm"><PhoneCall size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />{followUpReason(o)}{o.confirmSentAt && o.confirm === 'NO_ANSWER' ? ` الرسالة اتبعتت ${ago(o.confirmSentAt)}.` : ''}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => act('confirm')} disabled={!!busy}><Check size={15} aria-hidden />العميل أكد بالتليفون</Button>
            <Button size="sm" variant="ghost" onClick={() => act('cancel')} disabled={!!busy}><X size={15} aria-hidden />العميل لغى</Button>
            {o.status === 'PENDING' && o.confirm !== 'DECLINED' && <Button size="sm" variant="ghost" onClick={() => act('resend')} disabled={!!busy}><RotateCw size={15} aria-hidden />ابعت التأكيد تاني</Button>}
            {o.conversationId && <Link href={`/inbox?c=${o.conversationId}`} className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2"><MessageCircle size={15} aria-hidden />افتح المحادثة</Link>}
          </div>
          <p className="text-xs text-muted">الزراير دي بتسجل اللي حصل في دوسلي بس. لو العميل لغى، متنساش تلغي الطلب من المتجر كمان.</p>
          <ErrorText error={err} />
        </div>
      )}
      {!needsCall && !compact && o.conversationId && (
        <Link href={`/inbox?c=${o.conversationId}`} className="self-start text-sm font-semibold text-primary underline-offset-2 hover:underline">افتح المحادثة</Link>
      )}
    </article>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-md)] border border-line bg-surface p-4 max-sm:p-3">
      <span className="text-sm text-muted">{label}</span>
      <span className={cx('font-display text-[24px] font-bold leading-8 tabular-nums [overflow-wrap:anywhere] max-sm:text-[20px] max-sm:leading-7', tone === 'good' && 'text-success')}>{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

/** "Every pound spent on ads brought X pounds of real sales": the one number owners ask about. */
export function roasLine(roas: number | null, currency: string) {
  if (roas === null) return null;
  const w = currencyWord(currency);
  return `كل ${w} اتصرف على الإعلانات جاب ${nf.format(roas)} ${w} مبيعات حقيقية`;
}

/**
 * Real store sales for one currency: what sold (confirmed, shipped or delivered), what is still
 * waiting, and what was lost. With `spendMinor`, the real return on the ad spend too.
 */
export function SalesTiles({ s, roas, client = false }: { s: SalesBlock; roas?: number | null; client?: boolean }) {
  const c = s.currency;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      <Tile label="مبيعات حقيقية" tone="good" value={money(s.soldValueMinor, c, true)} sub={`${count(s.sold, 'طلب واحد', 'طلبين', 'طلبات', 'طلب')} اتأكد أو اتشحن${s.delivered ? `، منهم ${nf.format(s.delivered)} اتسلّم` : ''}`} />
      {roas !== undefined && roas !== null && <Tile label={client ? 'رجع الإعلانات' : 'العائد الحقيقي (ROAS)'} value={`${nf.format(roas)}×`} sub={roasLine(roas, c)!} />}
      <Tile label="كل الطلبات" value={nf.format(s.orders)} sub={`بقيمة ${money(s.valueMinor, c, true)}`} />
      {s.waiting > 0 && <Tile label="مستنية تأكيد" value={nf.format(s.waiting)} sub={`بقيمة ${money(s.waitingValueMinor, c, true)}`} />}
      <Tile label="اتلغت أو رجعت" value={nf.format(s.lost)} sub={s.orders ? `${nf.format(Math.round((s.lost / s.orders) * 100))}% من الطلبات` : undefined} />
    </div>
  );
}
