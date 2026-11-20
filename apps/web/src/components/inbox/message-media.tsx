'use client';
import { useState } from 'react';
import { Download, FileText, Mic, RotateCcw, Loader2, ImageOff } from 'lucide-react';
import { api, type Message } from '@/lib/api';
import { cx } from '@/components/ui';

const nf = new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 1 });
export const mediaUrl = (m: Pick<Message, 'id'>, opts: { preview?: boolean; download?: boolean } = {}) =>
  `/api/messages/${m.id}/media${opts.preview ? '?v=preview' : opts.download ? '?download=1' : ''}`;

export function fileSize(bytes: number | null) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${nf.format(Math.max(1, Math.round(bytes / 1024)))} كيلو`;
  return `${nf.format(bytes / 1024 / 1024)} ميجا`;
}
export function clock(sec: number | null) {
  if (sec == null) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Box with the media's real proportions, so the thread does not jump when it loads. */
function sized(m: Message, max = 280) {
  const w = m.mediaWidth ?? 0, h = m.mediaHeight ?? 0;
  if (!w || !h) return { width: max, height: Math.round(max * 0.75) };
  const scale = Math.min(1, max / w, (max * 1.25) / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function Retry({ m, label }: { m: Message; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/messages/${m.id}/retry`, { method: 'POST' }); } finally { setBusy(false); } }}
      className="inline-flex items-center gap-1 text-xs font-semibold underline underline-offset-2">
      <RotateCcw size={12} aria-hidden />{label}
    </button>
  );
}

/** Media part of a message bubble: photo, voice note, audio, video, document or sticker. */
export function MessageMedia({ m, onOpenImage }: { m: Message; onOpenImage: (m: Message) => void }) {
  const kind = m.type === 'template' ? m.template?.headerKind : m.type;
  if (!m.hasMedia || !kind) return null;
  const box = sized(m, kind === 'sticker' ? 140 : 280);

  if (m.mediaStatus === 'PENDING') {
    return (
      <div className="flex items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-black/5 text-sm text-muted" style={kind === 'image' || kind === 'video' ? box : { minHeight: 44, minWidth: 200 }}>
        <Loader2 size={16} className="animate-spin" aria-hidden />بيتحمّل من واتساب…
      </div>
    );
  }
  if (m.mediaStatus === 'FAILED' && m.direction === 'IN') {
    return (
      <div className="flex min-w-52 flex-col gap-1 rounded-[var(--radius-sm)] bg-black/5 p-3 text-sm">
        <span className="flex items-center gap-2"><ImageOff size={16} aria-hidden />الملف ماتحمّلش</span>
        <span className="text-xs opacity-80">واتساب بيحتفظ بالملفات 7 أيام بس.</span>
        <Retry m={m} label="جرّب تاني" />
      </div>
    );
  }

  if (kind === 'image' || kind === 'sticker') {
    return (
      <button type="button" onClick={() => onOpenImage(m)} className="block overflow-hidden rounded-[var(--radius-sm)] focus-visible:outline-2" aria-label="افتح الصورة">
        <img src={mediaUrl(m, { preview: m.hasPreview })} alt={m.body ?? (kind === 'sticker' ? 'ستيكر' : 'صورة من العميل')} loading="lazy" decoding="async"
          width={box.width} height={box.height} className={cx('block object-cover', kind !== 'sticker' && 'bg-black/5')} style={box} />
      </button>
    );
  }
  if (kind === 'video') {
    return (
      <video controls preload="none" playsInline poster={m.hasPreview ? mediaUrl(m, { preview: true }) : undefined}
        width={box.width} height={box.height} className="block rounded-[var(--radius-sm)] bg-black" style={box}>
        <source src={mediaUrl(m)} type={m.mediaMime ?? 'video/mp4'} />
      </video>
    );
  }
  if (kind === 'audio') {
    return (
      <div className="flex min-w-60 flex-col gap-1">
        <span className="flex items-center gap-1 text-xs opacity-80">
          {m.voice ? <><Mic size={12} aria-hidden />رسالة صوتية</> : 'ملف صوتي'}{m.durationSec ? <> · <span className="num">{clock(m.durationSec)}</span></> : null}
        </span>
        {/* The browser picks the first source it can play: the original Ogg/Opus, or the AAC copy for older Safari. */}
        <audio controls preload="none" className="h-10 w-64 max-w-full" aria-label={m.voice ? 'رسالة صوتية' : 'ملف صوتي'}>
          <source src={mediaUrl(m)} type={(m.mediaMime ?? 'audio/ogg').split(';')[0]} />
          {m.hasPreview && <source src={mediaUrl(m, { preview: true })} type="audio/mp4" />}
        </audio>
      </div>
    );
  }
  return (
    <a href={mediaUrl(m, { download: true })} className="flex min-w-56 items-center gap-3 rounded-[var(--radius-sm)] bg-black/5 p-3 no-underline">
      <FileText size={28} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" dir="auto">{m.fileName ?? 'ملف'}</span>
        <span className="block text-xs opacity-80">{m.fileName?.includes('.') ? `${m.fileName.split('.').pop()!.toUpperCase().slice(0, 5)} · ` : ''}{fileSize(m.mediaSize)}</span>
      </span>
      <Download size={18} aria-label="تحميل" />
    </a>
  );
}

export { Retry };
