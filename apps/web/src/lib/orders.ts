/** Store orders: types and plain-Arabic labels. Money is in minor units (piastres), like the ads. */

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED' | 'FAILED';
export type ConfirmState = 'NONE' | 'SENT' | 'CONFIRMED' | 'DECLINED' | 'NO_ANSWER' | 'NOT_SENT';
export type OrderItem = { name: string; variant?: string; qty: number; priceMinor: number };
export type Order = {
  id: string; clientId: string; storeId: string; externalId: string; number: string; status: OrderStatus; rawStatus: string | null; cod: boolean; paymentMethod: string | null;
  currency: string; totalMinor: number; shippingMinor: number; customerName: string | null; phone: string | null; city: string | null; address: string | null; items: OrderItem[];
  trackingNumber: string | null; trackingCompany: string | null; trackingUrl: string | null; shipmentStatus: string | null; attribution: 'utm' | 'whatsapp_ad' | null;
  confirm: ConfirmState; confirmSentAt: string | null; confirmedAt: string | null; confirmedBy: 'customer' | 'agent' | 'store' | null; confirmError: string | null;
  followUpDoneAt: string | null; placedAt: string; updatedAt: string;
  campaign: { id: string; name: string } | null; store: { name: string; kind: 'EASYORDERS' | 'SHOPIFY' }; client: { name: string }; conversationId: string | null;
};
export type SalesBlock = {
  currency: string; orders: number; valueMinor: number; sold: number; soldValueMinor: number; delivered: number; deliveredValueMinor: number;
  waiting: number; waitingValueMinor: number; lost: number; lostValueMinor: number;
};
export type StoreSales = { currencies: SalesBlock[]; byCampaign: Record<string, { orders: number; sold: number; soldValueMinor: number; currency: string }>; stores: number };
export type Store = {
  id: string; clientId: string; clientName: string; kind: 'EASYORDERS' | 'SHOPIFY'; name: string; currency: string; status: string; webhookUrl: string; hasSecret: boolean;
  lastOrderAt: string | null; lastError: string | null; orders: number; autoConfirm: boolean; waNumberId: string | null; confirmTemplate: string | null; confirmWaitMin: number;
  numbers: { id: string; displayPhone: string; status: string; templates: string[] }[]; usingTemplate: string | null;
};

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'sun';
export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'جديد', tone: 'info' }, CONFIRMED: { label: 'اتأكد', tone: 'good' }, PROCESSING: { label: 'بيتجهز', tone: 'info' },
  SHIPPED: { label: 'مع شركة الشحن', tone: 'info' }, DELIVERED: { label: 'اتسلّم', tone: 'good' },
  CANCELLED: { label: 'اتلغى', tone: 'neutral' }, RETURNED: { label: 'رجع', tone: 'bad' }, FAILED: { label: 'فشل', tone: 'bad' }
};

/** What happened with the WhatsApp confirmation, in one short phrase. */
export function confirmLabel(o: Pick<Order, 'confirm' | 'confirmedBy'>): { label: string; tone: Tone } | null {
  switch (o.confirm) {
    case 'NONE': return null;
    case 'SENT': return { label: 'مستني العميل يأكد', tone: 'sun' };
    case 'CONFIRMED': return { label: o.confirmedBy === 'agent' ? 'اتأكد بالتليفون' : o.confirmedBy === 'store' ? 'اتأكد من المتجر' : 'العميل أكد على واتساب', tone: 'good' };
    case 'DECLINED': return { label: o.confirmedBy === 'agent' ? 'اتلغى بالتليفون' : 'العميل لغى على واتساب', tone: 'bad' };
    case 'NO_ANSWER': return { label: 'العميل مردش', tone: 'warn' };
    case 'NOT_SENT': return { label: 'رسالة التأكيد متبعتتش', tone: 'bad' };
  }
}

/** Why a moderator should call, in words they can act on. */
export function followUpReason(o: Order): string {
  if (o.confirm === 'NO_ANSWER') return 'بعتنا رسالة التأكيد ومحدش رد. كلم العميل وأكد معاه.';
  if (o.confirm === 'DECLINED') return 'العميل داس "إلغاء". كلمه لو تقدر تنقذ البيعة، أو الغي الطلب من المتجر.';
  return o.confirmError && /[\u0600-\u06FF]/.test(o.confirmError) ? `${o.confirmError}.` : 'رسالة التأكيد مبعتتش. كلم العميل وأكد معاه.';
}

export const SHIPMENT: Record<string, string> = {
  label_printed: 'البوليصة اتطبعت', label_purchased: 'البوليصة اتعملت', confirmed: 'شركة الشحن استلمت البيانات', in_transit: 'في الطريق',
  out_for_delivery: 'خارج للتوصيل النهارده', attempted_delivery: 'حاولوا يوصلوه ومعرفوش', ready_for_pickup: 'جاهز للاستلام', picked_up: 'اتستلم من الفرع',
  delivered: 'اتسلّم', failure: 'التوصيل فشل'
};
export const STORE_KIND: Record<Store['kind'], string> = { EASYORDERS: 'EasyOrders', SHOPIFY: 'Shopify' };
