import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processStoreWebhook, processWhatsAppWebhook, requestConfirmation, storeSales, sweepConfirmations, type OrderDeps, type RealtimeEvent, type StoreWebhookPayload } from '@dosly/core';
import { DEMO_TEMPLATES } from '@dosly/shared';
import { db, makeApp, owner, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const PHONE_ID = '1445980835268017';
const EO_SECRET = 'eo-secret-1234567890';

async function setup() {
  const { app, calls } = await makeApp(url => (url.includes(PHONE_ID) ? { display_phone_number: '+20 10 0000 0000', verified_name: 'لمسة' } : {}));
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
  const num = (await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: PHONE_ID, wabaId: '1', accessToken: 'EAAG-test-token-123456789' })).json();
  const confirmT = DEMO_TEMPLATES.find(t => t.name === 'order_confirmation')!;
  await db.waTemplate.create({ data: { agencyId: (await db.client.findUniqueOrThrow({ where: { id: client.id } })).agencyId, waNumberId: num.id, metaId: confirmT.id, name: confirmT.name, language: 'ar', status: 'APPROVED', category: 'UTILITY', parameterFormat: 'POSITIONAL', components: confirmT.components as object } });
  const storeRes = await as('POST', '/api/stores', { clientId: client.id, kind: 'EASYORDERS', name: 'متجر لمسة', secret: EO_SECRET });
  if (storeRes.statusCode !== 201) throw new Error(storeRes.body);
  const store = storeRes.json();
  const sent: string[] = [];
  const events: RealtimeEvent[] = [];
  const deps: OrderDeps = { db, pub: { publish: (_a, e) => { events.push(e); } }, onSend: async id => { sent.push(id); } };
  return { app, calls, as, client, num, store, deps, sent, events };
}

const eoOrder = (over: Record<string, unknown> = {}) => ({
  id: 'b7a1c2d3-0000-4000-8000-000000000001', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), store_id: 's1',
  cost: 1200, shipping_cost: 60, total_cost: 1260, status: 'pending', payment_method: 'cod',
  full_name: 'مريم حسن', phone: '010 1234 5678', government: 'القاهرة', address: '12 شارع التسعين',
  cart_items: [{ price: 1200, quantity: 1, product: { name: 'عود ملكي', sku: 'OUD-100' }, variant: { variation_props: [{ variation: 'الحجم', variation_prop: '100 مل' }] } }],
  ...over
});

/** Posts to the store webhook, then runs what the worker would on the stored event. */
async function deliver(s: Awaited<ReturnType<typeof setup>>, body: unknown, headers: Record<string, string> = { secret: EO_SECRET }) {
  const hookId = s.store.webhookUrl.split('/').pop();
  const res = await s.app.inject({ method: 'POST', url: `/webhooks/store/${hookId}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  if (res.statusCode === 200 && s.calls.webhooks.length) {
    const ev = await db.webhookEvent.findUniqueOrThrow({ where: { id: s.calls.webhooks.at(-1)! } });
    if (!ev.processedAt) { await processStoreWebhook(s.deps, ev.payload as unknown as StoreWebhookPayload); await db.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date() } }); }
  }
  return res;
}

const press = (payload: string, contextId: string, text = 'تأكيد الطلب ✅', from = '201012345678') => ({
  object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from, profile: { name: 'مريم' } }],
    messages: [{ from, id: `wamid.press.${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', context: { from: PHONE_ID, id: contextId }, button: { text, payload } }]
  } }] }]
});

describe('store orders', () => {
  it('rejects EasyOrders deliveries without the right secret and never stores them', async () => {
    const s = await setup();
    expect((await deliver(s, eoOrder(), {})).statusCode).toBe(401);
    expect((await deliver(s, eoOrder(), { secret: 'wrong-secret-xxxxxxxx' })).statusCode).toBe(401);
    expect(await db.webhookEvent.count()).toBe(0);
    expect((await db.storeConnection.findFirstOrThrow()).lastError).toContain('غلط');
    expect((await s.app.inject({ method: 'POST', url: '/webhooks/store/nope', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
    // the secret never comes back from the API
    expect((await s.as('GET', '/api/stores')).body).not.toContain(EO_SECRET);
  });

  it('turns an EasyOrders order into a COD order and sends a WhatsApp confirmation with order buttons', async () => {
    const s = await setup();
    expect((await deliver(s, eoOrder())).statusCode).toBe(200);
    const order = await db.storeOrder.findFirstOrThrow();
    expect(order).toMatchObject({ status: 'PENDING', cod: true, waId: '201012345678', totalMinor: 126000n, shippingMinor: 6000n, city: 'القاهرة', confirm: 'SENT' });
    expect(order.items).toEqual([{ name: 'عود ملكي', variant: 'الحجم: 100 مل', qty: 1, priceMinor: 120000 }]);
    const msg = await db.message.findUniqueOrThrow({ where: { id: order.confirmMessageId! } });
    expect(s.sent).toEqual([msg.id]);
    expect(msg.body).toContain('مريم');
    expect(msg.body).toContain('1,260 جنيه');
    const p = msg.payload as { template: { components: { type: string; sub_type?: string; parameters: { payload?: string; text?: string }[] }[] } };
    expect(p.template.components.filter(c => c.type === 'button').map(c => c.parameters[0]!.payload)).toEqual([`dosly:confirm:${order.id}`, `dosly:cancel:${order.id}`]);
    expect(p.template.components[0]!.parameters.map(x => x.text)).toEqual(['مريم', order.number, '1,260 جنيه']);

    // The same order again (EasyOrders retried): still one order, one confirmation.
    await deliver(s, eoOrder());
    expect(await db.storeOrder.count()).toBe(1);
    expect(await db.message.count({ where: { type: 'template' } })).toBe(1);
  });

  it('confirms on the button press, thanks the customer, and ignores a press from someone else', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    const order = await db.storeOrder.findFirstOrThrow();
    await db.message.update({ where: { id: order.confirmMessageId! }, data: { waMessageId: 'wamid.confirm1', status: 'SENT' } });

    // Another customer replaying the payload cannot confirm someone else's order.
    await processWhatsAppWebhook(db, press(`dosly:confirm:${order.id}`, 'wamid.confirm1', 'تأكيد', '201099999999'), s.deps.pub, { onSend: s.deps.onSend });
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).confirm).toBe('SENT');

    await processWhatsAppWebhook(db, press(`dosly:confirm:${order.id}`, 'wamid.confirm1'), s.deps.pub, { onSend: s.deps.onSend });
    const after = await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ confirm: 'CONFIRMED', confirmedBy: 'customer' });
    const thanks = await db.message.findFirstOrThrow({ where: { direction: 'OUT', type: 'text' } });
    expect(thanks.body).toContain('اتأكد');
    expect(s.sent).toContain(thanks.id);
    // pressing again does not thank twice
    await processWhatsAppWebhook(db, press(`dosly:confirm:${order.id}`, 'wamid.confirm1'), s.deps.pub, { onSend: s.deps.onSend });
    expect(await db.message.count({ where: { direction: 'OUT', type: 'text' } })).toBe(1);

    // A sold order counts in sales even though the store still says "pending".
    const sales = await storeSales(db, { agencyId: order.agencyId, clientIds: 'all', from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 60_000) });
    expect(sales.currencies[0]).toMatchObject({ currency: 'EGP', orders: 1, sold: 1, soldValueMinor: 126000 });
  });

  it('reads a press on an older template by its words, and cancel wins', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    const order = await db.storeOrder.findFirstOrThrow();
    await db.message.update({ where: { id: order.confirmMessageId! }, data: { waMessageId: 'wamid.confirm2' } });
    await processWhatsAppWebhook(db, press('', 'wamid.confirm2', 'إلغاء الطلب'), s.deps.pub, { onSend: s.deps.onSend });
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).confirm).toBe('DECLINED');
    // a cancelled-on-WhatsApp order waits for a moderator
    expect((await s.as('GET', '/api/orders?view=followup')).json().items.map((o: { id: string }) => o.id)).toEqual([order.id]);
  });

  it('flags confirmations nobody answered, and ones Meta refused, for moderators to call', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    await deliver(s, eoOrder({ id: 'b7a1c2d3-0000-4000-8000-000000000002', phone: '01198765432' }));
    const [a, b] = await db.storeOrder.findMany({ orderBy: { createdAt: 'asc' } });
    await db.message.update({ where: { id: b!.confirmMessageId! }, data: { status: 'FAILED', error: '131026: Message undeliverable' } });
    expect(await sweepConfirmations(db, s.deps.pub, new Date(Date.now() + 30 * 60_000))).toEqual({ noAnswer: 0, failed: 1 });
    expect(await sweepConfirmations(db, s.deps.pub, new Date(Date.now() + 121 * 60_000))).toEqual({ noAnswer: 1, failed: 0 });
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: a!.id } })).confirm).toBe('NO_ANSWER');
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: b!.id } })).confirmError).toContain('131026');

    const today = (await s.as('GET', '/api/today')).json();
    expect(today.ordersToCall).toBe(2);
    // confirmed on the phone: off the list
    const r = await s.as('POST', `/api/orders/${a!.id}/action`, { action: 'confirm' });
    expect(r.json()).toMatchObject({ confirm: 'CONFIRMED', confirmedBy: 'agent' });
    expect((await s.as('GET', '/api/orders/counts')).json()).toMatchObject({ followUp: 1 });
    // resend works for an order still pending
    const again = await s.as('POST', `/api/orders/${b!.id}/action`, { action: 'resend' });
    expect(again.json().confirm).toBe('SENT');
    expect((await s.as('POST', `/api/orders/${b!.id}/action`, { action: 'resend' })).statusCode).toBe(409);
  });

  it('records orders it cannot confirm (bad phone, no template) as needing a call', async () => {
    const s = await setup();
    await deliver(s, eoOrder({ phone: '12345' }));
    expect(await db.storeOrder.findFirstOrThrow()).toMatchObject({ confirm: 'NOT_SENT', waId: null });
    await db.waTemplate.deleteMany();
    await deliver(s, eoOrder({ id: 'b7a1c2d3-0000-4000-8000-000000000003' }));
    expect((await db.storeOrder.findFirstOrThrow({ where: { externalId: 'b7a1c2d3-0000-4000-8000-000000000003' } })).confirmError).toContain('قالب');
    // paid online: no confirmation at all
    await deliver(s, eoOrder({ id: 'b7a1c2d3-0000-4000-8000-000000000004', payment_method: 'card' }));
    expect((await db.storeOrder.findFirstOrThrow({ where: { externalId: 'b7a1c2d3-0000-4000-8000-000000000004' } })).confirm).toBe('NONE');
  });

  it('applies EasyOrders status updates, and a store confirmation settles a flagged order', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    const order = await db.storeOrder.findFirstOrThrow();
    await db.storeOrder.update({ where: { id: order.id }, data: { confirm: 'NO_ANSWER' } });
    await deliver(s, { event_type: 'order-status-update', order_id: order.externalId, old_status: 'pending', new_status: 'confirmed' });
    expect(await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CONFIRMED', confirm: 'CONFIRMED', confirmedBy: 'store' });
    await deliver(s, { event_type: 'order-status-update', order_id: order.externalId, new_status: 'in_delivery' });
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SHIPPED');
    // unknown orders (placed before connecting) are skipped, not created half-empty
    await deliver(s, { event_type: 'order-status-update', order_id: 'not-ours', new_status: 'delivered' });
    expect(await db.storeOrder.count()).toBe(1);
  });

  it('checks Shopify signatures, stores a delivery once, matches utm_campaign to the campaign, and follows shipments', async () => {
    const s = await setup();
    const shop = (await s.as('POST', '/api/stores', { clientId: s.client.id, kind: 'SHOPIFY', name: 'lamsa.myshopify.com', secret: 'shpss_client_secret_123' })).json();
    const acc = await db.adAccount.create({ data: { agencyId: (await db.client.findUniqueOrThrow({ where: { id: s.client.id } })).agencyId, clientId: s.client.id, externalId: '777', name: 'Lamsa', currency: 'EGP', timezoneName: 'Africa/Cairo', accessTokenEnc: 'x' } });
    const camp = await db.adCampaign.create({ data: { adAccountId: acc.id, externalId: '120210000000001', name: 'مبيعات | عود ملكي', status: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
    await db.adInsightDaily.create({ data: { campaignId: camp.id, date: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }), spendMinor: 50000n } });
    const hookId = shop.webhookUrl.split('/').pop();
    const order = {
      id: 5_550_001, name: '#1042', created_at: new Date().toISOString(), updated_at: '2026-11-20T10:00:00Z', currency: 'EGP', total_price: '1350.00',
      financial_status: 'pending', fulfillment_status: null, cancelled_at: null, payment_gateway_names: ['Cash on Delivery (COD)'],
      landing_site: '/products/oud?utm_source=facebook&utm_campaign=120210000000001&fbclid=abc', customer: { first_name: 'هبة', last_name: 'منصور' },
      shipping_address: { name: 'هبة منصور', phone: '+20 111 222 3333', address1: '5 شارع فيصل', city: 'الجيزة', province: 'Giza' },
      line_items: [{ title: 'عنبر وخشب', variant_title: '100 مل', quantity: 1, price: '1290.00' }], fulfillments: []
    };
    const post = async (topic: string, body: unknown, id: string, secret = 'shpss_client_secret_123') => {
      const raw = JSON.stringify(body);
      const res = await s.app.inject({ method: 'POST', url: `/webhooks/store/${hookId}`, payload: raw, headers: {
        'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-webhook-id': id, 'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64')
      } });
      const ev = res.statusCode === 200 ? await db.webhookEvent.findFirst({ where: { dedupeKey: { endsWith: id } } }) : null;
      if (ev && !ev.processedAt) { await processStoreWebhook(s.deps, ev.payload as unknown as StoreWebhookPayload); await db.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date() } }); }
      return res;
    };
    expect((await post('orders/create', order, 'w1', 'wrong')).statusCode).toBe(401);
    expect((await post('orders/create', order, 'w1')).statusCode).toBe(200);
    expect((await post('orders/create', order, 'w1')).statusCode).toBe(200); // Shopify retry
    expect(await db.webhookEvent.count({ where: { source: 'store' } })).toBe(1);
    const row = await db.storeOrder.findFirstOrThrow({ where: { storeId: shop.id } });
    expect(row).toMatchObject({ number: '#1042', campaignId: camp.id, attribution: 'utm', waId: '201112223333', fbclid: 'abc', totalMinor: 135000n, confirm: 'SENT' });

    // An older copy arriving late changes nothing; a newer one with a cancellation does.
    await post('orders/updated', { ...order, updated_at: '2026-11-20T09:00:00Z', cancelled_at: '2026-11-20T09:00:00Z' }, 'w2');
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
    await post('fulfillments/update', { order_id: 5_550_001, tracking_company: 'Bosta', tracking_number: 'BST123', tracking_url: 'https://bosta.co/t/BST123', shipment_status: 'out_for_delivery' }, 'w3');
    expect(await db.storeOrder.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'SHIPPED', trackingNumber: 'BST123', shipmentStatus: 'out_for_delivery', confirm: 'CONFIRMED', confirmedBy: 'store' });

    // The ads page puts the real sales next to the spend: 1350 sold for 500 spent.
    const ov = (await s.as('GET', `/api/ads/overview?clientId=${s.client.id}&days=7`)).json();
    expect(ov.currencies[0]).toMatchObject({ currency: 'EGP', roas: 2.7, sales: { sold: 1, soldValueMinor: 135000 } });
    expect(ov.campaigns.find((c: { id: string }) => c.id === camp.id).store).toMatchObject({ orders: 1, sold: 1, roas: 2.7 });
  });

  it('shows the customer orders beside the chat, only to people who see that client', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    const order = await db.storeOrder.findFirstOrThrow();
    const conv = await db.conversation.findFirstOrThrow();
    const res = (await s.as('GET', `/api/conversations/${conv.id}/orders`)).json();
    expect(res.hasStore).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ id: order.id, totalMinor: 126000, conversationId: conv.id, store: { kind: 'EASYORDERS' } });

    // A moderator not assigned to this client sees nothing of it; a writer has no orders access at all.
    const invite = async (role: string) => {
      const { link } = (await s.as('POST', '/api/team/invites', { email: `${role.toLowerCase()}@test.eg`, role })).json();
      const r = await s.app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: role, password: 'very-secret-pass' } });
      return session(s.app, r.cookies.find(c => c.name === 'dosly_session')!.value);
    };
    const mod = await invite('MODERATOR');
    expect((await mod('GET', `/api/conversations/${conv.id}/orders`)).statusCode).toBe(403);
    expect((await mod('GET', '/api/orders?view=all')).json().items).toEqual([]);
    expect((await mod('POST', `/api/orders/${order.id}/action`, { action: 'done' })).statusCode).toBe(403);
    const writer = await invite('WRITER');
    expect((await writer('GET', '/api/orders')).statusCode).toBe(403);
    expect((await mod('GET', '/api/stores')).statusCode).toBe(403);
  });

  it('links a Click-to-WhatsApp customer to the ad campaign when they order', async () => {
    const s = await setup();
    const agencyId = (await db.client.findUniqueOrThrow({ where: { id: s.client.id } })).agencyId;
    const acc = await db.adAccount.create({ data: { agencyId, clientId: s.client.id, externalId: '778', name: 'Lamsa', currency: 'EGP', timezoneName: 'Africa/Cairo', accessTokenEnc: 'x' } });
    const camp = await db.adCampaign.create({ data: { adAccountId: acc.id, externalId: '1202', name: 'رسايل', status: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
    await db.adAd.create({ data: { adAccountId: acc.id, externalId: '120299', campaignId: camp.id } });
    await processWhatsAppWebhook(db, { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: '201012345678', profile: { name: 'مريم' } }],
      messages: [{ from: '201012345678', id: 'wamid.ctwa1', timestamp: String(Math.floor(Date.now() / 1000) - 3600), type: 'text', text: { body: 'السعر كام؟' }, referral: { source_url: 'https://fb.me/x', source_id: '120299', source_type: 'ad', ctwa_clid: 'clid' } }]
    } }] }] }, s.deps.pub);
    expect((await db.contact.findFirstOrThrow()).adId).toBe('120299');
    await deliver(s, eoOrder());
    expect(await db.storeOrder.findFirstOrThrow()).toMatchObject({ campaignId: camp.id, attribution: 'whatsapp_ad' });
  });

  it('never sends a confirmation for an old order a store re-sends', async () => {
    const s = await setup();
    await deliver(s, eoOrder({ created_at: new Date(Date.now() - 3 * 86400_000).toISOString() }));
    expect((await db.storeOrder.findFirstOrThrow()).confirm).toBe('NONE');
    const r = await requestConfirmation(s.deps, (await db.storeOrder.findFirstOrThrow()).id);
    expect(r.sent).toBe(true); // a moderator can still ask for it
  });

  it('handles deliveries of one order at once: one order, one confirmation, the newest state wins', async () => {
    const s = await setup();
    const store = await db.storeConnection.findFirstOrThrow();
    const t0 = new Date(Date.now() - 60_000).toISOString(), t1 = new Date().toISOString();
    const payload = (body: unknown): StoreWebhookPayload => ({ storeId: store.id, topic: null, body });
    await Promise.all([
      processStoreWebhook(s.deps, payload(eoOrder({ updated_at: t0 }))),
      processStoreWebhook(s.deps, payload(eoOrder({ updated_at: t1, status: 'confirmed' }))),
      processStoreWebhook(s.deps, payload(eoOrder({ updated_at: t0 })))
    ]);
    expect(await db.storeOrder.count()).toBe(1);
    expect((await db.storeOrder.findFirstOrThrow()).status).toBe('CONFIRMED');
    expect(await db.message.count({ where: { type: 'template' } })).toBeLessThanOrEqual(1);
  });

  it('retries a confirmation that failed to go out, and a late status never moves an order back', async () => {
    const s = await setup();
    const store = await db.storeConnection.findFirstOrThrow();
    let fail = true;
    const flaky: OrderDeps = { ...s.deps, onSend: async id => { if (fail) throw new Error('redis down'); s.sent.push(id); } };
    await expect(processStoreWebhook(flaky, { storeId: store.id, topic: null, body: eoOrder() })).rejects.toThrow('redis down');
    fail = false;
    await processStoreWebhook(flaky, { storeId: store.id, topic: null, body: eoOrder() }); // the job's retry
    const order = await db.storeOrder.findFirstOrThrow();
    expect(order.confirm).toBe('SENT');
    expect(s.sent).toEqual([order.confirmMessageId]);

    const status = (n: string) => processStoreWebhook(s.deps, { storeId: store.id, topic: null, body: { event_type: 'order-status-update', order_id: order.externalId, old_status: 'x', new_status: n } });
    await status('delivered');
    await status('shipped');
    expect((await db.storeOrder.findFirstOrThrow()).status).toBe('DELIVERED');
  });

  it('never lets an old button press override what a moderator settled on the phone', async () => {
    const s = await setup();
    await deliver(s, eoOrder());
    const order = await db.storeOrder.findFirstOrThrow();
    await db.message.update({ where: { id: order.confirmMessageId! }, data: { waMessageId: 'wamid.confirm9', status: 'SENT' } });
    expect((await s.as('POST', `/api/orders/${order.id}/action`, { action: 'cancel' })).statusCode).toBe(200);
    await processWhatsAppWebhook(db, press(`dosly:confirm:${order.id}`, 'wamid.confirm9'), s.deps.pub, { onSend: s.deps.onSend });
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).confirm).toBe('DECLINED');
    expect(await db.message.count({ where: { direction: 'OUT', type: 'text' } })).toBe(0);
  });
});
