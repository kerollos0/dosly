import { randomBytes } from 'node:crypto';
import type { Db, Prisma } from '@dosly/db';
import { demoCommentId, demoCommentPayload, demoHandle, demoPersonName, demoSocialMessagePayload, demoSocialUserId, type DemoMediaName } from '@dosly/shared';
import { DEMO_OPENERS, demoKindOf, pick, type DemoKind } from './demo.js';
import type { Publisher } from './events.js';
import { processMetaWebhook, type SocialHooks } from './social.js';

/**
 * Demo Facebook and Instagram traffic: comments on the client's published posts and direct messages
 * on Messenger and Instagram. Like the WhatsApp demo, every event is a Meta-shaped webhook that goes
 * through the real processing.
 */

type Tx = Prisma.TransactionClient;
const rid = () => randomBytes(8).toString('hex');

/** What Egyptian followers write under a business's posts: mostly "how much", some praise, some spam. */
export const DEMO_COMMENTS: Record<DemoKind, string[]> = {
  cafe: ['بكام الوجبة دي؟', 'شكلها تحفة 😍', 'عندكم فرع في مدينة نصر؟', 'التوصيل بياخد قد إيه؟', 'منشن لصاحبي @kareem هنروح الخميس', 'المكان زحمة يوم الجمعة؟'],
  perfume: ['بكام؟', 'السعر لو سمحت', 'متاح حجم 50 مل؟', 'جربته وريحته بتفضل طول اليوم ❤️', 'بتشحنوا للمنصورة؟', 'في عرض لو أخدت اتنين؟'],
  clinic: ['الكشف بكام؟', 'الدكتورة ممتازة ربنا يباركلها', 'في مواعيد الجمعة؟', 'التبييض بيوجع؟', 'ممكن رقم للحجز؟'],
  academy: ['الكورس ده أونلاين؟', 'السعر كام؟', 'في كورس للأطفال من سن 8؟', 'ابني اتعلم عندكم وبقى ممتاز 👏', 'التسجيل لسه مفتوح؟'],
  general: ['بكام؟', 'التفاصيل لو سمحت', 'جميل جدًا', 'العنوان فين؟']
};
const SPAM = ['اكسب 5000 جنيه في اليوم من البيت 💰💰 ادخل على اللينك في البروفايل', 'تابعوني وهتابعكم 🔥🔥🔥'];
const PAGE_REPLIES = ['أهلاً بيك! بعتنالك التفاصيل في الرسايل 💬', 'شكرًا جدًا لذوقك ❤️', 'أيوه متاح، ابعتلنا رسالة وهنرد عليك فورًا'];
const DM_FOLLOW_UPS = ['تمام شكرًا', 'طب ينفع الدفع عند الاستلام؟', 'ابعتلي العنوان بالظبط', 'حلو جدًا، هطلب بكرة إن شاء الله'];

export type SeedSocialInput = {
  agencyId: string; clientId: string; kind: DemoKind; moderatorId: string; now: Date;
  fb: { id: string; externalId: string }; ig: { id: string; externalId: string };
  posts: { accountId: string; platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; externalPostId: string; publishedAt: Date }[];
};

/** Comments on published posts and two direct-message conversations, so the demo opens with real-looking work. */
export async function seedSocial(tx: Tx, o: SeedSocialInput) {
  const minutes = (n: number) => new Date(o.now.getTime() - n * 60_000);
  const lines = DEMO_COMMENTS[o.kind];
  let n = 0;
  for (const [pi, p] of o.posts.entries()) {
    const age = Math.max(30, Math.round((o.now.getTime() - p.publishedAt.getTime()) / 60_000));
    const count = 2 + (pi % 3);
    for (let k = 0; k < count; k++) {
      const fromId = demoSocialUserId();
      const ig = p.platform === 'INSTAGRAM';
      const at = minutes(Math.max(3, Math.round(age * (1 - (k + 1) / (count + 1)))) - 0);
      const spam = k === count - 1 && pi % 2 === 1;
      const body = spam ? SPAM[pi % SPAM.length]! : lines[(n++ + pi) % lines.length]!;
      const answered = !spam && k === 0;
      const c = await tx.socialComment.create({ data: {
        agencyId: o.agencyId, clientId: o.clientId, socialAccountId: p.accountId, platform: p.platform, externalId: demoCommentId(fromId), postExternalId: p.externalPostId,
        authorId: fromId, authorName: ig ? demoHandle(fromId) : demoPersonName(fromId), body, createdAt: at,
        status: answered || (spam && pi % 4 === 1) ? 'DONE' : 'OPEN', isHidden: spam && pi % 4 === 1,
        privateReplyAt: answered && /بكام|السعر|كام/.test(body) ? new Date(at.getTime() + 8 * 60_000) : null
      } });
      if (answered) {
        await tx.socialComment.create({ data: {
          agencyId: o.agencyId, clientId: o.clientId, socialAccountId: p.accountId, platform: p.platform, externalId: `demo-reply-${rid()}`, postExternalId: p.externalPostId,
          parentExternalId: c.externalId, authorId: p.platform === 'INSTAGRAM' ? o.ig.externalId : o.fb.externalId, authorName: null, body: PAGE_REPLIES[pi % PAGE_REPLIES.length]!,
          fromPage: true, sentById: o.moderatorId, status: 'DONE', createdAt: new Date(at.getTime() + 6 * 60_000)
        } });
      }
    }
  }

  // Messenger: a new customer who saw a post, still waiting. Instagram: answered 30 hours ago, so only
  // the 7-day human agent window is left.
  const convs = [
    { acc: o.fb, channel: 'MESSENGER' as const, minsAgo: 9, lines: [['in', 'شفت البوست بتاعكم، ' + pick(DEMO_OPENERS[o.kind])]] },
    { acc: o.ig, channel: 'INSTAGRAM' as const, minsAgo: 30 * 60, lines: [['in', pick(DEMO_OPENERS[o.kind], 0.3)], ['out', 'أهلاً بيك! أكيد، هبعتلك كل التفاصيل حالًا'], ['in', 'تمام مستني']] }
  ];
  for (const c of convs) {
    const userId = demoSocialUserId();
    const contact = await tx.contact.create({ data: {
      agencyId: o.agencyId, clientId: o.clientId, socialAccountId: c.acc.id, externalId: userId, name: demoPersonName(userId), username: c.channel === 'INSTAGRAM' ? demoHandle(userId) : null
    } });
    const times = c.lines.map((_, k) => minutes(c.minsAgo + (c.lines.length - 1 - k) * 4));
    const lastIn = c.lines.map(l => l[0]).lastIndexOf('in');
    const awaiting = c.lines.at(-1)![0] === 'in';
    const conv = await tx.conversation.create({ data: {
      agencyId: o.agencyId, clientId: o.clientId, channel: c.channel, socialAccountId: c.acc.id, contactId: contact.id, status: 'OPEN',
      assigneeId: c.lines.some(l => l[0] === 'out') ? o.moderatorId : null, unreadCount: awaiting && c.minsAgo < 120 ? 1 : 0,
      lastMessageAt: times.at(-1)!, lastInboundAt: times[lastIn]!, lastPreview: c.lines.at(-1)![1]!.slice(0, 140), createdAt: times[0]!
    } });
    await tx.message.createMany({ data: c.lines.map(([dir, body], k) => ({
      agencyId: o.agencyId, conversationId: conv.id, direction: dir === 'in' ? 'IN' as const : 'OUT' as const, type: 'text', body: body!,
      waMessageId: `m_seed_${rid()}`, status: dir === 'in' ? 'RECEIVED' as const : 'READ' as const, sentById: dir === 'out' ? o.moderatorId : null, createdAt: times[k]!
    })) });
  }
}

async function apply(db: Db, payload: object, pub: Publisher, hooks?: SocialHooks) {
  const event = await db.webhookEvent.create({ data: { source: 'demo', payload } });
  await processMetaWebhook(db, payload, pub, hooks);
  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
}

/** A new comment on one of the agency's published posts, or a reply in an existing thread. */
export async function simulateComment(db: Db, pub: Publisher, o: { agencyId: string; clientId?: string; text?: string; platform?: 'FACEBOOK_PAGE' | 'INSTAGRAM' }) {
  const targets = await db.postTarget.findMany({
    where: { status: 'PUBLISHED', externalPostId: { not: null }, socialAccount: { agencyId: o.agencyId, ...(o.clientId ? { clientId: o.clientId } : {}), ...(o.platform ? { platform: o.platform } : {}), client: { archivedAt: null } } },
    include: { socialAccount: { include: { client: true } } }, orderBy: { publishedAt: 'desc' }, take: 20
  });
  if (!targets.length) return false;
  const t = pick(targets);
  const acc = t.socialAccount;
  const ig = acc.platform === 'INSTAGRAM';
  // One time in four, someone answers inside a thread the agency already replied to.
  const thread = Math.random() < 0.25 ? await db.socialComment.findFirst({ where: { socialAccountId: acc.id, postExternalId: t.externalPostId!, parentExternalId: null, fromPage: false, deletedAt: null }, orderBy: { createdAt: 'desc' } }) : null;
  const fromId = thread?.authorId ?? demoSocialUserId();
  const text = o.text ?? (thread ? pick(['شكرًا 🙏', 'بعتلكم على الخاص', 'طب والشحن؟']) : Math.random() < 0.08 ? pick(SPAM) : pick(DEMO_COMMENTS[demoKindOf(acc.client.name)]));
  await apply(db, demoCommentPayload({
    platform: acc.platform, accountId: acc.externalId, postId: t.externalPostId!, commentId: demoCommentId(fromId), fromId,
    fromName: ig ? demoHandle(fromId) : demoPersonName(fromId), text, parentId: thread?.externalId
  }), pub);
  return true;
}

/** A Messenger or Instagram direct message. New customer unless contactId is given. */
export async function simulateSocialMessage(db: Db, pub: Publisher, o: { agencyId: string; clientId?: string; contactId?: string; platform?: 'FACEBOOK_PAGE' | 'INSTAGRAM'; text?: string; media?: DemoMediaName }, hooks?: SocialHooks) {
  const contact = o.contactId ? await db.contact.findFirst({ where: { id: o.contactId, agencyId: o.agencyId, socialAccountId: { not: null } }, include: { socialAccount: { include: { client: true } } } }) : null;
  let acc = contact?.socialAccount ?? null;
  if (!acc) {
    const accounts = await db.socialAccount.findMany({ where: { agencyId: o.agencyId, ...(o.clientId ? { clientId: o.clientId } : {}), ...(o.platform ? { platform: o.platform } : {}), client: { archivedAt: null } }, include: { client: true } });
    if (!accounts.length) return false;
    acc = pick(accounts);
  }
  let customerId = contact?.externalId;
  if (!customerId) {
    // Meta's webhook carries no name; the real code asks the Graph API. The demo creates the contact first instead.
    customerId = demoSocialUserId();
    await db.contact.create({ data: { agencyId: acc.agencyId, clientId: acc.clientId, socialAccountId: acc.id, externalId: customerId, name: demoPersonName(customerId), username: acc.platform === 'INSTAGRAM' ? demoHandle(customerId) : null } });
  }
  const text = o.text ?? (o.media ? undefined : contact ? pick(DM_FOLLOW_UPS) : pick(DEMO_OPENERS[demoKindOf(acc.client.name)]));
  await apply(db, demoSocialMessagePayload({ platform: acc.platform, accountId: acc.externalId, customerId, text, media: o.media }), pub, hooks);
  return true;
}

/** The customer's app reports the agency's message as delivered or seen. */
export async function simulateSocialStatus(db: Db, pub: Publisher, messageId: string, status: 'delivered' | 'read') {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { include: { socialAccount: true, contact: true } } } });
  const acc = msg?.conversation.socialAccount;
  if (!msg?.waMessageId || !acc || !msg.conversation.contact.externalId) return;
  const ig = acc.platform === 'INSTAGRAM';
  if (ig && status === 'delivered') return; // Instagram reports only "seen"
  const ev = status === 'read' ? (ig ? { read: { mid: msg.waMessageId } } : { read: { watermark: Date.now() } }) : { delivery: { mids: [msg.waMessageId], watermark: Date.now() } };
  await apply(db, {
    object: ig ? 'instagram' : 'page',
    entry: [{ id: acc.externalId, time: Date.now(), messaging: [{ sender: { id: msg.conversation.contact.externalId }, recipient: { id: acc.externalId }, timestamp: Date.now(), ...ev }] }]
  }, pub);
}
