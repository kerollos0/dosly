import { GRAPH_URL, GraphError, graph, type MediaType } from './whatsapp.js';

/**
 * WhatsApp Cloud API media rules, from Meta's "Supported media types" table
 * (developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media).
 */
const MB = 1024 * 1024;
export const WA_MEDIA_LIMITS: Record<MediaType, number> = {
  image: 5 * MB,
  audio: 16 * MB,
  video: 16 * MB,
  document: 100 * MB,
  sticker: 500 * 1024 // animated; static stickers are 100 KB
};
/** Customers can send files up to 100 MB; bigger ones arrive as error 131052. */
export const WA_INBOUND_MAX = 100 * MB;
/** Images above this edge length are rejected by WhatsApp. */
export const WA_IMAGE_MAX_EDGE = 4096;
/** A voice note shows a play button only up to this size; bigger ones show a download icon. */
export const WA_VOICE_PLAY_MAX = 512 * 1024;

export const WA_SEND_MIME: Record<Exclude<MediaType, 'sticker'>, readonly string[]> = {
  image: ['image/jpeg', 'image/png'], // static WebP is accepted too, but Meta transcodes it to JPEG
  audio: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
  video: ['video/mp4', 'video/3gpp'],
  document: [
    'application/pdf', 'text/plain',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
};

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};
/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase();
export const extOf = (mime: string) => EXT[baseMime(mime)] ?? 'bin';

export type MediaInfo = { url: string; mime_type: string; sha256: string; file_size: number | string; id: string };

/** GET /{media-id}: a download URL that is valid for 5 minutes. */
export function getMediaInfo(o: { mediaId: string; phoneNumberId: string; token: string }, fetchImpl?: typeof fetch) {
  return graph<MediaInfo>(`${o.mediaId}?phone_number_id=${encodeURIComponent(o.phoneNumberId)}`, o.token, {}, fetchImpl);
}

/** Downloads a media URL. Meta rejects the request without the bearer token. */
export async function downloadMedia(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new GraphError(`Media download ${res.status}`, res.status);
  return res;
}

/** POST /{phone-number-id}/media (multipart). Returns a media id valid for 30 days. */
export async function uploadMedia(o: { phoneNumberId: string; token: string; bytes: Uint8Array; mime: string; fileName: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', o.mime);
  form.set('file', new Blob([o.bytes as BlobPart], { type: o.mime }), o.fileName);
  const res = await fetchImpl(`${GRAPH_URL}/${o.phoneNumberId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${o.token}` }, body: form });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string; code?: number } };
  if (!res.ok || json.error || !json.id) throw new GraphError(json.error?.message ?? `Media upload ${res.status}`, res.status, json.error?.code);
  return json.id;
}

/** POST /{phone-number-id}/messages with any message object (image, audio, template, ...). Returns the wamid. */
export async function sendWhatsAppMessage(o: { phoneNumberId: string; token: string; to: string; message: Record<string, unknown> }, fetchImpl?: typeof fetch): Promise<string> {
  const res = await graph<{ messages: { id: string }[] }>(`${o.phoneNumberId}/messages`, o.token, {
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: o.to, ...o.message }
  }, fetchImpl);
  return res.messages[0]!.id;
}

/** Meta error codes that will not succeed on retry (bad media, expired id, recipient problems). */
export const PERMANENT_WA_ERRORS = new Set([100, 131008, 131009, 131051, 131052, 131053, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 132018, 190]);
/** Throughput and pair-rate limits: wait and send again (Meta returns some of them as HTTP 400). */
export const THROTTLE_WA_ERRORS = new Set([4, 80007, 130429, 131048, 131056]);
export const isPermanentGraphError = (e: unknown) => e instanceof GraphError && !(e.code !== undefined && THROTTLE_WA_ERRORS.has(e.code))
  && ((e.code !== undefined && PERMANENT_WA_ERRORS.has(e.code)) || e.status === 400 || e.status === 404);
