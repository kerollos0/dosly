import { randomBytes } from 'node:crypto';

/**
 * Demo mode: a stand-in for the Meta Graph API. It answers every call Dosly makes
 * (verify a number or page, send a WhatsApp message, publish to Facebook or Instagram)
 * without any network traffic, so the whole product can run with no Meta app at all.
 */
const id = (prefix: string) => `${prefix}${randomBytes(8).toString('hex')}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const DEMO_FAIL_TOKEN = 'demo-fail';

export const demoFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname.replace(/^\/v[\d.]+\//, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  // Lets a demo show what a Meta error looks like.
  if (auth.endsWith(DEMO_FAIL_TOKEN)) return json({ error: { message: 'Invalid OAuth access token (demo)', code: 190 } }, 401);

  const fields = url.searchParams.get('fields') ?? '';
  const [node, edge] = path.split('/');
  if (method === 'GET') {
    if (fields.includes('display_phone_number')) {
      const digits = (node ?? '').replace(/\D/g, '').padEnd(8, '0').slice(-8);
      return json({ id: node, display_phone_number: `+20 10 ${digits.slice(0, 4)} ${digits.slice(4)}`, verified_name: 'Demo Business' });
    }
    if (fields.includes('status_code')) return json({ id: node, status_code: 'FINISHED' });
    return json({ id: node });
  }
  switch (edge) {
    case 'messages': return json({ messaging_product: 'whatsapp', messages: [{ id: id('wamid.DEMO') }] });
    case 'photos': return json({ id: id(''), post_id: `${node}_${id('')}` });
    case 'feed': return json({ id: `${node}_${id('')}` });
    case 'media': return json({ id: id('17') });
    case 'media_publish': return json({ id: id('18') });
    default: return json({ error: { message: `Demo Graph has no handler for ${method} ${path}` } }, 400);
  }
};

type Json = Record<string, unknown>;
const wrap = (phoneNumberId: string, value: Json) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'demo-waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }]
});

/** A WhatsApp webhook payload for one inbound text, shaped exactly like Meta's. */
export function demoInboundPayload(o: { phoneNumberId: string; waId: string; name?: string; body: string; at?: Date }) {
  const ts = String(Math.floor((o.at ?? new Date()).getTime() / 1000));
  return wrap(o.phoneNumberId, {
    contacts: [{ wa_id: o.waId, profile: { name: o.name } }],
    messages: [{ from: o.waId, id: id('wamid.DEMOIN'), timestamp: ts, type: 'text', text: { body: o.body } }]
  });
}

/** A WhatsApp webhook payload moving one outbound message to a new status. */
export function demoStatusPayload(o: { phoneNumberId: string; waMessageId: string; status: 'sent' | 'delivered' | 'read'; at?: Date }) {
  const ts = String(Math.floor((o.at ?? new Date()).getTime() / 1000));
  return wrap(o.phoneNumberId, { statuses: [{ id: o.waMessageId, status: o.status, timestamp: ts }] });
}
