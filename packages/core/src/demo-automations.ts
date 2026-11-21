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

/** What each demo client's AI assistant knows. The perfume shop's answers on its own; the others draft replies. */
const KNOWLEDGE: Record<string, string> = {
  perfume: `لمسة للعطور: متجر عطور أونلاين، بنشحن لكل محافظات مصر.
- عود ملكي 50 مل: 450 جنيه.
- مسك الطهارة 30 مل: 120 جنيه.
- برفان فانيليا ليدي 100 مل: 650 جنيه.
- عرض: أي اتنين برفان الشحن عليهم مجاني.
- الشحن: القاهرة والجيزة في يومين بـ 50 جنيه، باقي المحافظات من 3 لـ 5 أيام بـ 70 جنيه.
- الدفع: كاش عند الاستلام أو إنستاباي.
- الاستبدال خلال 14 يوم لو العلبة متفتحتش.
- الطلب من الموقع lamsa.store أو ابعت الاسم والعنوان والمنتج هنا.`,
  cafe: `كافيه نسمة: كافيه ومطبخ في التجمع الخامس، شارع التسعين الجنوبي جنب البنك الأهلي.
- مفتوحين كل يوم من 8 الصبح لحد 1 بالليل.
- كومبو الفطار لشخصين: 220 جنيه.
- الكرواسون بالشوكولاتة: 65 جنيه.
- القهوة الإسبريسو: 55 جنيه، واللاتيه: 75 جنيه.
- الحجز للترابيزات بالواتساب، وبنحجز لحد 10 أشخاص.
- في ركنة للأطفال وواي فاي مجاني.`,
  academy: `أكاديمية خطوة للغات: كورسات إنجليزي وفرنساوي للكبار والأطفال، أونلاين وفي الفرع في مصر الجديدة.
- كورس الإنجليزي للكبار: 8 مستويات، المستوى شهر ونص، 12 سيشن، سعره 1800 جنيه.
- كورس الأطفال (من 6 لـ 12 سنة): 1500 جنيه للمستوى.
- الفرنساوي: 2000 جنيه للمستوى.
- اختبار تحديد المستوى مجاني.
- المجموعات فيها 8 طلاب بالكتير.
- المستوى الجديد بيبدأ أول كل شهر.`
};

export async function seedDemoAssistants(tx: Prisma.TransactionClient, o: Input) {
  const counts = { perfume: [34, 51, 9], cafe: [22, 0, 0], academy: [15, 0, 0] } as Record<string, [number, number, number]>;
  for (const c of o.clients) {
    const knowledge = KNOWLEDGE[c.kind];
    if (!knowledge) continue;
    const [suggested, autoSent, handoffs] = counts[c.kind]!;
    await tx.aiAssistant.create({ data: {
      agencyId: o.agencyId, clientId: c.id, knowledge, suggested, autoSent, handoffs, updatedById: o.ownerId,
      mode: c.kind === 'perfume' ? 'AUTO' : 'SUGGEST', channels: c.kind === 'perfume' ? ['WHATSAPP', 'INSTAGRAM'] : []
    } });
  }
}
