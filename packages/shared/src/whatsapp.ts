import { createHmac, timingSafeEqual } from 'node:crypto';

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v25.0';
export const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** Meta signs webhook bodies with the app secret: header X-Hub-Signature-256: sha256=<hex>. */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Free-form replies are allowed for 24h after the customer's last message; after that only templates. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export function isWindowOpen(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

export type InboundMessage = {
  phoneNumberId: string;
  waId: string;
  contactName?: string;
  waMessageId: string;
  timestamp: Date;
  type: string;
  body?: string;
  media?: InboundMedia;
  /** Quick reply button presses: the payload we put on the button (template) or the reply id (interactive). */
  buttonPayload?: string;
  /** The message this one answers (a button press points at the template it came from). */
  contextId?: string;
  /** Click-to-WhatsApp: the ad the customer tapped to start chatting. */
  referral?: { sourceId: string; sourceType?: string; ctwaClid?: string };
};

/** The media object Meta puts on image, audio, video, document and sticker messages. */
export type InboundMedia = { id: string; mime?: string; sha256?: string; fileName?: string; voice?: boolean; animated?: boolean };

export type TemplateStatusUpdate = { wabaId: string; metaId: string; name?: string; language?: string; event: string; reason?: string | null; category?: string };

export const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const isMediaType = (t: string): t is MediaType => (MEDIA_TYPES as readonly string[]).includes(t);

/** Text shown for messages that carry no text of their own. */
function bodyOf(m: Json): string | undefined {
  const media = m[m.type];
  if (m.text?.body) return m.text.body;
  if (media?.caption) return media.caption;
  if (m.button?.text) return m.button.text;
  if (m.interactive) return m.interactive.button_reply?.title ?? m.interactive.list_reply?.title;
  if (m.type === 'location' && m.location) {
    const { latitude, longitude, name, address } = m.location;
    return [name, address, `https://maps.google.com/?q=${latitude},${longitude}`].filter(Boolean).join('\n');
  }
  if (m.type === 'reaction') return m.reaction?.emoji ? `تفاعل ${m.reaction.emoji}` : undefined;
  if (m.type === 'contacts') return (m.contacts ?? []).map((c: Json) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(' ')).join('\n') || undefined;
  return undefined;
}

export type StatusUpdate = {
  phoneNumberId: string;
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  error?: string;
};

type Json = Record<string, any>;

/** Flattens a WhatsApp Cloud API webhook payload into messages and status updates. */
export function parseWebhook(payload: Json): { messages: InboundMessage[]; statuses: StatusUpdate[]; templates: TemplateStatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const templates: TemplateStatusUpdate[] = [];
  if (payload?.object !== 'whatsapp_business_account') return { messages, statuses, templates };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      if (change.field === 'message_template_status_update') {
        if (v.message_template_id != null) templates.push({ wabaId: String(entry.id), metaId: String(v.message_template_id), name: v.message_template_name, language: v.message_template_language, event: String(v.event), reason: v.reason ?? null, category: v.message_template_category });
        continue;
      }
      if (change.field !== 'messages') continue;
      const phoneNumberId: string = v.metadata?.phone_number_id;
      const names = new Map<string, string>((v.contacts ?? []).map((c: Json) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const media = isMediaType(m.type) ? m[m.type] : undefined;
        messages.push({
          phoneNumberId,
          waId: m.from,
          contactName: names.get(m.from),
          waMessageId: m.id,
          timestamp: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          body: bodyOf(m),
          media: media?.id ? { id: String(media.id), mime: media.mime_type, sha256: media.sha256, fileName: media.filename, voice: media.voice === true, animated: media.animated === true } : undefined,
          buttonPayload: m.button?.payload ?? m.interactive?.button_reply?.id ?? undefined,
          contextId: m.context?.id ?? undefined,
          referral: m.referral?.source_id && (m.referral.source_type ?? 'ad') === 'ad' ? { sourceId: String(m.referral.source_id), sourceType: m.referral.source_type, ctwaClid: m.referral.ctwa_clid } : undefined
        });
      }
      for (const s of v.statuses ?? []) {
        statuses.push({
          phoneNumberId,
          waMessageId: s.id,
          status: s.status,
          timestamp: new Date(Number(s.timestamp) * 1000),
          error: s.errors?.[0] ? `${s.errors[0].code}: ${s.errors[0].title}` : undefined
        });
      }
    }
  }
  return { messages, statuses, templates };
}

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

export async function graph<T = Json>(path: string, token: string, init: { method?: string; body?: Json } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${GRAPH_URL}/${path.replace(/^\//, '')}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || json.error) throw new GraphError(json.error?.message ?? `Graph API ${res.status}`, res.status, json.error?.code);
  return json as T;
}

export async function sendWhatsAppText(opts: { phoneNumberId: string; token: string; to: string; body: string }, fetchImpl?: typeof fetch) {
  const res = await graph<{ messages: { id: string }[] }>(`${opts.phoneNumberId}/messages`, opts.token, {
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: opts.to, type: 'text', text: { preview_url: true, body: opts.body } }
  }, fetchImpl);
  return res.messages[0]!.id;
}
