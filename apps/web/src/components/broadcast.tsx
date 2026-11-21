'use client';
import { Clock } from 'lucide-react';
import { money } from '@/lib/ads';
import { pct, type Broadcast, type BroadcastStats } from '@/lib/broadcasts';
import { count, when } from '@/lib/when';
import { cx, Pill } from './ui';

/** The WhatsApp bubble the customer gets. */
export function Bubble({ image, imageLabel, header, body, footer, buttons }: { image?: string | null; imageLabel?: string; header?: string; body: string; footer?: string; buttons: string[] }) {
  return (
    <div className="rounded-[var(--radius-lg)] bg-[#E5DDD5] p-3 dark:bg-[#0B141A]">
      <div className="max-w-[300px] overflow-hidden rounded-[var(--radius-md)] bg-white text-[#111B21] shadow-sm dark:bg-[#202C33] dark:text-[#E9EDEF]">
        {image ? <img src={image} alt="الصورة اللي في أول الرسالة" className="aspect-square w-full object-cover" />
          : imageLabel ? <div className="grid aspect-[4/3] w-full place-items-center bg-black/5 text-sm text-[#667781] dark:bg-white/5">{imageLabel}</div> : null}
        <div className="flex flex-col gap-1 px-3 py-2">
          {header && <p className="font-semibold">{header}</p>}
          <p className="whitespace-pre-wrap leading-6">{body}</p>
          {footer && <p className="text-xs text-[#667781] dark:text-[#8696A0]">{footer}</p>}
        </div>
        {buttons.map((b, i) => <p key={i} className="border-t border-black/10 py-2 text-center text-sm font-semibold text-[#00A5F4] dark:border-white/10">{b}</p>)}
      </div>
    </div>
  );
}

export function BroadcastPill({ b }: { b: Pick<Broadcast, 'status' | 'scheduledAt'> }) {
  if (b.status === 'SCHEDULED') return <Pill tone="info"><Clock size={12} aria-hidden />هتتبعت {when(b.scheduledAt)}</Pill>;
  if (b.status === 'SENDING') return <Pill tone="sun">بتتبعت دلوقتي</Pill>;
  if (b.status === 'CANCELLED') return <Pill tone="neutral">اتوقفت</Pill>;
  return <Pill tone="good">اتبعتت</Pill>;
}

/** The few numbers that answer "did it work?": reached, read, answered, bought. */
export function BroadcastNumbers({ s, big = false }: { s: BroadcastStats; big?: boolean }) {
  const reached = s.delivered;
  const items = [
    { label: 'وصلتهم', value: reached, sub: pct(reached, s.sent + s.failed) },
    { label: 'قروها', value: s.read, sub: pct(s.read, reached) },
    { label: 'ردّوا', value: s.replied, sub: pct(s.replied, reached), strong: true },
    { label: s.orders ? 'طلبوا من المتجر' : 'طلبات من المتجر', value: s.orders, sub: s.sales.map(x => money(x.minor, x.currency, true)).join(' + '), strong: s.orders > 0 }
  ];
  return (
    <dl className={cx('grid grid-cols-4 gap-2 max-sm:grid-cols-2', big && 'gap-3')}>
      {items.map(i => (
        <div key={i.label} className={cx('flex flex-col rounded-[var(--radius-md)] bg-surface-2', big ? 'p-4' : 'px-3 py-2')}>
          <dt className="text-sm text-muted">{i.label}</dt>
          <dd className={cx('num font-display font-bold tabular-nums', big ? 'text-3xl' : 'text-xl', i.strong && i.value > 0 && 'text-success')}>{i.value}</dd>
          {i.sub && <dd className="text-xs text-muted">{i.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A thin progress line while sending. */
export function Progress({ s }: { s: BroadcastStats }) {
  const done = s.total - s.pending;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={done} aria-label="اتبعت لكام واحد">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${s.total ? (done / s.total) * 100 : 0}%` }} />
      </div>
      <p className="text-sm text-muted">اتبعتت لـ <span className="num">{done}</span> من <span className="num">{s.total}</span></p>
    </div>
  );
}

export const peopleWord = (n: number) => count(n, 'شخص واحد', 'شخصين', 'أشخاص', 'شخص');
