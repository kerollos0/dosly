import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TemplateComponent, TemplateLike } from './wa-templates.js';
import { placeholders } from './wa-templates.js';

/**
 * Online store orders (EasyOrders and Shopify), reduced to one shape. Pure functions only: parsing,
 * signatures, phone numbers and the WhatsApp confirmation template. See research/store-orders.md.
 */

export type StoreKindName = 'EASYORDERS' | 'SHOPIFY';
export type OrderStatusName = 'PENDING' | 'CONFIRMED' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED' | 'FAILED';
export type OrderItem = { name: string; variant?: string; qty: number; priceMinor: number };

export type ParsedOrder = {
  externalId: string;
  number: string;
  status: OrderStatusName;
  rawStatus: string | null;
  cod: boolean;
  paymentMethod: string | null;
  currency: string | null;
  totalMinor: number;
  shippingMinor: number;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  address: string | null;
  items: OrderItem[];
  placedAt: Date;
  updatedAt: Date | null;
  utmSource: string | null;
  utmCampaign: string | null;
  fbclid: string | null;
  tracking: Tracking | null;
};
export type Tracking = { number: string | null; company: string | null; url: string | null; shipmentStatus: string | null };

export type StoreEvent =
  | { kind: 'order'; order: ParsedOrder }
  | { kind: 'status'; externalId: string; status: OrderStatusName; rawStatus: string; paid: boolean }
  | { kind: 'fulfillment'; externalId: string; tracking: Tracking; status: OrderStatusName | null }
  | { kind: 'ignored'; reason: string };

/** Statuses that count as a real sale. A PENDING order the customer confirmed on WhatsApp counts too. */
export const SOLD_STATUSES: readonly OrderStatusName[] = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
export const LOST_STATUSES: readonly OrderStatusName[] = ['CANCELLED', 'RETURNED', 'FAILED'];

export const ORDER_STATUS_AR: Record<OrderStatusName, string> = {
  PENDING: 'جديد', CONFIRMED: 'اتأكد', PROCESSING: 'بيتجهز', SHIPPED: 'مع شركة الشحن', DELIVERED: 'اتسلّم', CANCELLED: 'اتلغى', RETURNED: 'رجع', FAILED: 'فشل'
};

/** How far an order is, for "a newer status never goes backwards" on out-of-order deliveries of the same kind. */
const STATUS_ORDER: Record<OrderStatusName, number> = { PENDING: 0, CONFIRMED: 1, PROCESSING: 2, SHIPPED: 3, DELIVERED: 4, CANCELLED: 5, RETURNED: 5, FAILED: 5 };
export const statusRank = (s: OrderStatusName) => STATUS_ORDER[s];

// ---------- money and text ----------

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** "149.50", 149.5 or "1,250" to minor units (piastres / cents), without float drift. */
export function amountMinor(v: unknown): number {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '0') : typeof v === 'string' ? v.replace(/[,\s]/g, '') : '';
  const m = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) return 0;
  const frac = ((m[3] ?? '') + '00').slice(0, 2);
  const n = Number(m[2]) * 100 + Number(frac);
  return m[1] ? -n : n;
}

const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------- phones ----------

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * A phone as a WhatsApp id (country code + number, digits only). Egyptian numbers are written many
 * ways (01012345678, +20 10 1234 5678, 0020..., Arabic digits); all become 201012345678.
 * Returns null when it can't be a mobile number.
 */
export function phoneToWaId(phone: string | null | undefined, defaultCountry = '20'): string | null {
  if (!phone) return null;
  let d = phone.replace(ARABIC_DIGITS, c => String(c.charCodeAt(0) & 0xf)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (defaultCountry === '20') {
    if (/^01[0125]\d{8}$/.test(d)) return `20${d.slice(1)}`;
    if (/^1[0125]\d{8}$/.test(d)) return `20${d}`;
    if (/^201[0125]\d{8}$/.test(d)) return d;
    if (/^2001[0125]\d{8}$/.test(d)) return `20${d.slice(3)}`; // +20 0 10...
  }
  return d.length >= 8 && d.length <= 15 && !d.startsWith('0') ? d : null;
}

// ---------- attribution ----------

/** utm_source, utm_campaign and fbclid from a landing URL ("/products/x?utm_campaign=..." or a full URL). */
export function utmFrom(url: string | null | undefined): { utmSource: string | null; utmCampaign: string | null; fbclid: string | null } {
  const none = { utmSource: null, utmCampaign: null, fbclid: null };
  if (!url) return none;
  try {
    const u = new URL(url, 'https://store.invalid');
    const g = (k: string) => u.searchParams.get(k)?.trim().slice(0, 200) || null;
    return { utmSource: g('utm_source'), utmCampaign: g('utm_campaign'), fbclid: g('fbclid') };
  } catch { return none; }
}

// ---------- EasyOrders ----------

const EASY_STATUS: Record<string, OrderStatusName> = {
  pending: 'PENDING', new: 'PENDING', paid: 'PENDING', // paid is a payment state: the order still has to ship
  confirmed: 'CONFIRMED',
  processing: 'PROCESSING', preparing: 'PROCESSING', ready: 'PROCESSING',
  shipped: 'SHIPPED', in_delivery: 'SHIPPED', out_for_delivery: 'SHIPPED', shipping: 'SHIPPED',
  delivered: 'DELIVERED', completed: 'DELIVERED',
  canceled: 'CANCELLED', cancelled: 'CANCELLED', rejected: 'CANCELLED',
  returned: 'RETURNED', refunded: 'RETURNED',
  failed: 'FAILED'
};
export function easyStatus(raw: string | null | undefined): OrderStatusName | null {
  const k = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return EASY_STATUS[k] ?? null;
}

type Json = Record<string, any>;

function easyItems(cart: unknown): OrderItem[] {
  if (!Array.isArray(cart)) return [];
  return cart.slice(0, 100).map((c: Json) => {
    const props = Array.isArray(c?.variant?.variation_props) ? c.variant.variation_props : [];
    const variant = props.map((p: Json) => [p?.variation, p?.variation_prop].filter(Boolean).join(': ')).filter(Boolean).join('، ') || undefined;
    return { name: (str(c?.product?.name) ?? str(c?.name) ?? 'منتج').slice(0, 200), variant: variant?.slice(0, 200), qty: Math.max(1, Math.floor(Number(c?.quantity) || 1)), priceMinor: amountMinor(c?.price) };
  });
}

/** One EasyOrders webhook body: a whole new order, or `{ event_type: "order-status-update", order_id, new_status }`. */
export function parseEasyOrders(body: unknown): StoreEvent {
  const b = (body ?? {}) as Json;
  if (b.event_type === 'order-status-update') {
    const id = str(b.order_id);
    const raw = str(b.new_status);
    if (!id || !raw) return { kind: 'ignored', reason: 'status update without order_id or new_status' };
    return { kind: 'status', externalId: id, status: easyStatus(raw) ?? 'PROCESSING', rawStatus: raw, paid: raw.toLowerCase() === 'paid' };
  }
  const id = str(b.id);
  if (!id || !('total_cost' in b || 'cart_items' in b)) return { kind: 'ignored', reason: `not an order (${str(b.event_type) ?? 'no event_type'})` };
  const raw = str(b.status);
  const pay = str(b.payment_method);
  const shipping = amountMinor(b.shipping_cost);
  // Defensive: EasyOrders documents no tracking fields, but read the common names if a store sends them.
  const utm = utmFrom(str(b.landing_page) ?? str(b.landing_url) ?? str(b.source_url));
  const created = date(b.created_at) ?? new Date();
  return {
    kind: 'order',
    order: {
      externalId: id, number: str(b.short_id) ?? str(b.order_number) ?? id.replace(/-/g, '').slice(0, 8).toUpperCase(),
      status: easyStatus(raw) ?? 'PENDING', rawStatus: raw,
      cod: !pay || /cod|cash|استلام/i.test(pay), paymentMethod: pay,
      currency: str(b.currency)?.toUpperCase() ?? null,
      totalMinor: amountMinor(b.total_cost), shippingMinor: shipping,
      customerName: str(b.full_name)?.slice(0, 200) ?? null, phone: str(b.phone)?.slice(0, 40) ?? null,
      city: str(b.government)?.slice(0, 120) ?? null, address: str(b.address)?.slice(0, 500) ?? null,
      items: easyItems(b.cart_items), placedAt: created, updatedAt: date(b.updated_at),
      utmSource: str(b.utm_source) ?? utm.utmSource, utmCampaign: str(b.utm_campaign) ?? utm.utmCampaign, fbclid: str(b.fbclid) ?? utm.fbclid,
      tracking: null
    }
  };
}

/** EasyOrders sends the webhook secret as-is in a `secret` header. */
export function verifyEasyOrdersSecret(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Shopify ----------

/** X-Shopify-Hmac-SHA256: base64 HMAC-SHA256 of the raw body with the app's client secret. */
export function verifyShopifyHmac(raw: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(header, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const SHIP_STATUS: Record<string, OrderStatusName> = {
  label_printed: 'PROCESSING', label_purchased: 'PROCESSING', confirmed: 'PROCESSING', ready_for_pickup: 'SHIPPED',
  in_transit: 'SHIPPED', out_for_delivery: 'SHIPPED', attempted_delivery: 'SHIPPED', picked_up: 'SHIPPED',
  delivered: 'DELIVERED', failure: 'FAILED'
};

function shopifyTracking(f: Json | undefined): Tracking | null {
  if (!f) return null;
  return { number: str(f.tracking_number) ?? str(f.tracking_numbers?.[0]), company: str(f.tracking_company), url: str(f.tracking_url) ?? str(f.tracking_urls?.[0]), shipmentStatus: str(f.shipment_status) };
}

/** Order status from a Shopify order: cancelled and refunded first, then how far fulfilment got. */
export function shopifyStatus(o: Json, tracking: Tracking | null): OrderStatusName {
  if (o.cancelled_at) return 'CANCELLED';
  if (o.financial_status === 'refunded') return 'RETURNED';
  const ship = tracking?.shipmentStatus ? SHIP_STATUS[tracking.shipmentStatus] : undefined;
  if (ship) return ship;
  if (o.fulfillment_status === 'fulfilled') return 'SHIPPED';
  if (o.fulfillment_status === 'partial') return 'PROCESSING';
  if (o.financial_status === 'paid') return 'CONFIRMED';
  return 'PENDING';
}

function shopifyOrder(o: Json): ParsedOrder | null {
  const id = str(o.id);
  if (!id) return null;
  const gateways: string[] = Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names.map(String) : [];
  const cod = gateways.some(g => /cash on delivery|cod|الدفع عند الاستلام|manual/i.test(g)) || (!gateways.length && o.financial_status === 'pending');
  const fulfillments: Json[] = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const tracking = shopifyTracking(fulfillments[fulfillments.length - 1]);
  const sa = (o.shipping_address ?? {}) as Json;
  const cust = (o.customer ?? {}) as Json;
  const name = str(sa.name) ?? ([str(cust.first_name), str(cust.last_name)].filter(Boolean).join(' ') || null);
  const utm = utmFrom(str(o.landing_site));
  const items: OrderItem[] = (Array.isArray(o.line_items) ? o.line_items : []).slice(0, 100).map((l: Json) => ({
    name: (str(l.title) ?? str(l.name) ?? 'منتج').slice(0, 200), variant: str(l.variant_title)?.slice(0, 200) ?? undefined,
    qty: Math.max(1, Math.floor(Number(l.quantity) || 1)), priceMinor: amountMinor(l.price)
  }));
  return {
    externalId: id, number: str(o.name) ?? `#${str(o.order_number) ?? id}`,
    status: shopifyStatus(o, tracking), rawStatus: [str(o.financial_status), str(o.fulfillment_status)].filter(Boolean).join('/') || null,
    cod, paymentMethod: gateways.join(', ') || null, currency: str(o.currency)?.toUpperCase() ?? null,
    totalMinor: amountMinor(o.total_price), shippingMinor: amountMinor(o.total_shipping_price_set?.shop_money?.amount),
    customerName: name?.slice(0, 200) ?? null, phone: (str(sa.phone) ?? str(o.phone) ?? str(cust.phone))?.slice(0, 40) ?? null,
    city: (str(sa.province) ?? str(sa.city))?.slice(0, 120) ?? null, address: [str(sa.address1), str(sa.address2), str(sa.city)].filter(Boolean).join('، ').slice(0, 500) || null,
    items, placedAt: date(o.created_at) ?? new Date(), updatedAt: date(o.updated_at), ...utm, tracking
  };
}

/** One Shopify webhook by its X-Shopify-Topic. */
export function parseShopify(topic: string | undefined, body: unknown): StoreEvent {
  const b = (body ?? {}) as Json;
  switch (topic) {
    case 'orders/create': case 'orders/updated': case 'orders/cancelled': case 'orders/paid': case 'orders/fulfilled': case 'orders/partially_fulfilled': {
      const order = shopifyOrder(b);
      return order ? { kind: 'order', order } : { kind: 'ignored', reason: 'order without id' };
    }
    case 'fulfillments/create': case 'fulfillments/update': {
      const id = str(b.order_id);
      const tracking = shopifyTracking(b);
      if (!id || !tracking) return { kind: 'ignored', reason: 'fulfillment without order_id' };
      return { kind: 'fulfillment', externalId: id, tracking, status: tracking.shipmentStatus ? SHIP_STATUS[tracking.shipmentStatus] ?? null : 'SHIPPED' };
    }
    default: return { kind: 'ignored', reason: `topic ${topic ?? 'missing'}` };
  }
}

// ---------- WhatsApp confirmation ----------

export const CONFIRM_PAYLOAD = 'dosly:confirm:';
export const CANCEL_PAYLOAD = 'dosly:cancel:';

/** The confirmation answer in a button reply payload: which order, and yes or no. */
export function confirmAnswer(payload: string | null | undefined): { orderId: string; yes: boolean } | null {
  if (!payload) return null;
  if (payload.startsWith(CONFIRM_PAYLOAD)) return { orderId: payload.slice(CONFIRM_PAYLOAD.length), yes: true };
  if (payload.startsWith(CANCEL_PAYLOAD)) return { orderId: payload.slice(CANCEL_PAYLOAD.length), yes: false };
  return null;
}

const CONFIRM_WORDS = /(تأكيد|تاكيد|أكد|اكد|confirm)/i;
const CANCEL_WORDS = /(إلغاء|الغاء|إلغي|الغي|cancel)/i;
/** A button press whose payload was lost (an older template): read the button's own words. Cancel wins a tie. */
export function confirmFromText(text: string | null | undefined): boolean | null {
  if (!text || text.length > 40) return null;
  if (CANCEL_WORDS.test(text)) return false;
  if (CONFIRM_WORDS.test(text)) return true;
  return null;
}

const quickReplies = (t: TemplateLike) => {
  const comps = (Array.isArray(t.components) ? t.components : []) as TemplateComponent[];
  return (comps.find(c => c.type === 'BUTTONS')?.buttons ?? []).map((b, i) => ({ ...b, index: i })).filter(b => b.type === 'QUICK_REPLY');
};

/**
 * Whether a template can confirm orders: no media header, at most three body variables, and two
 * quick replies (the first confirms, the second cancels).
 */
export function fitsConfirmation(t: TemplateLike & { status?: string; category?: string }): boolean {
  const comps = (Array.isArray(t.components) ? t.components : []) as TemplateComponent[];
  const header = comps.find(c => c.type === 'HEADER');
  if (header && header.format && header.format !== 'TEXT') return false;
  if (header?.text && placeholders(header.text, t.parameterFormat.toUpperCase() === 'NAMED').length) return false;
  const body = comps.find(c => c.type === 'BODY');
  if (!body || placeholders(body.text, t.parameterFormat.toUpperCase() === 'NAMED').length > 3) return false;
  return quickReplies(t).length >= 2;
}

/** Variables the confirmation fills, in order (positional) or by name (named). */
export const CONFIRM_VARS = ['customer_name', 'order_number', 'total'] as const;

/** The `template` message for one order: body variables plus a payload on each quick reply naming the order. */
export function buildConfirmationTemplate(t: TemplateLike, orderId: string, values: { customer_name: string; order_number: string; total: string }) {
  const isNamed = t.parameterFormat.toUpperCase() === 'NAMED';
  const comps = (Array.isArray(t.components) ? t.components : []) as TemplateComponent[];
  const keys = placeholders(comps.find(c => c.type === 'BODY')?.text, isNamed);
  // Meta rejects new lines and long runs of spaces in variables, so names are flattened.
  const clean = (v: string) => v.replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200) || '-';
  const valueFor = (k: string, i: number) => clean(isNamed ? (values as Record<string, string>)[k] ?? '' : values[CONFIRM_VARS[i] ?? 'customer_name']);
  const components: Record<string, unknown>[] = [];
  if (keys.length) components.push({ type: 'body', parameters: keys.map((k, i) => ({ type: 'text', text: valueFor(k, i), ...(isNamed ? { parameter_name: k } : {}) })) });
  const qr = quickReplies(t);
  qr.slice(0, 2).forEach((b, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(b.index), parameters: [{ type: 'payload', payload: `${i === 0 ? CONFIRM_PAYLOAD : CANCEL_PAYLOAD}${orderId}` }] }));
  const body = comps.find(c => c.type === 'BODY')?.text ?? '';
  const rendered = body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_all, k: string) => valueFor(k, keys.indexOf(k)));
  return { template: { name: t.name, language: { code: t.language }, components }, rendered, buttons: qr.map(b => b.text) };
}

/** "1,250 ج.م" style text for a WhatsApp message (no Intl currency symbols, which read badly in Arabic). */
export function moneyText(minor: number, currency: string): string {
  const v = minor / 100;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return currency === 'EGP' ? `${s} جنيه` : `${s} ${currency}`;
}
