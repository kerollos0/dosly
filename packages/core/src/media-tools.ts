import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import sharp, { type Metadata } from 'sharp';
import { fileTypeFromFile } from 'file-type';
import { WA_IMAGE_MAX_EDGE, WA_MEDIA_LIMITS, baseMime, extOf, type MediaType } from '@dosly/shared';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
// One image decode should never hold the worker for long or eat its memory.
sharp.concurrency(1);
sharp.cache(false);

export const tempPath = (ext: string) => join(tmpdir(), `dosly-${randomBytes(8).toString('hex')}.${ext}`);

export async function ffmpeg(args: string[], timeoutMs = 120_000) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

export type Probe = { duration?: number; width?: number; height?: number; vcodec?: string; acodec?: string; channels?: number };
export async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,channels', '-of', 'json', path], { timeout: 30_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; codec_name: string; width?: number; height?: number; channels?: number }[] };
  const v = j.streams?.find(s => s.codec_type === 'video');
  const a = j.streams?.find(s => s.codec_type === 'audio');
  const d = Number(j.format?.duration);
  return { duration: Number.isFinite(d) ? d : undefined, width: v?.width, height: v?.height, vcodec: v?.codec_name, acodec: a?.codec_name, channels: a?.channels };
}

/** WhatsApp voice notes must be OGG/OPUS mono. 32 kbps keeps a 2-minute note under the 512 KB play-button limit. */
export async function toVoiceNote(src: string): Promise<string> {
  const out = tempPath('ogg');
  await ffmpeg(['-i', src, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out]);
  return out;
}

/** AAC copy of an audio file, for browsers that cannot play Ogg or AMR (older Safari). */
export async function toPlaybackAudio(src: string): Promise<string> {
  const out = tempPath('m4a');
  await ffmpeg(['-i', src, '-vn', '-map_metadata', '-1', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
  return out;
}

/** A JPEG WhatsApp accepts: at most 4096 px a side and 5 MB, EXIF orientation applied. */
export async function toWhatsAppJpeg(src: string): Promise<string> {
  const out = tempPath('jpg');
  let quality = 85;
  for (;;) {
    const info = await sharp(src, { animated: false, limitInputPixels: 100_000_000 }).autoOrient()
      .resize({ width: WA_IMAGE_MAX_EDGE, height: WA_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toFile(out);
    if (info.size <= WA_MEDIA_LIMITS.image || quality <= 50) return out;
    quality -= 15;
  }
}

/** A small WebP for the inbox, plus the real size so the page can reserve space before it loads. */
export async function imagePreview(src: string): Promise<{ path: string; width: number; height: number }> {
  const out = tempPath('webp');
  const img = sharp(src, { animated: false, limitInputPixels: 100_000_000 }).autoOrient();
  const meta = await img.metadata();
  await img.clone().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(out);
  const swap = (meta.orientation ?? 1) >= 5; // EXIF orientations 5-8 rotate by 90 degrees
  return { path: out, width: (swap ? meta.height : meta.width) ?? 0, height: (swap ? meta.width : meta.height) ?? 0 };
}

/** Moves an H.264/AAC stream into an MP4 container (fast start), without re-encoding. */
export async function toMp4(src: string): Promise<string> {
  const out = tempPath('mp4');
  await ffmpeg(['-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out]);
  return out;
}

export async function videoPoster(src: string): Promise<string> {
  const out = tempPath('jpg');
  try { await ffmpeg(['-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", out], 30_000); }
  catch { await ffmpeg(['-i', src, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", out], 30_000); }
  return out;
}

export class UploadRejected extends Error {}

export type Classified = {
  kind: Exclude<MediaType, 'sticker'>;
  mime: string; // the type that will be sent to WhatsApp
  ext: string;
  voice: boolean;
  /** The worker has to convert the file before uploading it to WhatsApp. */
  convert: 'voice' | 'jpeg' | 'mp4' | null;
  width?: number; height?: number; duration?: number;
};

const DOC_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

async function looksLikeText(path: string) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, bytesRead);
    return !chunk.includes(0) && Buffer.from(chunk.toString('utf8'), 'utf8').length === chunk.length;
  } finally { await fh.close(); }
}

/**
 * Decides how an agency's upload goes to WhatsApp, from the file's bytes (never the browser's type).
 * Throws UploadRejected with an Arabic message the inbox can show as is.
 */
export async function classifyUpload(path: string, size: number, fileName: string, wantVoice: boolean): Promise<Classified> {
  const ft = await fileTypeFromFile(path);
  const mime = ft?.mime ?? '';
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();

  // Browsers record voice as WebM (Chrome, Firefox) or MP4 (Safari); file-type calls audio-only WebM "video/webm".
  const probed: Probe = mime.startsWith('audio/') || mime.startsWith('video/') ? await probe(path).catch(() => ({} as Probe)) : {};
  const audioOnly = mime.startsWith('audio/') || (mime.startsWith('video/') && !probed.vcodec && !!probed.acodec);
  if (wantVoice || audioOnly) {
    if (!probed.acodec) throw new UploadRejected('مش قادرين نقرا الصوت ده');
    if (size > WA_MEDIA_LIMITS.audio * 4) throw new UploadRejected('الصوت أكبر من المسموح');
    const m = mime === 'audio/x-m4a' ? 'audio/mp4' : baseMime(mime);
    const sendable = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'].includes(m) && size <= WA_MEDIA_LIMITS.audio;
    if (wantVoice || !sendable) return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg', voice: wantVoice, convert: 'voice', duration: probed.duration };
    return { kind: 'audio', mime: m, ext: extOf(m), voice: false, convert: null, duration: probed.duration };
  }

  if (mime.startsWith('image/')) {
    let meta: Metadata;
    try { meta = await sharp(path, { animated: false }).metadata(); } catch { throw new UploadRejected('مش قادرين نفتح الصورة دي. جرّب JPG أو PNG'); }
    const plain = (mime === 'image/jpeg' || mime === 'image/png') && size <= WA_MEDIA_LIMITS.image && Math.max(meta.width ?? 0, meta.height ?? 0) <= WA_IMAGE_MAX_EDGE;
    return plain
      ? { kind: 'image', mime, ext: ft!.ext, voice: false, convert: null, width: meta.width, height: meta.height }
      : { kind: 'image', mime: 'image/jpeg', ext: 'jpg', voice: false, convert: 'jpeg', width: meta.width, height: meta.height };
  }

  if (mime.startsWith('video/')) {
    const p = probed;
    if (!['video/mp4', 'video/3gpp', 'video/quicktime'].includes(mime) || p.vcodec !== 'h264' || (p.acodec && p.acodec !== 'aac')) {
      throw new UploadRejected('واتساب بيقبل فيديو MP4 بس (H.264). صدّره من الموبايل أو من برنامج المونتاج بالصيغة دي');
    }
    if (size > WA_MEDIA_LIMITS.video) throw new UploadRejected('الفيديو أكبر من 16 ميجا، وده أقصى حجم في واتساب');
    // iPhone .mov files hold the same H.264 stream; only the container changes, without re-encoding.
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4', voice: false, convert: mime === 'video/mp4' ? null : 'mp4', width: p.width, height: p.height, duration: p.duration };
  }

  // Documents: trust the bytes for PDF and Office Open XML, the extension only for legacy Office (one container format) and text.
  let docMime: string | undefined;
  if (mime === 'application/pdf' || Object.values(DOC_BY_EXT).includes(mime)) docMime = mime;
  else if (ft?.ext === 'cfb' && ['doc', 'xls', 'ppt'].includes(ext)) docMime = DOC_BY_EXT[ext];
  else if (ft?.ext === 'zip' && ['docx', 'xlsx', 'pptx'].includes(ext)) docMime = DOC_BY_EXT[ext];
  else if (!ft && ext === 'txt' && await looksLikeText(path)) docMime = 'text/plain';
  if (!docMime) throw new UploadRejected('نوع الملف ده مش مسموح في واتساب. المسموح: صور، فيديو MP4، صوت، PDF، Word، Excel، PowerPoint، TXT');
  if (size > WA_MEDIA_LIMITS.document) throw new UploadRejected('الملف أكبر من 100 ميجا، وده أقصى حجم في واتساب');
  const docExt = Object.entries(DOC_BY_EXT).find(([, m]) => m === docMime)![0];
  return { kind: 'document', mime: docMime, ext: docExt, voice: false, convert: null };
}
