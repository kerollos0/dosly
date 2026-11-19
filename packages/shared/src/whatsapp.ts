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
  mediaId?: string;
};

export type StatusUpdate = {
  phoneNumberId: string;
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  error?: string;
};

type Json = Record<string, any>;

/** Flattens a WhatsApp Cloud API webhook payload into messages and status updates. */
export function parseWebhook(payload: Json): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  if (payload?.object !== 'whatsapp_business_account') return { messages, statuses };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value ?? {};
      const phoneNumberId: string = v.metadata?.phone_number_id;
      const names = new Map<string, string>((v.contacts ?? []).map((c: Json) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const media = m[m.type];
        messages.push({
          phoneNumberId,
          waId: m.from,
          contactName: names.get(m.from),
          waMessageId: m.id,
          timestamp: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          body: m.text?.body ?? media?.caption ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title,
          mediaId: media?.id
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
  return { messages, statuses };
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
