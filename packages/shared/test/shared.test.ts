import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { can, decrypt, encrypt, hashPassword, isWindowOpen, parseWebhook, verifyMetaSignature, verifyPassword, sendWhatsAppText } from '../src/index.js';

describe('crypto', () => {
  it('round-trips tokens and rejects tampering', () => {
    const key = randomBytes(32);
    const c = encrypt('EAAG-secret', key);
    expect(c).not.toContain('EAAG');
    expect(decrypt(c, key)).toBe('EAAG-secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });
});

describe('roles', () => {
  it('moderators reply but cannot manage clients', () => {
    expect(can('MODERATOR', 'inbox:reply')).toBe(true);
    expect(can('MODERATOR', 'clients:manage')).toBe(false);
    expect(can('WRITER', 'inbox:reply')).toBe(false);
  });
});

describe('whatsapp', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account' });
  it('verifies Meta signatures', () => {
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false);
  });
  it('parses inbound messages and statuses', () => {
    const p = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '123' },
        contacts: [{ wa_id: '201000000000', profile: { name: 'منى' } }],
        messages: [{ from: '201000000000', id: 'wamid.A', timestamp: '1763600000', type: 'text', text: { body: 'السعر كام؟' } }],
        statuses: [{ id: 'wamid.B', status: 'read', timestamp: '1763600001' }]
      } }] }]
    });
    expect(p.messages[0]).toMatchObject({ phoneNumberId: '123', waId: '201000000000', contactName: 'منى', body: 'السعر كام؟' });
    expect(p.statuses[0]).toMatchObject({ waMessageId: 'wamid.B', status: 'read' });
  });
  it('enforces the 24h service window', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(isWindowOpen(new Date('2026-11-20T00:00:00Z'), now)).toBe(true);
    expect(isWindowOpen(new Date('2026-11-19T11:00:00Z'), now)).toBe(false);
    expect(isWindowOpen(null, now)).toBe(false);
  });
  it('sends text messages through the Graph API', async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] })); }) as any;
    const id = await sendWhatsAppText({ phoneNumberId: '123', token: 't', to: '2010', body: 'أهلا' }, fake);
    expect(id).toBe('wamid.X');
    expect(seen.url).toMatch(/\/123\/messages$/);
    expect(JSON.parse(seen.init.body).text.body).toBe('أهلا');
  });
});

import { totpCode, verifyTotp, base32Decode, base32Encode } from '../src/totp.js';
describe('totp', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1111111109_000)).toBe('081804');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('accepts one step of drift and nothing more', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_800_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, 'abc', now)).toBe(false);
  });
});

import { amountMinor, buildConfirmationTemplate, confirmAnswer, confirmFromText, fitsConfirmation, parseEasyOrders, parseShopify, phoneToWaId, utmFrom, verifyShopifyHmac, DEMO_TEMPLATES } from '../src/index.js';
import { createHmac as hmac } from 'node:crypto';

describe('store orders', () => {
  it('writes Egyptian phones as WhatsApp ids however they are typed', () => {
    for (const p of ['01012345678', '010 1234 5678', '+20 10 1234 5678', '00201012345678', '201012345678', '1012345678', '٠١٠١٢٣٤٥٦٧٨', '+20 010 1234 5678']) expect(phoneToWaId(p)).toBe('201012345678');
    expect(phoneToWaId('0123')).toBeNull();
    expect(phoneToWaId('')).toBeNull();
    expect(phoneToWaId('+966 50 123 4567')).toBe('966501234567');
  });
  it('reads money without float drift', () => {
    expect(amountMinor('149.50')).toBe(14950);
    expect(amountMinor(0.1 + 0.2)).toBe(30);
    expect(amountMinor('1,250')).toBe(125000);
    expect(amountMinor('12.999')).toBe(1299);
    expect(amountMinor('abc')).toBe(0);
  });
  it('parses EasyOrders orders and status updates', () => {
    const ev = parseEasyOrders({ id: 'abc-123', total_cost: '1260', shipping_cost: 60, status: 'pending', payment_method: 'cod', full_name: 'مريم', phone: '01012345678', cart_items: [{ price: 1200, quantity: 1, product: { name: 'عود' } }] });
    expect(ev).toMatchObject({ kind: 'order', order: { externalId: 'abc-123', totalMinor: 126000, cod: true, status: 'PENDING', items: [{ name: 'عود', qty: 1, priceMinor: 120000 }] } });
    expect(parseEasyOrders({ event_type: 'order-status-update', order_id: 'abc-123', new_status: 'Cancelled' })).toMatchObject({ kind: 'status', status: 'CANCELLED' });
    expect(parseEasyOrders({ event_type: 'product-updated', id: 'p1' }).kind).toBe('ignored');
  });
  it('parses Shopify orders, COD gateways, utm and shipment status', () => {
    const ev = parseShopify('orders/create', { id: 1, name: '#1001', total_price: '99.90', payment_gateway_names: ['Cash on Delivery (COD)'], landing_site: '/?utm_campaign=123&utm_source=fb', fulfillments: [{ shipment_status: 'delivered', tracking_number: 'T1' }] });
    expect(ev).toMatchObject({ kind: 'order', order: { number: '#1001', totalMinor: 9990, cod: true, utmCampaign: '123', utmSource: 'fb', status: 'DELIVERED' } });
    expect(parseShopify('orders/create', { id: 2, payment_gateway_names: ['shopify_payments'], financial_status: 'paid' })).toMatchObject({ order: { cod: false, status: 'CONFIRMED' } });
    expect(parseShopify('orders/updated', { id: 3, cancelled_at: '2026-01-01T00:00:00Z' })).toMatchObject({ order: { status: 'CANCELLED' } });
    expect(parseShopify('products/update', {}).kind).toBe('ignored');
    expect(utmFrom('not a url %%')).toMatchObject({ utmCampaign: null });
  });
  it('verifies Shopify signatures over the raw body', () => {
    const raw = '{"id":1}';
    const sig = hmac('sha256', 's3cret').update(raw).digest('base64');
    expect(verifyShopifyHmac(raw, sig, 's3cret')).toBe(true);
    expect(verifyShopifyHmac(raw + ' ', sig, 's3cret')).toBe(false);
    expect(verifyShopifyHmac(raw, undefined, 's3cret')).toBe(false);
  });
  it('builds the confirmation template with order payloads on both buttons', () => {
    const t = DEMO_TEMPLATES.find(x => x.name === 'order_confirmation')!;
    const like = { name: t.name, language: t.language, parameterFormat: 'POSITIONAL', components: t.components };
    expect(fitsConfirmation(like)).toBe(true);
    expect(fitsConfirmation({ ...like, components: DEMO_TEMPLATES.find(x => x.name === 'monthly_offer')!.components, parameterFormat: 'NAMED' })).toBe(false); // image header
    const b = buildConfirmationTemplate(like, 'ord1', { customer_name: 'مريم\nحسن', order_number: '#1', total: '100 جنيه' });
    expect(b.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'مريم حسن' }, { type: 'text', text: '#1' }, { type: 'text', text: '100 جنيه' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'dosly:confirm:ord1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'dosly:cancel:ord1' }] }
    ]);
    expect(b.rendered).toContain('مريم حسن');
    expect(confirmAnswer('dosly:cancel:ord1')).toEqual({ orderId: 'ord1', yes: false });
    expect(confirmAnswer('other')).toBeNull();
    expect(confirmFromText('تأكيد الطلب ✅')).toBe(true);
    expect(confirmFromText('إلغاء الطلب')).toBe(false);
    expect(confirmFromText('شكرا')).toBeNull();
  });
});
