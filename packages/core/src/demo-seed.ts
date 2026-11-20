import type { Db, Prisma, Role } from '@dosly/db';
import { DEMO_MEDIA, DEMO_TEMPLATES, demoCampaignId, encrypt, hashPassword, randomToken, type DemoMediaName } from '@dosly/shared';
import { DEMO_OPENERS, demoName, demoPhone, pick, type DemoKind } from './demo.js';
import { previewText } from './media.js';
import { seedSocial, type SeedSocialInput } from './demo-social.js';
import type { MediaStore } from './media-store.js';

/**
 * Builds one demo sandbox: an agency with a team, four clients, connected channels,
 * live-looking conversations and a month of posts. Every visitor who presses "try the demo"
 * gets their own copy, so nobody sees anyone else's changes, and the worker deletes it later.
 */

export const DEMO_TTL_HOURS = 24;

type Line = ['in' | 'out', string];
const SCRIPTS: Record<Exclude<DemoKind, 'general'>, Line[][]> = {
  cafe: [
    [['in', 'ممكن المنيو لو سمحت؟'], ['out', 'أهلًا بيك في نسمة ☕ ده المنيو كامل، ولو حابب نرشحلك حاجة قولنا'], ['in', 'الكرواسون بالشوكولاتة متاح النهارده؟']],
    [['in', 'عايز أحجز ترابيزة لـ 6 أفراد الخميس الساعة 8'], ['out', 'تمام، محتاجين الاسم ورقم الموبايل ونأكدلك الحجز'], ['in', 'كريم عادل 01012345678'], ['out', 'اتأكد الحجز يا كريم، مستنيينك الخميس الساعة 8 🌿'], ['in', 'تمام شكرًا']],
    [['in', 'عندكم توصيل للتجمع؟'], ['out', 'أيوه بنوصّل التجمع الخامس، والتوصيل 30 جنيه'], ['in', 'طب الأوردر بياخد قد إيه؟']],
    [['in', 'الطلب اتأخر ساعة، فين الأوردر؟']],
    [['in', 'ينفع أطلب تورتة عيد ميلاد مكتوب عليها اسم؟'], ['out', 'أكيد، محتاجينها قبلها بيومين. الحجم الصغير 450 والكبير 750'], ['in', 'هاخد الكبيرة يوم السبت، مكتوب عليها "Happy Birthday Nour"']]
  ],
  perfume: [
    [['in', 'البرفان اللي في البوست الأخير سعره كام؟'], ['out', 'ده "عود ملكي" 100 مل بـ 1200 جنيه، ومعاه سامبل هدية'], ['in', 'الدفع عند الاستلام متاح؟']],
    [['in', 'عايزة هدية لجوزي في حدود 1500 جنيه، ترشحولي إيه؟'], ['out', 'نرشحلك "ليل القاهرة" أو "عنبر وخشب"، الاتنين ثباتهم عالي وفي الميزانية'], ['in', 'ابعتلي صور الاتنين لو سمحت'], ['out', 'اتبعتوا، والعلبة الهدية مجانًا 🎁']],
    [['in', 'الشحن لإسكندرية بياخد قد إيه؟'], ['out', 'من يومين لـ 3 أيام عمل، والشحن 60 جنيه']],
    [['in', 'هو ده أصلي ولا تقليد؟']],
    [['in', 'عندكم سامبل أجرّب قبل ما أشتري؟'], ['out', 'أيوه، علبة 5 سامبلز بـ 250 جنيه وبتتخصم لو اشتريتي الزجاجة الكبيرة'], ['in', 'حلو جدًا، هطلبها']]
  ],
  clinic: [
    [['in', 'عايز أحجز كشف يوم السبت'], ['out', 'متاح السبت الساعة 5 أو 7 مساءً، تحب أنهي ميعاد؟'], ['in', 'الساعة 7']],
    [['in', 'سعر تبييض الأسنان كام؟'], ['out', 'جلسة التبييض بالليزر 2500 جنيه، والكشف قبلها مجاني'], ['in', 'مفيش خصم شوية؟ 😅']],
    [['in', 'عندي وجع جامد في ضرس العقل، ينفع أجي النهارده؟']],
    [['in', 'بتقبلوا تأمين شركة مصر للتأمين؟'], ['out', 'أيوه بنتعامل معاهم، هات الكارنيه معاك في الزيارة'], ['in', 'تمام، جزاكم الله خير']],
    [['in', 'تقويم الأسنان بياخد وقت قد إيه؟'], ['out', 'غالبًا من سنة لسنة ونص حسب الحالة. ممكن تحجز استشارة ونقولك بالظبط']]
  ],
  academy: [
    [['in', 'الكورس الجاي بيبدأ إمتى؟'], ['out', 'المستوى الأول إنجليزي بيبدأ يوم 1 الشهر الجاي، والمجموعة فيها 8 بس'], ['in', 'سعر كورس الإنجليزي كام وكام سيشن؟']],
    [['in', 'في مستويات للأطفال؟'], ['out', 'أيوه من سن 6 لـ 12 سنة، سيشن السبت والثلاثاء'], ['in', 'ينفع أحضر سيشن تجريبية الأول؟'], ['out', 'أكيد، السيشن التجريبية مجانية. ابعتلنا اسم الطفل وسنه']],
    [['in', 'الكورسات أونلاين ولا في المقر بس؟']],
    [['in', 'بتدوا شهادة في الآخر؟'], ['out', 'أيوه شهادة معتمدة من الأكاديمية بعد كل مستوى'], ['in', 'تمام، هسجل']],
    [['in', 'عايزة أسجّل لابني في كورس الفرنساوي'], ['out', 'أهلًا بحضرتك، ابنك عنده كام سنة؟'], ['in', '9 سنين']]
  ]
};

const CLIENTS: { kind: Exclude<DemoKind, 'general'>; name: string; notes: string; handle: string; owner: string; approval: boolean }[] = [
  { kind: 'cafe', name: 'كافيه نسمة', notes: 'كافيه ومطبخ في التجمع الخامس. الباقة: 12 بوست + إدارة الرسايل', handle: 'nesma.cafe', owner: 'طارق حلمي', approval: true },
  { kind: 'perfume', name: 'لمسة للعطور', notes: 'متجر عطور أونلاين بيشحن لكل المحافظات', handle: 'lamsa.perfumes', owner: 'داليا مراد', approval: false },
  { kind: 'clinic', name: 'عيادة د. سلمى لطب الأسنان', notes: 'عيادة أسنان في مدينة نصر. الحجز بالواتساب بس', handle: 'dr.salma.dental', owner: 'د. سلمى عزت', approval: true },
  { kind: 'academy', name: 'أكاديمية خطوة للغات', notes: 'كورسات إنجليزي وفرنساوي للكبار والأطفال', handle: 'khatwa.academy', owner: 'شريف وجدي', approval: false }
];

const TEAM: { role: Role; name: string; clients: number[] }[] = [
  { role: 'OWNER', name: 'نادر سامي', clients: [] },
  { role: 'MANAGER', name: 'رنا فتحي', clients: [] },
  { role: 'MODERATOR', name: 'أحمد علي', clients: [0, 1] },
  { role: 'MODERATOR', name: 'منى سعيد', clients: [2, 3] },
  { role: 'WRITER', name: 'سلمى ناجي', clients: [0, 1, 2, 3] }
];

const POSTS: Record<Exclude<DemoKind, 'general'>, { caption: string; image?: string }[]> = {
  cafe: [
    { caption: 'صباحك نسمة ☕ قهوتك المفضلة + كرواسون بـ 95 جنيه بس لحد الساعة 12 الضهر', image: 'cafe-1' },
    { caption: 'الويك إند عندنا غير 🌿 خصم 20% على أي أوردر فوق 300 جنيه يوم الجمعة والسبت', image: 'cafe-2' },
    { caption: 'منيو الشتا وصل! سحلب، هوت شوكليت، وكيكة البرتقال اللي بتسألوا عليها' },
    { caption: 'احجز ترابيزتك لعيد الميلاد واحنا علينا التورتة الصغيرة هدية 🎂', image: 'cafe-1' },
    { caption: 'إيه أكتر مشروب بتطلبه عندنا؟ قولنا في الكومنتات 👇' }
  ],
  perfume: [
    { caption: 'عود ملكي 👑 ثبات أكتر من 12 ساعة. 1200 جنيه ومعاه سامبل هدية', image: 'perfume-1' },
    { caption: 'مش عارف تختار؟ علبة السامبلز فيها 5 روايح بـ 250 جنيه وبتتخصم من أول زجاجة', image: 'perfume-2' },
    { caption: 'الشحن مجاني لأي أوردر فوق 1500 جنيه لحد آخر الشهر 🚚' },
    { caption: 'هدية عيد الأم جاهزة في علبة فخمة، اطلبها دلوقتي قبل الزحمة 💐', image: 'perfume-1' },
    { caption: 'ليل القاهرة 🌙 ريحة دافية بالعنبر والفانيليا' }
  ],
  clinic: [
    { caption: 'ابتسامتك تستاهل 😁 جلسة تبييض بالليزر والكشف قبلها مجاني', image: 'clinic-1' },
    { caption: 'نصيحة اليوم: غيّر فرشة سنانك كل 3 شهور، وبعد أي دور برد' },
    { caption: 'مواعيد العيادة الجديدة: من السبت للخميس من 2 الضهر لـ 10 بالليل', image: 'clinic-2' },
    { caption: 'تقويم شفاف من غير ما حد يلاحظ. احجز استشارتك الأولى مجانًا' },
    { caption: 'بنتعامل مع أغلب شركات التأمين، اسألنا على شركتك 💙', image: 'clinic-1' }
  ],
  academy: [
    { caption: 'المستوى الأول إنجليزي بيبدأ أول الشهر 📚 مجموعات 8 أفراد بس', image: 'academy-1' },
    { caption: 'كورسات الأطفال من 6 لـ 12 سنة، والسيشن التجريبية مجانية', image: 'academy-2' },
    { caption: 'كلمة النهارده: Procrastinate = تأجيل الحاجة لآخر لحظة 😅 مين زينا؟' },
    { caption: 'شهادة معتمدة بعد كل مستوى، وتقدر تكمل أونلاين لو سافرت', image: 'academy-1' },
    { caption: 'باقي 5 أماكن بس في مجموعة الفرنساوي، الحق احجز' }
  ]
};

const QUICK_REPLIES = [
  { shortcut: 'اهلا', body: 'أهلًا بيك 👋 إزاي نقدر نساعدك؟' },
  { shortcut: 'عنوان', body: 'ده اللوكيشن على الخريطة، ومستنيينك 📍' },
  { shortcut: 'دفع', body: 'متاح الدفع كاش عند الاستلام، أو فودافون كاش، أو InstaPay' },
  { shortcut: 'شكرا', body: 'العفو، تحت أمرك في أي وقت 🌿' },
  { shortcut: 'متابعة', body: 'هنراجع الموضوع ونرد عليك خلال ساعة بالكتير' }
];

const minutes = (n: number) => new Date(Date.now() - n * 60_000);

const SEED_MEDIA: Partial<Record<DemoKind, { name: string; minutesAgo: number; items: { media: DemoMediaName; body: string }[] }>> = {
  perfume: { name: 'ريم الشريف', minutesAgo: 7, items: [{ media: 'photo', body: 'عايزة البرفان ده، متوفر؟' }, { media: 'voice', body: '' }] },
  cafe: { name: 'خالد منصور', minutesAgo: 12, items: [{ media: 'voice', body: '' }] },
  academy: { name: 'دينا سمير', minutesAgo: 35, items: [{ media: 'pricelist', body: 'ده اللي بعتوهولي، هو لسه ساري؟' }] }
};

export async function seedDemoAgency(db: Db, key: Buffer, now = new Date()) {
  const tag = randomToken().slice(0, 10).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  const passwordHash = await hashPassword(randomToken()); // nobody can sign in with a password; only the demo button
  const fakeToken = (label: string) => encrypt(`demo-token-${label}-${tag}`, key);

  return db.$transaction(async tx => {
    const agency = await tx.agency.create({ data: {
      name: 'وكالة نون للتسويق', slug: `demo-${tag}`, demoExpiresAt: new Date(now.getTime() + DEMO_TTL_HOURS * 3600_000),
      plan: 'GROWTH', paidUntil: new Date(now.getTime() + 20 * 86400_000), createdAt: new Date(now.getTime() - 60 * 86400_000)
    } });
    const users = [] as { id: string; role: Role; name: string; clients: number[] }[];
    for (const [i, m] of TEAM.entries()) {
      const user = await tx.user.create({ data: { email: `${m.role.toLowerCase()}${i}.${tag}@demo.dosly.invalid`, name: m.name, passwordHash } });
      await tx.membership.create({ data: { agencyId: agency.id, userId: user.id, role: m.role, createdAt: new Date(now.getTime() - (60 - i) * 86400_000) } });
      users.push({ id: user.id, ...m });
    }
    const owner = users[0]!, manager = users[1]!, writer = users[4]!;
    const mediaMessageIds: string[] = [];
    const adAccountIds: string[] = [];

    await tx.quickReply.createMany({ data: QUICK_REPLIES.map(q => ({ ...q, agencyId: agency.id })) });

    for (const [ci, c] of CLIENTS.entries()) {
      const client = await tx.client.create({ data: { agencyId: agency.id, name: c.name, notes: c.notes, requiresClientApproval: c.approval, showAdsInPortal: true, createdAt: new Date(now.getTime() - (50 - ci * 7) * 86400_000) } });
      await tx.clientUser.create({ data: { agencyId: agency.id, clientId: client.id, name: c.owner, email: `owner${ci}.${tag}@demo.dosly.invalid`, lastLoginAt: ci % 2 ? null : minutes(60 * 20) } });
      const team = users.filter(u => u.clients.includes(ci));
      await tx.clientAssignment.createMany({ data: team.map(u => ({ clientId: client.id, userId: u.id })) });
      const moderator = team.find(u => u.role === 'MODERATOR')!;

      const num = await tx.whatsAppNumber.create({ data: {
        agencyId: agency.id, clientId: client.id, phoneNumberId: `demo-${tag}-${ci}`, wabaId: `demo-waba-${tag}`,
        displayPhone: `+20 10 ${String(2000 + ci * 1111).slice(0, 4)} ${String(4000 + ci * 1234).slice(0, 4)}`, verifiedName: c.name, accessTokenEnc: fakeToken(`wa${ci}`)
      } });
      const fb = await tx.socialAccount.create({ data: { agencyId: agency.id, clientId: client.id, platform: 'FACEBOOK_PAGE', externalId: `demo-page-${tag}-${ci}`, name: c.name, accessTokenEnc: fakeToken(`fb${ci}`) } });
      const ig = await tx.socialAccount.create({ data: { agencyId: agency.id, clientId: client.id, platform: 'INSTAGRAM', externalId: `demo-ig-${tag}-${ci}`, name: `@${c.handle}`, accessTokenEnc: fakeToken(`ig${ci}`) } });

      // Conversations: a spread of fresh unanswered ones, ongoing ones and old closed ones.
      const ages = [4, 25, 70, 180, 60 * 30]; // minutes since the last message; the last is outside the 24h window
      for (const [si, script] of SCRIPTS[c.kind].entries()) {
        const names = ['مريم حسن', 'كريم عادل', 'هبة منصور', 'يوسف جرجس', 'نور الشريف', 'مينا رمزي', 'ياسمين فؤاد', 'عمر إبراهيم'];
        const contact = await tx.contact.create({ data: { agencyId: agency.id, clientId: client.id, waNumberId: num.id, waId: demoPhone(), name: names[(si + ci * 2) % names.length] } });
        const end = ages[si % ages.length]!;
        const times = script.map((_, k) => minutes(end + (script.length - 1 - k) * 3));
        const lastIn = [...script.keys()].filter(k => script[k]![0] === 'in').pop()!;
        const last = script[script.length - 1]!;
        const awaiting = last[0] === 'in';
        const conv = await tx.conversation.create({ data: {
          agencyId: agency.id, clientId: client.id, waNumberId: num.id, contactId: contact.id,
          status: end > 24 * 60 ? 'CLOSED' : awaiting ? 'OPEN' : si % 2 ? 'PENDING' : 'OPEN',
          assigneeId: script.some(l => l[0] === 'out') ? moderator.id : null,
          unreadCount: awaiting && end < 120 ? script.slice(script.map(l => l[0]).lastIndexOf('out') + 1).length : 0,
          lastMessageAt: times[times.length - 1]!, lastInboundAt: times[lastIn]!, lastPreview: last[1].slice(0, 140), createdAt: times[0]!
        } });
        await tx.message.createMany({ data: script.map(([dir, body], k) => ({
          agencyId: agency.id, conversationId: conv.id, direction: dir === 'in' ? 'IN' as const : 'OUT' as const, type: 'text', body,
          waMessageId: `wamid.DEMO${dir === 'in' ? 'IN' : ''}.${tag}.${ci}.${si}.${k}`,
          status: dir === 'in' ? 'RECEIVED' as const : k === script.length - 1 ? 'DELIVERED' as const : 'READ' as const,
          sentById: dir === 'out' ? moderator.id : null, createdAt: times[k]!
        })) });
      }

      await tx.waTemplate.createMany({ data: DEMO_TEMPLATES.map(t => ({
        agencyId: agency.id, waNumberId: num.id, metaId: t.id, name: t.name, language: t.language, status: t.status, category: t.category,
        parameterFormat: t.parameter_format ?? 'POSITIONAL', components: t.components as unknown as Prisma.InputJsonValue
      })) });
      await tx.whatsAppNumber.update({ where: { id: num.id }, data: { templatesSyncedAt: now } });

      // A customer who wrote with a file a few minutes ago; the worker downloads it like a real one.
      const sent = SEED_MEDIA[c.kind];
      if (sent) {
        const contact = await tx.contact.create({ data: { agencyId: agency.id, clientId: client.id, waNumberId: num.id, waId: demoPhone(), name: sent.name } });
        const at = minutes(sent.minutesAgo);
        const conv = await tx.conversation.create({ data: { agencyId: agency.id, clientId: client.id, waNumberId: num.id, contactId: contact.id, status: 'OPEN', unreadCount: sent.items.length, lastMessageAt: at, lastInboundAt: at, lastPreview: previewText(DEMO_MEDIA[sent.items.at(-1)!.media].type, sent.items.at(-1)!.body, true), createdAt: at } });
        for (const [k, item] of sent.items.entries()) {
          const m = DEMO_MEDIA[item.media];
          const row = await tx.message.create({ data: {
            agencyId: agency.id, conversationId: conv.id, direction: 'IN', type: m.type, body: item.body || null, status: 'RECEIVED',
            waMessageId: `wamid.DEMOM.${tag}.${ci}.${k}`, mediaId: `demo-media-${item.media}`, mediaStatus: 'PENDING', mediaMime: m.mime,
            fileName: 'fileName' in m ? m.fileName : null, voice: 'voice' in m, createdAt: new Date(at.getTime() - (sent.items.length - 1 - k) * 20_000)
          } });
          mediaMessageIds.push(row.id);
        }
      }

      // History: closed conversations over the past four weeks, so the monthly report has real shape.
      const answers = ['أهلًا بيك، تحت أمرك 🌿', 'أكيد، هبعتلك التفاصيل حالًا', 'متاح، تحب نحجزلك؟', 'ده السعر والتفاصيل كاملة 👇'];
      for (let day = 27; day >= 1; day--) {
        const count = Math.floor(Math.random() * 4) + (day % 7 === 4 ? 2 : 0); // busier weekends
        for (let k = 0; k < count; k++) {
          const start = minutes(day * 1440 - 9 * 60 - Math.floor(Math.random() * 12 * 60)); // between 9am and 9pm-ish
          const wait = Math.random() < 0.85 ? 1 + Math.floor(Math.random() * 20) : 45 + Math.floor(Math.random() * 120);
          const at = (min: number) => new Date(start.getTime() + min * 60_000);
          const contact = await tx.contact.create({ data: { agencyId: agency.id, clientId: client.id, waNumberId: num.id, waId: demoPhone(), name: demoName() } });
          const lines: [string, 'IN' | 'OUT', number][] = [[pick(DEMO_OPENERS[c.kind]), 'IN', 0], [pick(answers), 'OUT', wait], ['تمام، شكرًا 🙏', 'IN', wait + 3], ['العفو، نورتنا', 'OUT', wait + 5]];
          const conv = await tx.conversation.create({ data: { agencyId: agency.id, clientId: client.id, waNumberId: num.id, contactId: contact.id, status: 'CLOSED', assigneeId: moderator.id, lastMessageAt: at(wait + 5), lastInboundAt: at(wait + 3), lastPreview: lines[3]![0], createdAt: start } });
          await tx.message.createMany({ data: lines.map(([body, direction, min], li) => ({
            agencyId: agency.id, conversationId: conv.id, direction, type: 'text', body, status: direction === 'IN' ? 'RECEIVED' as const : 'READ' as const,
            waMessageId: `wamid.DEMOH.${tag}.${ci}.${day}.${k}.${li}`, sentById: direction === 'OUT' ? moderator.id : null, createdAt: at(min)
          })) });
        }
      }

      // Posts: published last weeks, one partial failure, scheduled ahead, and a draft waiting for approval.
      const plan: { day: number; hour: number; status: 'PUBLISHED' | 'PARTIAL' | 'SCHEDULED' | 'DRAFT' }[] = [
        { day: -9 + ci, hour: 19, status: 'PUBLISHED' },
        { day: -3 - ci, hour: 13, status: ci === 1 ? 'PARTIAL' : 'PUBLISHED' },
        { day: 1 + ci, hour: 20, status: 'SCHEDULED' },
        { day: 6 + ci, hour: 18, status: 'SCHEDULED' },
        { day: 3 + ci * 2, hour: 21, status: 'DRAFT' }
      ];
      const published: SeedSocialInput['posts'] = [];
      for (const [pi, p] of plan.entries()) {
        const src = POSTS[c.kind][pi]!;
        const at = new Date(now); at.setDate(at.getDate() + p.day); at.setHours(p.hour, 0, 0, 0);
        const byWriter = p.status === 'DRAFT' || pi % 2 === 1;
        const targets = src.image ? [fb, ig] : [fb];
        const post = await tx.post.create({ data: {
          agencyId: agency.id, clientId: client.id, createdById: byWriter ? writer.id : manager.id,
          approvedById: p.status === 'DRAFT' ? null : manager.id, caption: src.caption,
          mediaUrls: src.image ? [`/demo/${src.image}.jpg`] : [], scheduledAt: at, status: p.status,
          // Clients who approve posts: the first upcoming post waits for them, the next is approved,
          // and at the clinic the owner already asked for a change.
          ...(c.approval && p.status === 'SCHEDULED' ? (pi === 2
            ? { clientReview: 'PENDING' as const }
            : c.kind === 'clinic'
              ? { clientReview: 'CHANGES_REQUESTED' as const, clientNote: 'ياريت نكتب المواعيد بالأرقام الكبيرة ونضيف رقم الحجز', reviewedAt: minutes(90) }
              : { clientReview: 'APPROVED' as const, reviewedAt: minutes(60 * 20) }) : {}),
          ...(c.approval && (p.status === 'PUBLISHED' || p.status === 'PARTIAL') ? { clientReview: 'APPROVED' as const, reviewedAt: new Date(at.getTime() - 86400_000) } : {}),
          createdAt: new Date(Math.min(at.getTime(), now.getTime()) - 2 * 86400_000)
        } });
        published.push(...targets.flatMap((t, ti) => (p.status === 'PUBLISHED' || (p.status === 'PARTIAL' && ti === 0)) && at <= now
          ? [{ accountId: t.id, platform: t.platform, externalPostId: `demo_${tag}_${ci}_${pi}_${ti}`, publishedAt: at }] : []));
        await tx.postTarget.createMany({ data: targets.map((t, ti) => {
          const failed = p.status === 'PARTIAL' && ti === 1;
          const done = (p.status === 'PUBLISHED' || p.status === 'PARTIAL') && !failed;
          return {
            postId: post.id, socialAccountId: t.id, status: done ? 'PUBLISHED' as const : failed ? 'FAILED' as const : 'PENDING' as const,
            externalPostId: done ? `demo_${tag}_${ci}_${pi}_${ti}` : null, publishedAt: done ? at : null, attempts: done || failed ? 1 : 0,
            error: failed ? 'Error validating access token: Session has expired (demo)' : null
          };
        }) });
      }
      // An ad account per client. The last digit picks the demo business in the simulated Marketing API.
      const adExternal = `${String(now.getTime()).slice(-9)}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}${ci}`;
      const ad = await tx.adAccount.create({ data: { agencyId: agency.id, clientId: client.id, externalId: adExternal, name: c.name, currency: 'EGP', timezoneName: 'Africa/Cairo', accessTokenEnc: fakeToken(`ads${ci}`), createdAt: new Date(now.getTime() - 40 * 86400_000) } });
      adAccountIds.push(ad.id);
      // The clinic's lead form was running at the last check and was paused this morning: the first sync shows a "stopped" alert.
      if (c.kind === 'clinic') await tx.adCampaign.create({ data: { adAccountId: ad.id, externalId: demoCampaignId(adExternal, '2'), name: 'فورم | استشارة تقويم مجانية', status: 'ACTIVE', effectiveStatus: 'ACTIVE', checkedStatus: 'DELIVERING', objective: 'OUTCOME_LEADS' } });

      await seedSocial(tx, { agencyId: agency.id, clientId: client.id, kind: c.kind, moderatorId: moderator.id, now, fb, ig, posts: published });
    }

    const log = (minAgo: number, userId: string | null, action: string, entity: string, meta?: object) =>
      ({ agencyId: agency.id, userId, action, entity, meta, createdAt: minutes(minAgo) });
    await tx.auditLog.createMany({ data: [
      log(60 * 24 * 40, owner.id, 'team.invite', 'Invite', { role: 'MODERATOR' }),
      log(60 * 24 * 12, manager.id, 'channel.social.connect', 'SocialAccount', { platform: 'INSTAGRAM' }),
      log(60 * 24 * 9, manager.id, 'ads.account.connect', 'AdAccount', { name: CLIENTS[1]!.name }),
      log(60 * 26, manager.id, 'post.approve', 'Post'),
      log(60 * 5, writer.id, 'post.create', 'Post'),
      log(30, users[2]!.id, 'conversation.update', 'Conversation', { status: 'PENDING' })
    ] });

    return { agencyId: agency.id, users: users.map(u => ({ id: u.id, role: u.role, name: u.name })), mediaMessageIds, adAccountIds };
  }, { timeout: 30_000 });
}

/** Deletes demo sandboxes past their expiry. Cascades remove everything they own. */
export async function deleteExpiredDemos(db: Db, now = new Date(), store?: MediaStore) {
  const expired = await db.agency.findMany({ where: { demoExpiresAt: { lte: now } }, select: { id: true, memberships: { select: { userId: true } } } });
  for (const a of expired) {
    await db.agency.delete({ where: { id: a.id } });
    await store?.removePrefix(`wa/${a.id}`);
    await db.user.deleteMany({ where: { id: { in: a.memberships.map(m => m.userId) }, memberships: { none: {} } } });
  }
  return expired.length;
}
