import type { Prisma } from '@dosly/db';

/**
 * Demo automatic replies: the café greets new people, says when it opens, answers "بكام" and price comments;
 * the perfume shop answers "السعر" comments in private. Counts look like a few weeks of use.
 */
type Input = { agencyId: string; ownerId: string; clients: { id: string; kind: string }[]; now: Date };

export async function seedDemoAutomations(tx: Prisma.TransactionClient, o: Input) {
  const ago = (h: number) => new Date(o.now.getTime() - h * 3600_000);
  const base = { agencyId: o.agencyId, createdById: o.ownerId, createdAt: ago(24 * 20) };
  const cafe = o.clients.find(c => c.kind === 'cafe');
  if (cafe) {
    await tx.autoRule.createMany({ data: [
      { ...base, clientId: cafe.id, kind: 'WELCOME', channels: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'], reply: 'أهلًا يا [الاسم] 👋 نورت كافيه نسمة! تحب تشوف المنيو ولا تحجز ترابيزة؟', fired: 64, lastFiredAt: ago(3) },
      { ...base, clientId: cafe.id, kind: 'AWAY', channels: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'], reply: 'أهلًا بيك 🌙 إحنا قافلين دلوقتي، بنفتح كل يوم من 8 الصبح لحد 1 بالليل. سيب رسالتك وهنرد عليك أول ما نفتح.', hours: { days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '01:00' }, fired: 17, lastFiredAt: ago(30) },
      { ...base, clientId: cafe.id, kind: 'KEYWORD', name: 'المنيو والأسعار', channels: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'], keywords: ['بكام', 'السعر', 'الأسعار', 'المنيو', 'منيو'], reply: 'المنيو كامل بالأسعار هنا 👇\nnesma.cafe/menu\nالكومبو بتاع الفطار لشخصين بـ 220 جنيه 😋', fired: 41, lastFiredAt: ago(1) },
      { ...base, clientId: cafe.id, kind: 'KEYWORD', name: 'العنوان', channels: ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'], keywords: ['العنوان', 'فين', 'لوكيشن', 'location'], reply: 'إحنا في التجمع الخامس، شارع التسعين الجنوبي، جنب البنك الأهلي 📍\nhttps://maps.app.goo.gl/nesma', fired: 23, lastFiredAt: ago(5) },
      { ...base, clientId: cafe.id, kind: 'COMMENT', name: 'أسعار تحت البوستات', platforms: ['FACEBOOK_PAGE', 'INSTAGRAM'], keywords: ['بكام', 'السعر', 'كام'], publicReplies: ['بعتنالك السعر في الرسايل يا [الاسم] 💬', 'شوف رسايلك، بعتنالك كل التفاصيل 🙏', 'وصلتك رسالة فيها السعر ❤️'], reply: 'أهلًا يا [الاسم] 👋 الوجبة اللي في البوست بـ 180 جنيه، والكومبو لشخصين بـ 220. تحب نحجزلك؟', fired: 38, lastFiredAt: ago(2) }
    ] });
  }
  const perfume = o.clients.find(c => c.kind === 'perfume');
  if (perfume) {
    await tx.autoRule.createMany({ data: [
      { ...base, clientId: perfume.id, kind: 'COMMENT', name: 'السعر في الخاص', platforms: ['FACEBOOK_PAGE', 'INSTAGRAM'], keywords: ['بكام', 'السعر', 'سعر', 'price'], publicReplies: ['بعتنالك السعر في الخاص ✨', 'شوفي رسايلك، بعتنالك العرض كامل 💜'], reply: 'أهلًا يا [الاسم] ✨ البرفان ده بـ 450 جنيه (50 مل)، والشحن مجاني لو أخدت اتنين. أطلبلك؟', fired: 52, lastFiredAt: ago(4) },
      { ...base, clientId: perfume.id, kind: 'KEYWORD', name: 'الشحن', channels: ['WHATSAPP', 'INSTAGRAM'], keywords: ['شحن', 'الشحن', 'توصيل', 'بتوصلوا'], reply: 'بنشحن لكل المحافظات 🚚 القاهرة والجيزة في يومين، وباقي المحافظات من 3 لـ 5 أيام. الدفع عند الاستلام.', fired: 19, lastFiredAt: ago(7) }
    ] });
  }
}
