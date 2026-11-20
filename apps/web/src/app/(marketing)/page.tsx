import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, BadgeCheck, CalendarClock, Check, FileBarChart, Inbox, KeyRound, Link2, LockKeyhole, MessageCircleOff, PhoneOff, ShieldCheck, Smartphone, UserPlus, Users } from 'lucide-react';
import { PLAN_LABEL, PLAN_PRICE, PUBLIC_PLANS } from '@/lib/plans';

export const metadata: Metadata = {
  title: { absolute: 'دوسلي: كل عملاء وكالتك في شاشة واحدة' },
  description: 'واتساب كل عملائك في إنبوكس واحد، وجدولة بوستات فيسبوك وإنستجرام، وفريق بصلاحيات، وبوابة لعميلك يوافق فيها ويشوف تقرير الشهر. بالعربي ومعمول لوكالات مصر.'
};

/** A real screenshot from the demo, in a light browser frame. */
function Shot({ src, alt, w = 1440, h = 900, priority = false }: { src: string; alt: string; w?: number; h?: number; priority?: boolean }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(15,27,45,.35)]">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-3 py-2" aria-hidden>
        <span className="size-2.5 rounded-full bg-line" /><span className="size-2.5 rounded-full bg-line" /><span className="size-2.5 rounded-full bg-line" />
      </div>
      <img src={src} alt={alt} width={w} height={h} loading={priority ? 'eager' : 'lazy'} decoding="async" className="block h-auto w-full" />
    </div>
  );
}

function Section({ id, eyebrow, title, sub, children, tint = false }: { id?: string; eyebrow?: string; title: string; sub?: string; children: React.ReactNode; tint?: boolean }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className={`scroll-mt-16 ${tint ? 'bg-surface-2' : ''}`}>
      <div className="mx-auto max-w-6xl px-6 py-20 max-sm:px-4 max-sm:py-14">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          {eyebrow && <p className="mb-2 font-semibold text-faience-ink">{eyebrow}</p>}
          <h2 id={id ? `${id}-h` : undefined} className="font-display text-[34px] font-bold leading-tight max-sm:text-[28px]">{title}</h2>
          {sub && <p className="mt-3 text-lg text-muted">{sub}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}

const PAINS = [
  { icon: PhoneOff, title: 'موبايل لكل عميل', body: 'كل عميل ليه رقم واتساب على موبايل، والمودريتور بيلف بينهم. رسالة تضيع، وعميل يستنى ساعات.' },
  { icon: MessageCircleOff, title: 'الموافقة في جروب', body: '"ابعتلي البوست أوافق عليه" في جروب واتساب، والتعديل يتوه بين 50 رسالة، والبوست يتأخر.' },
  { icon: FileBarChart, title: 'تقرير آخر الشهر بالإيد', body: 'تعدّ البوستات والرسايل بنفسك عشان تقنع العميل إنك شغال، وكل شهر نفس الساعات.' }
];

const FEATURES = [
  {
    icon: Inbox, eyebrow: 'إنبوكس واتساب مشترك', title: 'رسايل كل العملاء في مكان واحد، والفريق كله شايفها',
    points: ['كل رقم واتساب بيزنس لكل عميل في إنبوكس واحد، والرسايل بتظهر لحظيًا', 'وزّع المحادثة على مودريتور، وعلّمها مفتوحة أو مستنية أو مقفولة', 'ردود جاهزة بـ "/" وتنبيه قبل ما نافذة الـ 24 ساعة بتاعة واتساب تقفل', 'المودريتور بيشوف بس العملاء المتعينين له'],
    shot: { src: '/marketing/inbox-zoom.jpg', w: 1200, h: 620, alt: 'محادثة واتساب مفتوحة مع رد من الفريق، وجنبها قايمة محادثات من كذا عميل' }
  },
  {
    icon: CalendarClock, eyebrow: 'جدولة البوستات', title: 'شهر محتوى لكل العملاء على تقويم واحد',
    points: ['انشر على صفحة فيسبوك وحساب إنستجرام في نفس الوقت', 'كاتب المحتوى يكتب، والمدير يوافق، والبوست ينزل لوحده في ميعاده', 'لو النشر فشل على منصة بتعرف السبب وتعيد المحاولة من غير ما يتكرر على التانية'],
    shot: { src: '/marketing/calendar.jpg', w: 1200, h: 760, alt: 'تقويم شهر فيه بوستات منشورة ومجدولة ومسودات لأربع عملاء' }
  },
  {
    icon: BadgeCheck, eyebrow: 'بوابة العميل', title: 'عميلك يوافق على البوستات ويشوف شغلك بنفسه',
    points: ['صاحب البيزنس يدخل بلينك من غير باسورد، ويشوف بوستاته بس', 'يوافق أو يطلب تعديل بكلمتين، والبوست مش هينزل غير بموافقته لو حبيت', 'تقرير شهري جاهز: البوستات، رسايل العملاء، ومتوسط وقت الرد'],
    shot: { src: '/marketing/portal.jpg', w: 1100, h: 760, alt: 'بوابة العميل: بوست مستني الموافقة بزرارين موافق وعايز تعديل، وبوستات جاية ومنشورة' }
  },
  {
    icon: Users, eyebrow: 'الفريق والصلاحيات', title: 'كل واحد في فريقك شايف اللي يخصه بس',
    points: ['أربع أدوار جاهزة: صاحب الوكالة، مدير، مودريتور، كاتب محتوى', 'ادعي حد بلينك على الواتساب، من غير ما تشارك باسوردات', 'سجل نشاط بيقولك مين عمل إيه وإمتى'],
    shot: { src: '/marketing/team.jpg', w: 1200, h: 520, alt: 'صفحة الفريق فيها خمس أعضاء بأدوار مختلفة' }
  }
];

const STEPS = [
  { icon: UserPlus, title: 'ضيف عميلك', body: 'اسم العميل وملاحظاته، وعيّن عليه المودريتور والكاتب.' },
  { icon: Link2, title: 'اربط رقمه وصفحاته', body: 'رقم واتساب بيزنس وصفحة فيسبوك وحساب إنستجرام، عن طريق ربط Meta الرسمي.' },
  { icon: Smartphone, title: 'ابدأ ترد وتجدول', body: 'الرسايل بتوصل للإنبوكس على طول، وجدول بوستات الشهر في جلسة واحدة.' }
];

const FLOW = ['الكاتب يكتب البوست', 'المدير يراجع ويوافق', 'العميل يوافق من البوابة', 'ينزل لوحده في ميعاده', 'يظهر في تقرير الشهر'];

const TRUST = [
  { icon: BadgeCheck, title: 'ربط رسمي من Meta', body: 'بنستخدم WhatsApp Cloud API الرسمي، مش واتساب ويب ولا تطبيقات معدّلة، فمفيش خطر إن الرقم يتقفل بسبب الأداة.' },
  { icon: LockKeyhole, title: 'التوكنات متشفرة', body: 'مفاتيح ربط الصفحات والأرقام متخزنة متشفرة، ومبتظهرش لأي حد في الواجهة، حتى صاحب الوكالة.' },
  { icon: KeyRound, title: 'كل وكالة في مكانها', body: 'بيانات كل وكالة منفصلة، وكل عضو بيشوف عملاءه بس، وعميلك بيشوف بوستاته وتقريره بس.' },
  { icon: ShieldCheck, title: 'مفيش حاجة بتتبعت لوحدها', body: 'أي رسالة لعميل حقيقي أو بوست بيتنشر لازم حد من فريقك يكون قرر ده.' }
];

const FAQ = [
  { q: 'هل ده آمن على رقم الواتساب؟', a: 'أيوه. دوسلي بيستخدم الربط الرسمي من Meta (WhatsApp Business Platform)، وده نفس الطريق اللي الشركات الكبيرة بتستخدمه. مش بنشغّل واتساب ويب في الخلفية.' },
  { q: 'محتاج إيه عشان أربط رقم عميل؟', a: 'رقم مش متسجل على تطبيق واتساب العادي، وحساب Meta Business للعميل أو للوكالة. هنمشي معاك خطوة بخطوة.' },
  { q: 'عميلي هيشوف المحادثات؟', a: 'لأ. البوابة بتوري العميل بوستاته وتقرير الشهر بس، ومش بتوريه نص المحادثات ولا أسماء فريقك.' },
  { q: 'أقدر أجرّب قبل ما أدفع؟', a: 'أيوه، 14 يوم تجربة كاملة من غير كارت. وتقدر دلوقتي تفتح الديمو وتلعب في وكالة جاهزة فيها عملاء ومحادثات.' },
  { q: 'الدفع إزاي؟', a: 'بالجنيه المصري. في الأول بـ InstaPay أو تحويل، والدفع الأونلاين جاي قريب.' },
  { q: 'لو التجربة أو الاشتراك خلص، بياناتي بتروح؟', a: 'لأ. الحساب بيبقى للعرض بس لحد ما تشترك، وكل المحادثات والبوستات بتفضل محفوظة.' }
];

export default function Landing() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 h-[560px] bg-[radial-gradient(60%_60%_at_50%_30%,color-mix(in_oklab,var(--faience)_22%,transparent),transparent)]" />
        <div className="relative mx-auto flex max-w-6xl flex-col items-center px-6 pb-16 pt-20 text-center max-sm:px-4 max-sm:pt-12">
          <p className="mb-4 rounded-full border border-faience/40 bg-faience/10 px-3 py-1 text-sm font-semibold text-faience-ink">معمول لوكالات التسويق في مصر</p>
          <h1 className="max-w-3xl font-display text-[56px] font-bold leading-[1.15] max-md:text-[40px] max-sm:text-[32px]">
            كل عملاء وكالتك <span className="relative whitespace-nowrap text-faience-ink">في شاشة واحدة<svg aria-hidden viewBox="0 0 200 12" className="absolute inset-x-0 -bottom-2 h-3 w-full text-sun" preserveAspectRatio="none"><path d="M2 9C50 3 150 3 198 8" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" /></svg></span>
          </h1>
          <p className="mt-6 max-w-2xl text-xl text-muted max-sm:text-lg">واتساب كل عميل في إنبوكس واحد، وبوستات فيسبوك وإنستجرام بتنزل في ميعادها، وفريقك بصلاحيات، وعميلك يوافق ويشوف تقريره من غير جروبات.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/login#demo" className="inline-flex h-12 items-center gap-2 rounded-[var(--radius-md)] bg-primary px-6 text-lg font-semibold text-on-primary hover:brightness-110">جرّب الديمو دلوقتي<ArrowLeft size={20} aria-hidden /></Link>
            <Link href="/signup" className="inline-flex h-12 items-center rounded-[var(--radius-md)] border border-line px-6 text-lg font-semibold hover:bg-surface-2">ابدأ تجربة 14 يوم</Link>
          </div>
          <p className="mt-3 text-sm text-muted">الديمو من غير تسجيل · التجربة من غير كارت</p>
          <div className="mt-14 w-full max-w-5xl"><Shot src="/marketing/inbox.jpg" alt="شاشة المحادثات في دوسلي، فيها رسايل من عملاء أربع بيزنسات مختلفة" priority /></div>
        </div>
      </section>

      {/* Pains */}
      <Section title="لو بتدير سوشيال لأكتر من عميل، أكيد عارف الإحساس ده" tint>
        <ul className="grid gap-6 md:grid-cols-3">
          {PAINS.map(p => (
            <li key={p.title} className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-6">
              <span className="grid size-11 place-items-center rounded-[var(--radius-md)] bg-danger/10 text-danger"><p.icon size={22} aria-hidden /></span>
              <h3 className="font-display text-xl font-bold">{p.title}</h3>
              <p className="text-muted">{p.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* Features */}
      <section id="features" aria-labelledby="features-h" className="scroll-mt-16">
        <div className="mx-auto max-w-6xl px-6 py-20 max-sm:px-4 max-sm:py-14">
          <h2 id="features-h" className="mx-auto mb-16 max-w-2xl text-center font-display text-[34px] font-bold leading-tight max-sm:text-[28px]">دوسلي بيحل ده كله، في مكان واحد</h2>
          <div className="flex flex-col gap-24 max-sm:gap-16">
            {FEATURES.map((f, i) => (
              <article key={f.title} className="grid items-center gap-10 lg:grid-cols-[4fr_7fr]">
                <div className={`flex flex-col gap-4 ${i % 2 ? 'lg:order-2' : ''}`}>
                  <p className="flex items-center gap-2 font-semibold text-faience-ink"><f.icon size={20} aria-hidden />{f.eyebrow}</p>
                  <h3 className="font-display text-[28px] font-bold leading-snug max-sm:text-[24px]">{f.title}</h3>
                  <ul className="flex flex-col gap-3">
                    {f.points.map(pt => <li key={pt} className="flex gap-3"><Check size={20} className="mt-1 shrink-0 text-faience" aria-hidden /><span>{pt}</span></li>)}
                  </ul>
                </div>
                <Shot src={f.shot.src} alt={f.shot.alt} w={f.shot.w} h={f.shot.h} />
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <Section id="how" eyebrow="إزاي بتشتغل" title="من التسجيل لأول رد في نفس اليوم" tint>
        <ol className="grid gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-6">
              <span className="absolute end-5 top-5 font-display text-5xl font-bold text-faience/20" aria-hidden>{i + 1}</span>
              <span className="grid size-11 place-items-center rounded-[var(--radius-md)] bg-faience/12 text-faience-ink"><s.icon size={22} aria-hidden /></span>
              <h3 className="font-display text-xl font-bold">{s.title}</h3>
              <p className="text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-16 rounded-[var(--radius-lg)] border border-line bg-surface p-8 max-sm:p-5">
          <h3 className="mb-6 text-center font-display text-xl font-bold">رحلة البوست، من الفكرة لحد التقرير</h3>
          <ol className="flex flex-wrap items-center justify-center gap-3">
            {FLOW.map((f, i) => (
              <li key={f} className="flex items-center gap-3">
                <span className={`rounded-full px-4 py-2 font-semibold ${i === 2 ? 'bg-sun text-[#0F1B2D]' : 'bg-faience/12 text-faience-ink'}`}>{f}</span>
                {i < FLOW.length - 1 && <ArrowLeft size={18} className="text-muted max-sm:hidden" aria-hidden />}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-center text-sm text-muted">موافقة العميل اختيارية لكل عميل، وتقدر تشغّلها أو تقفلها من صفحته.</p>
        </div>
      </Section>

      {/* Client report + mobile */}
      <Section eyebrow="تقرير الشهر" title="عميلك يشوف قيمة شغلك بالأرقام" sub="من غير ما تفتح إكسل. البوستات اللي اتنشرت، ورسايل العملاء، ونسبة الرد، ومتوسط وقت الرد، كل شهر لوحدها.">
        <div className="grid items-end gap-8 lg:grid-cols-[1fr_260px]">
          <Shot w={1100} h={600} src="/marketing/report.jpg" alt="تقرير شهري لعميل: 4 أرقام رئيسية ورسم بعدد رسايل العملاء كل يوم" />
          <div className="mx-auto w-[260px] overflow-hidden rounded-[32px] border-[6px] border-ink shadow-xl max-lg:hidden">
            <img src="/marketing/portal-mobile.jpg" alt="بوابة العميل على الموبايل" width={390} height={844} loading="lazy" className="block h-auto w-full" />
          </div>
        </div>
      </Section>

      {/* Trust */}
      <Section title="مبني صح من الأول" sub="أداة بتشيل أرقام عملائك وصفحاتهم لازم تكون أمينة عليها." tint>
        <ul className="grid gap-6 sm:grid-cols-2">
          {TRUST.map(t => (
            <li key={t.title} className="flex gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-6">
              <span className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-faience/12 text-faience-ink"><t.icon size={22} aria-hidden /></span>
              <div><h3 className="mb-1 font-display text-lg font-bold">{t.title}</h3><p className="text-muted">{t.body}</p></div>
            </li>
          ))}
        </ul>
      </Section>

      {/* Pricing */}
      <Section id="pricing" eyebrow="الأسعار" title="ادفع على قد عدد عملائك" sub="بالجنيه المصري، شهري. كل الباقات فيها 14 يوم تجربة من غير كارت.">
        <ul className="grid gap-6 md:grid-cols-3">
          {PUBLIC_PLANS.map(p => (
            <li key={p.id} className={`relative flex flex-col gap-5 rounded-[var(--radius-lg)] border p-7 ${'featured' in p && p.featured ? 'border-primary bg-faience/5 shadow-lg' : 'border-line'}`}>
              {'featured' in p && p.featured && <span className="absolute -top-3 start-6 rounded-full bg-sun px-3 py-0.5 text-sm font-bold text-[#0F1B2D]">الأكثر اختيارًا</span>}
              <div><h3 className="font-display text-2xl font-bold">{PLAN_LABEL[p.id]}</h3><p className="text-sm text-muted">{p.for}</p></div>
              <p><span className="font-display text-4xl font-bold">{PLAN_PRICE[p.id]}</span> <span className="text-muted">جنيه / شهر</span></p>
              <ul className="flex flex-1 flex-col gap-2">{p.features.map(f => <li key={f} className="flex gap-2"><Check size={18} className="mt-1 shrink-0 text-faience" aria-hidden />{f}</li>)}</ul>
              <Link href="/signup" className={`inline-flex h-11 items-center justify-center rounded-[var(--radius-md)] font-semibold ${'featured' in p && p.featured ? 'bg-primary text-on-primary hover:brightness-110' : 'border border-line hover:bg-surface-2'}`}>ابدأ التجربة</Link>
            </li>
          ))}
        </ul>
      </Section>

      {/* FAQ */}
      <Section id="faq" eyebrow="أسئلة" title="أسئلة بتتسأل كتير" tint>
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {FAQ.map(f => (
            <details key={f.q} className="group rounded-[var(--radius-md)] border border-line bg-surface p-5 open:shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-semibold">{f.q}<span className="text-2xl text-faience-ink transition-transform group-open:rotate-45" aria-hidden>+</span></summary>
              <p className="mt-3 text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* Final CTA */}
      <section className="bg-ink text-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-20 text-center max-sm:px-4">
          <img src="/dosly-mark.svg" alt="" width={56} height={56} />
          <h2 className="max-w-2xl font-display text-[36px] font-bold leading-tight max-sm:text-[28px]">جرّب دوسلي على وكالة جاهزة، دلوقتي</h2>
          <p className="max-w-xl text-lg opacity-80">أربع عملاء، ومحادثات شغالة، وبوستات الشهر، وبوابة العميل. العب فيها زي ما تحب، ومحدش حقيقي هيستلم حاجة.</p>
          <Link href="/login#demo" className="inline-flex h-12 items-center gap-2 rounded-[var(--radius-md)] bg-faience px-6 text-lg font-semibold text-[#062421] hover:brightness-110">افتح الديمو<ArrowLeft size={20} aria-hidden /></Link>
        </div>
      </section>
    </>
  );
}
