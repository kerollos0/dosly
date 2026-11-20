import type { Db, Prisma } from '@dosly/db';
import { randomUUID } from 'node:crypto';
import { CONFIRM_PAYLOAD, CANCEL_PAYLOAD, demoAdId, demoButtonPayload, demoCampaignId, moneyText, type OrderStatusName } from '@dosly/shared';
import type { Publisher } from './events.js';
import { demoName, demoPhone, pick } from './demo.js';
import { processStoreWebhook, type OrderDeps } from './orders.js';
import { processWhatsAppWebhook, type WebhookHooks } from './webhooks.js';

/**
 * Demo store traffic: an EasyOrders perfume shop and a Shopify cafe shop. New orders go through
 * the real webhook parsing and confirmation flow; the fake customer presses a button on the
 * WhatsApp confirmation like a real one would (most confirm, some cancel, some never answer).
 */

export type DemoStoreKind = 'perfume' | 'cafe';
type Product = { name: string; variant?: string; price: number };
const PRODUCTS: Record<DemoStoreKind, Product[]> = {
  perfume: [
    { name: 'عود ملكي', variant: 'الحجم: 100 مل', price: 1200 }, { name: 'ليل القاهرة', variant: 'الحجم: 50 مل', price: 750 }, { name: 'عنبر وخشب', variant: 'الحجم: 100 مل', price: 1350 },
    { name: 'علبة سامبلز (5 قطع)', price: 250 }, { name: 'مسك الطهارة', variant: 'الحجم: 30 مل', price: 320 }, { name: 'بخور هدية', price: 150 }
  ],
  cafe: [
    { name: 'تورتة شوكولاتة', variant: 'كبيرة', price: 750 }, { name: 'تورتة ريد فيلفت', variant: 'صغيرة', price: 450 }, { name: 'بن نسمة المحوج', variant: '250 جرام', price: 280 },
    { name: 'بوكس كوكيز', variant: '12 قطعة', price: 320 }, { name: 'كرواسون (6 قطع)', price: 210 }
  ]
};
const CITIES = ['القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'المنصورة', 'طنطا', 'أسيوط'];
const STREETS = ['شارع التسعين', 'شارع عباس العقاد', 'شارع فيصل', 'شارع جمال عبد الناصر', 'شارع الهرم', 'شارع مصطفى النحاس'];
const SHIPPING = 60;

function basket(kind: DemoStoreKind) {
  const items = Array.from({ length: Math.random() < 0.7 ? 1 : 2 }, () => ({ ...pick(PRODUCTS[kind]), qty: Math.random() < 0.85 ? 1 : 2 }));
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return { items, subtotal, total: subtotal + SHIPPING };
}
const localPhone = (waId: string) => `0${waId.slice(2)}`; // 2010... -> 010..., the way customers type it

/** An EasyOrders "order created" body, shaped like the documented payload. */
export function demoEasyOrderBody(o: { id: string; name: string; phone: string; kind: DemoStoreKind; at: Date; status?: string; utmCampaign?: string }) {
  const b = basket(o.kind);
  return {
    id: o.id, created_at: o.at.toISOString(), updated_at: o.at.toISOString(), store_id: 'demo-store', status: o.status ?? 'pending', payment_method: 'cod',
    cost: b.subtotal, shipping_cost: SHIPPING, total_cost: b.total, full_name: o.name, phone: o.phone, government: pick(CITIES), address: `${Math.floor(Math.random() * 90) + 1} ${pick(STREETS)}`,
    cart_items: b.items.map(i => ({ price: i.price, quantity: i.qty, product: { name: i.name }, ...(i.variant ? { variant: { variation_props: [{ variation: i.variant.split(': ')[0], variation_prop: i.variant.split(': ')[1] ?? i.variant }] } } : {}) })),
    ...(o.utmCampaign ? { landing_page: `https://lamsa.example/products/oud?utm_source=facebook&utm_campaign=${o.utmCampaign}` } : {})
  };
}

/** A Shopify orders/create body, with the fields Dosly reads. */
export function demoShopifyOrderBody(o: { id: string; number: number; name: string; phone: string; kind: DemoStoreKind; at: Date; utmCampaign?: string }) {
  const b = basket(o.kind);
  const [first, ...rest] = o.name.split(' ');
  return {
    id: Number(o.id), name: `#${o.number}`, order_number: o.number, created_at: o.at.toISOString(), updated_at: o.at.toISOString(), currency: 'EGP',
    total_price: b.total.toFixed(2), total_shipping_price_set: { shop_money: { amount: SHIPPING.toFixed(2), currency_code: 'EGP' } },
    financial_status: 'pending', fulfillment_status: null, cancelled_at: null, payment_gateway_names: ['Cash on Delivery (COD)'],
    landing_site: o.utmCampaign ? `/products/cake?utm_source=facebook&utm_medium=paid&utm_campaign=${o.utmCampaign}` : '/', phone: null,
    customer: { first_name: first, last_name: rest.join(' '), phone: o.phone },
    shipping_address: { name: o.name, phone: o.phone, address1: `${Math.floor(Math.random() * 90) + 1} ${pick(STREETS)}`, city: pick(CITIES), province: pick(CITIES), country: 'Egypt' },
    line_items: b.items.map(i => ({ title: i.name, variant_title: i.variant ?? null, quantity: i.qty, price: i.price.toFixed(2) })),
    fulfillments: []
  };
}

/**
 * A new order on one of the agency's demo stores, delivered through the same parsing as a real
 * webhook. One customer in three already chats with the client on WhatsApp.
 */
export async function simulateOrder(deps: OrderDeps, o: { agencyId: string; clientId?: string }, now = new Date()) {
  const { db } = deps;
  const stores = await db.storeConnection.findMany({ where: { agencyId: o.agencyId, ...(o.clientId ? { clientId: o.clientId } : {}), client: { archivedAt: null } }, include: { client: { select: { name: true } } } });
  if (!stores.length) return null;
  const store = pick(stores);
  const kind: DemoStoreKind = store.kind === 'SHOPIFY' ? 'cafe' : 'perfume';
  const known = Math.random() < 0.33 ? await db.contact.findFirst({ where: { clientId: store.clientId, waNumberId: { not: null }, waId: { not: null } }, orderBy: { createdAt: 'desc' }, skip: Math.floor(Math.random() * 5) }) : null;
  const waId = known?.waId ?? demoPhone();
  const name = known?.name ?? demoName();
  const account = await db.adAccount.findFirst({ where: { clientId: store.clientId }, select: { externalId: true } });
  const utmCampaign = account && Math.random() < 0.5 ? demoCampaignId(account.externalId, '1') : undefined;
  const count = await db.storeOrder.count({ where: { storeId: store.id } });
  const body = store.kind === 'SHOPIFY'
    ? demoShopifyOrderBody({ id: String(5_000_000_000 + Math.floor(Math.random() * 1e9)), number: 1100 + count, name, phone: `+${waId}`, kind, at: now, utmCampaign })
    : demoEasyOrderBody({ id: randomUUID(), name, phone: localPhone(waId), kind, at: now, utmCampaign });
  const payload = { storeId: store.id, topic: store.kind === 'SHOPIFY' ? 'orders/create' : undefined, body };
  const event = await db.webhookEvent.create({ data: { source: 'demo', payload: payload as Prisma.InputJsonValue } });
  const r = await processStoreWebhook(deps, payload, now);
  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  return r.orderId ?? null;
}

/**
 * The fake customer's answer to a confirmation that just went out: three in four confirm, one in
 * ten cancels, and the rest never answer (so the order shows up for a moderator later).
 */
export async function simulateConfirmPress(db: Db, pub: Publisher, messageId: string, hooks: WebhookHooks = {}, r = Math.random()) {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { waNumber: true, contact: true } } } });
  const orderId = (msg?.payload as { orderId?: string } | null)?.orderId;
  if (!msg?.waMessageId || !orderId || !msg.conversation.waNumber || !msg.conversation.contact.waId) return null;
  if (r >= 0.85) return 'silent';
  const yes = r < 0.75;
  const payload = demoButtonPayload({
    phoneNumberId: msg.conversation.waNumber.phoneNumberId, waId: msg.conversation.contact.waId, name: msg.conversation.contact.name ?? undefined,
    text: yes ? 'تأكيد الطلب ✅' : 'إلغاء الطلب', payload: `${yes ? CONFIRM_PAYLOAD : CANCEL_PAYLOAD}${orderId}`, contextId: msg.waMessageId
  });
  const event = await db.webhookEvent.create({ data: { source: 'demo', payload } });
  await processWhatsAppWebhook(db, payload, pub, hooks);
  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  return yes ? 'confirmed' : 'declined';
}

// ---------- seed ----------

type SeedContact = { id: string; waId: string; name: string; conversationId: string };
export type SeedOrdersInput = {
  agencyId: string; clientId: string; storeId: string; kind: DemoStoreKind; storeKind: 'EASYORDERS' | 'SHOPIFY';
  adExternalId: string; waNumberId: string; tag: string; ci: number; contacts: SeedContact[]; now: Date;
};

/**
 * A month of orders for a demo store: most sold, some cancelled or returned, a few waiting.
 * About 40% came from the sales campaign (utm), and some customers from a Click-to-WhatsApp ad.
 * The newest ones show each confirmation outcome in the inbox, including ones a moderator must call.
 */
export async function seedDemoOrders(tx: Prisma.TransactionClient, o: SeedOrdersInput) {
  const minutes = (m: number) => new Date(o.now.getTime() - m * 60_000);
  const rows: Prisma.StoreOrderCreateManyInput[] = [];
  let n = 0;
  const make = (at: Date, status: OrderStatusName, extra: Partial<Prisma.StoreOrderCreateManyInput> & { name?: string; waId?: string } = {}) => {
    const b = basket(o.kind);
    const waId = extra.waId ?? demoPhone();
    const { name, waId: _w, ...rest } = extra;
    n++;
    return {
      agencyId: o.agencyId, clientId: o.clientId, storeId: o.storeId, externalId: `demo-${o.tag}-${o.ci}-${n}`,
      number: o.storeKind === 'SHOPIFY' ? `#${1000 + n}` : `EO${(48210 + n * 7).toString(36).toUpperCase()}`,
      status, rawStatus: status.toLowerCase(), cod: true, paymentMethod: 'cod', currency: 'EGP',
      totalMinor: BigInt(b.total * 100), shippingMinor: BigInt(SHIPPING * 100), customerName: name ?? demoName(), phone: localPhone(waId), waId,
      city: pick(CITIES), address: `${Math.floor(Math.random() * 90) + 1} ${pick(STREETS)}`,
      items: b.items.map(i => ({ name: i.name, variant: i.variant, qty: i.qty, priceMinor: i.price * 100 })) as Prisma.InputJsonValue,
      placedAt: at, confirm: status === 'PENDING' ? 'NONE' as const : 'CONFIRMED' as const, confirmedBy: status === 'PENDING' ? null : 'customer',
      confirmedAt: status === 'PENDING' ? null : new Date(at.getTime() + 20 * 60_000),
      ...(status === 'SHIPPED' || status === 'DELIVERED' ? { trackingCompany: pick(['بوسطة', 'أرامكس', 'J&T Express']), trackingNumber: `EG${Math.floor(Math.random() * 1e9)}` } : {}),
      ...rest
    } satisfies Prisma.StoreOrderCreateManyInput;
  };
  // History: 1-3 orders a day for four weeks.
  for (let day = 28; day >= 1; day--) {
    const count = 1 + Math.floor(Math.random() * 3) + (day % 7 === 4 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const at = minutes(day * 1440 - 10 * 60 - Math.floor(Math.random() * 11 * 60));
      const r = Math.random();
      const status: OrderStatusName = day <= 2 ? (r < 0.5 ? 'CONFIRMED' : r < 0.8 ? 'PROCESSING' : 'SHIPPED') : day <= 5 ? (r < 0.6 ? 'SHIPPED' : r < 0.9 ? 'DELIVERED' : 'CANCELLED') : (r < 0.78 ? 'DELIVERED' : r < 0.9 ? 'CANCELLED' : 'RETURNED');
      const fromAd = Math.random() < 0.4;
      rows.push(make(at, status, fromAd ? { utmSource: 'facebook', utmCampaign: demoCampaignId(o.adExternalId, '1') } : {}));
    }
  }
  // Click-to-WhatsApp customers: their chat came from ad 2's first ad, their order a day later.
  const ctwa = o.contacts.slice(0, 2);
  for (const [i, c] of ctwa.entries()) {
    await tx.contact.update({ where: { id: c.id }, data: { adId: demoAdId(o.adExternalId, '2', 1), adReferredAt: minutes((i + 2) * 1440 + 60) } });
    rows.push(make(minutes((i + 2) * 1440 - 600), i ? 'SHIPPED' : 'DELIVERED', { name: c.name, waId: c.waId, contactId: c.id }));
  }
  await tx.storeOrder.createMany({ data: rows });

  // The newest orders, each with its WhatsApp confirmation in the inbox.
  const live: { c: SeedContact | null; ago: number; outcome: 'confirmed' | 'no_answer' | 'waiting' | 'declined' | 'not_sent' }[] = [
    { c: o.contacts[2] ?? null, ago: 95, outcome: 'confirmed' },
    { c: o.contacts[3] ?? null, ago: 60 * 3 + 20, outcome: 'no_answer' },
    { c: o.contacts[4] ?? null, ago: 12, outcome: 'waiting' },
    { c: null, ago: 60 * 5, outcome: 'declined' },
    { c: null, ago: 40, outcome: 'not_sent' }
  ];
  for (const [i, l] of live.entries()) {
    const at = minutes(l.ago);
    const name = l.c?.name ?? demoName();
    const waId = l.outcome === 'not_sent' ? undefined : l.c?.waId ?? demoPhone();
    const base = make(at, 'PENDING', { name, ...(waId ? { waId } : {}) });
    if (l.outcome === 'not_sent') {
      await tx.storeOrder.create({ data: { ...base, phone: '0123', waId: null, confirm: 'NOT_SENT', confirmError: 'رقم موبايل العميل مش مظبوط، لازم مكالمة' } });
      continue;
    }
    // A contact and conversation for customers who had not written before.
    let contactId = l.c?.id, conversationId = l.c?.conversationId;
    if (!contactId) {
      const contact = await tx.contact.create({ data: { agencyId: o.agencyId, clientId: o.clientId, waNumberId: o.waNumberId, waId: waId!, name } });
      const conv = await tx.conversation.create({ data: { agencyId: o.agencyId, clientId: o.clientId, waNumberId: o.waNumberId, contactId: contact.id, status: 'PENDING', lastMessageAt: at, createdAt: at } });
      contactId = contact.id; conversationId = conv.id;
    }
    const order = await tx.storeOrder.create({ data: { ...base, contactId, confirm: 'NONE', confirmedBy: null, confirmedAt: null } });
    const sentAt = new Date(at.getTime() + 30_000);
    const body = `أهلاً ${name.split(' ')[0]} 👋 وصلنا طلبك رقم ${order.number} بإجمالي ${moneyText(Number(order.totalMinor), 'EGP')} والدفع عند الاستلام. تأكد الطلب عشان نجهزه ونشحنه؟`;
    const tpl = await tx.message.create({ data: {
      agencyId: o.agencyId, conversationId: conversationId!, direction: 'OUT', type: 'template', body, status: l.outcome === 'waiting' ? 'DELIVERED' : 'READ', createdAt: sentAt,
      waMessageId: `wamid.DEMOC.${o.tag}.${o.ci}.${i}`,
      payload: { kind: 'template', orderId: order.id, rendered: { footer: 'لو في أي تعديل ابعتلنا هنا', buttons: ['تأكيد الطلب ✅', 'إلغاء الطلب'] }, template: { name: 'order_confirmation', language: { code: 'ar' } } }
    } });
    let last = { at: sentAt, preview: body.slice(0, 140) };
    if (l.outcome === 'confirmed' || l.outcome === 'declined') {
      const yes = l.outcome === 'confirmed';
      const pressAt = new Date(sentAt.getTime() + 6 * 60_000);
      const ack = yes ? `تمام يا ${name.split(' ')[0]} ✅ طلبك رقم ${order.number} اتأكد وهيتجهز للشحن. لو محتاج أي حاجة ابعتلنا هنا.` : `تمام، لغينا طلبك رقم ${order.number}. لو حابب تطلب تاني أو عندك أي سؤال ابعتلنا هنا 🙏`;
      await tx.message.createMany({ data: [
        { agencyId: o.agencyId, conversationId: conversationId!, direction: 'IN', type: 'button', body: yes ? 'تأكيد الطلب ✅' : 'إلغاء الطلب', status: 'RECEIVED', waMessageId: `wamid.DEMOCB.${o.tag}.${o.ci}.${i}`, createdAt: pressAt },
        { agencyId: o.agencyId, conversationId: conversationId!, direction: 'OUT', type: 'text', body: ack, status: 'READ', waMessageId: `wamid.DEMOCA.${o.tag}.${o.ci}.${i}`, createdAt: new Date(pressAt.getTime() + 2000) }
      ] });
      last = { at: new Date(pressAt.getTime() + 2000), preview: ack.slice(0, 140) };
      await tx.storeOrder.update({ where: { id: order.id }, data: { confirm: yes ? 'CONFIRMED' : 'DECLINED', confirmedBy: 'customer', confirmedAt: pressAt, confirmMessageId: tpl.id, confirmSentAt: sentAt } });
      await tx.conversation.update({ where: { id: conversationId! }, data: { lastInboundAt: pressAt } });
    } else {
      await tx.storeOrder.update({ where: { id: order.id }, data: { confirm: l.outcome === 'waiting' ? 'SENT' : 'NO_ANSWER', confirmMessageId: tpl.id, confirmSentAt: sentAt } });
    }
    // A chat the customer started keeps its own last message if it is newer.
    await tx.conversation.updateMany({ where: { id: conversationId!, lastMessageAt: { lt: last.at } }, data: { lastMessageAt: last.at, lastPreview: last.preview } });
  }
}
