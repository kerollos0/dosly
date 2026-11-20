import { cx } from '@/components/ui';

export type ChannelName = 'WHATSAPP' | 'MESSENGER' | 'INSTAGRAM' | 'FACEBOOK_PAGE';
export const CHANNEL_LABEL: Record<ChannelName, string> = { WHATSAPP: 'واتساب', MESSENGER: 'ماسنجر', INSTAGRAM: 'إنستجرام', FACEBOOK_PAGE: 'فيسبوك' };
// Brand colours as a small dot only; the label carries the meaning, so it reads without colour too.
const DOT: Record<ChannelName, string> = { WHATSAPP: 'bg-[#25D366]', MESSENGER: 'bg-[#0866FF]', INSTAGRAM: 'bg-[#E1306C]', FACEBOOK_PAGE: 'bg-[#0866FF]' };

export function ChannelBadge({ channel, className }: { channel: ChannelName; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs text-muted', className)}>
      <span className={cx('size-2 rounded-full', DOT[channel])} aria-hidden />{CHANNEL_LABEL[channel]}
    </span>
  );
}
