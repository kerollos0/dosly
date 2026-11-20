import type { Db } from '@dosly/db';
import { demoInboundPayload, demoStatusPayload, type DemoMediaName } from '@dosly/shared';
import type { Publisher } from './events.js';
import { processWhatsAppWebhook, type WebhookHooks } from './webhooks.js';

/**
 * Demo traffic: fake customers who write in, and fake phones that mark replies delivered and read.
 * Every event goes through the same webhook processing as real Meta traffic, so a demo exercises
 * the real pipeline (idempotency, status ordering, realtime) and not a shortcut.
 */

export type DemoKind = 'cafe' | 'perfume' | 'clinic' | 'academy' | 'general';

export function demoKindOf(clientName: string): DemoKind {
  if (/كافيه|مطعم|كافي|مطبخ/.test(clientName)) return 'cafe';
  if (/عطور|عطر|برفان/.test(clientName)) return 'perfume';
  if (/عيادة|دكتور|د\.|أسنان/.test(clientName)) return 'clinic';
  if (/أكاديمية|كورس|تعليم|لغات/.test(clientName)) return 'academy';
  return 'general';
}

export const DEMO_OPENERS: Record<DemoKind, string[]> = {
  cafe: ['ممكن المنيو لو سمحت؟', 'عندكم توصيل للتجمع؟', 'عايز أحجز ترابيزة لـ 6 أفراد الخميس الساعة 8', 'الأوفر بتاع الويك إند لسه شغال؟', 'الطلب اتأخر ساعة، فين الأوردر؟', 'ينفع أطلب تورتة عيد ميلاد مكتوب عليها اسم؟'],
  perfume: ['البرفان اللي في البوست الأخير سعره كام؟', 'عندكم سامبل أجرّب قبل ما أشتري؟', 'الشحن لإسكندرية بياخد قد إيه؟', 'عايزة هدية لجوزي في حدود 1500 جنيه، ترشحولي إيه؟', 'الدفع عند الاستلام متاح؟', 'هو ده أصلي ولا تقليد؟'],
  clinic: ['عايز أحجز كشف يوم السبت', 'سعر تبييض الأسنان كام؟', 'الدكتورة موجودة النهارده لحد الساعة كام؟', 'عندي وجع جامد في ضرس العقل، ينفع أجي النهارده؟', 'بتقبلوا تأمين شركة مصر للتأمين؟', 'تقويم الأسنان بياخد وقت قد إيه؟'],
  academy: ['الكورس الجاي بيبدأ إمتى؟', 'في مستويات للأطفال؟', 'سعر كورس الإنجليزي كام وكام سيشن؟', 'ينفع أحضر سيشن تجريبية الأول؟', 'الكورسات أونلاين ولا في المقر بس؟', 'بتدوا شهادة في الآخر؟'],
  general: ['السلام عليكم، عايز أستفسر عن الأسعار', 'مواعيدكم إيه؟', 'العنوان فين بالظبط؟', 'ممكن حد يكلمني؟']
};

const FOLLOW_UPS = ['تمام، شكرًا جدًا 🙏', 'طب ينفع أدفع فودافون كاش؟', 'حلو، هأكدلكم بكرة', 'ماشي، ابعتلي اللوكيشن', 'تمام اتفقنا', 'مفيش خصم شوية؟ 😅', 'جزاكم الله خير'];

const FIRST = ['أحمد', 'محمد', 'مريم', 'سارة', 'يوسف', 'نور', 'كريم', 'هبة', 'مصطفى', 'ياسمين', 'عمر', 'منة', 'خالد', 'ريم', 'إسلام', 'دينا', 'مينا', 'مارينا', 'بيتر', 'شيماء'];
const LAST = ['حسن', 'إبراهيم', 'سمير', 'عادل', 'فؤاد', 'جرجس', 'شوقي', 'منصور', 'رمزي', 'الشريف'];

export const pick = <T>(xs: readonly T[], r = Math.random()): T => xs[Math.floor(r * xs.length) % xs.length]!;
export const demoName = () => `${pick(FIRST)} ${pick(LAST)}`;
export const demoPhone = () => `20${pick(['10', '11', '12', '15'])}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function apply(db: Db, payload: object, pub: Publisher, hooks?: WebhookHooks) {
  const event = await db.webhookEvent.create({ data: { source: 'demo', payload } });
  await processWhatsAppWebhook(db, payload, pub, hooks);
  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
}

/** A customer message arriving on one of the agency's numbers. New customer unless contactId is given. */
/** What a demo customer sends as a file, by business: a product photo, a voice note, a document. */
const MEDIA_CHOICES: Record<DemoKind, { media: DemoMediaName; body: string }[]> = {
  cafe: [{ media: 'voice', body: '' }],
  perfume: [{ media: 'photo', body: 'عايزة البرفان ده، متوفر؟' }, { media: 'voice', body: '' }],
  clinic: [{ media: 'voice', body: '' }],
  academy: [{ media: 'pricelist', body: 'ده اللي بعتوهولي، هو لسه ساري؟' }, { media: 'voice', body: '' }],
  general: [{ media: 'voice', body: '' }]
};

export async function simulateInbound(db: Db, pub: Publisher, o: { agencyId: string; clientId?: string; contactId?: string; body?: string; media?: DemoMediaName | 'random' }, hooks?: WebhookHooks) {
  let contact = o.contactId ? await db.contact.findFirst({ where: { id: o.contactId, agencyId: o.agencyId }, include: { waNumber: true, client: true } }) : null;
  if (o.contactId && !contact) throw new Error('Unknown demo contact');
  let number = contact?.waNumber ?? null;
  let clientName = contact?.client.name ?? '';
  if (!number) {
    const numbers = await db.whatsAppNumber.findMany({ where: { agencyId: o.agencyId, ...(o.clientId ? { clientId: o.clientId } : {}), client: { archivedAt: null } }, include: { client: true } });
    if (!numbers.length) throw new Error('No WhatsApp number to simulate on');
    const n = pick(numbers);
    number = n;
    clientName = n.client.name;
  }
  let body = o.body ?? (contact ? pick(FOLLOW_UPS) : pick(DEMO_OPENERS[demoKindOf(clientName)]));
  let media: DemoMediaName | undefined;
  // About one customer in five sends a photo, a voice note or a file, as real ones do.
  if (o.media === 'random' ? Math.random() < 0.2 : o.media) {
    const choice = o.media && o.media !== 'random' ? { media: o.media, body: o.body ?? '' } : pick(MEDIA_CHOICES[demoKindOf(clientName)]);
    media = choice.media; body = choice.body;
  }
  await apply(db, demoInboundPayload({ phoneNumberId: number.phoneNumberId, waId: contact?.waId ?? demoPhone(), name: contact?.name ?? demoName(), body, media }), pub, hooks);
}

/** Moves a sent demo message forward, the way a customer's phone would. */
export async function simulateStatus(db: Db, pub: Publisher, messageId: string, status: 'delivered' | 'read') {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { waNumber: true } } } });
  if (!msg?.waMessageId) return;
  await apply(db, demoStatusPayload({ phoneNumberId: msg.conversation.waNumber.phoneNumberId, waMessageId: msg.waMessageId, status }), pub);
}

/** The customer answers the agency's last reply. */
export async function simulateReply(db: Db, pub: Publisher, messageId: string, hooks?: WebhookHooks) {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
  if (!msg) return;
  await simulateInbound(db, pub, { agencyId: msg.agencyId, contactId: msg.conversation.contactId, media: Math.random() < 0.15 ? 'voice' : undefined }, hooks);
}
