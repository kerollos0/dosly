# دوسلي (Dosly): قرارات التصميم التقني

القرارات دي نهائية للمرحلة الأولى (2026-11-20). أي تغيير يتكتب هنا مع السبب.

## الهيكل
Monorepo بـ pnpm workspaces + Turborepo:
- `apps/web`: Next.js (App Router) + Tailwind + shadcn/ui، عربي RTL افتراضي.
- `apps/api`: Fastify + TypeScript (REST + Socket.IO + Meta webhooks).
- `apps/worker`: BullMQ workers (نشر البوستات، إعادة المحاولة، معالجة الـ webhooks).
- `packages/db`: Prisma schema + migrations.
- `packages/shared`: Zod schemas وأنواع مشتركة بين الواجهة والـ API.

## القرارات وأسبابها
| الموضوع | القرار | السبب |
|---|---|---|
| Backend framework | Fastify، مش NestJS | أخف وأسرع وأقل boilerplate، مناسب لفريق صغير |
| قاعدة البيانات | PostgreSQL self-hosted، مش Supabase | مجاني على الـ VPS، مفيش vendor lock، البيانات عندنا |
| ORM | Prisma | الأشهر والأسهل قراءة لمطور فرونت إند، migrations واضحة |
| Multi-tenancy | DB واحدة، `agencyId` على كل جدول، وفحص إلزامي في طبقة الـ API | أبسط تشغيلًا من DB لكل وكالة، كافي لمئات الوكالات |
| Auth | Sessions بتاعتنا في Postgres (cookie httpOnly، والتوكن متخزن كـ hash)، والباسوردات بـ scrypt، وأدوار: owner / manager / moderator / writer | كود صغير تحت إيدنا بالكامل ومن غير dependency كبيرة. اتغيّر من Better Auth في 2026-11-20 |
| أسرار Meta | Tokens متشفرة في الـ DB بـ AES-256-GCM، والمفتاح في env فقط | لو الـ DB اتسربت، التوكنز متتقريش |
| Webhooks | التحقق من `X-Hub-Signature-256`، رد 200 فورًا، والمعالجة في الطابور | Meta بتعيد الإرسال لو اتأخرنا، ومنمنعش التكرار بـ message id |
| Real-time | Socket.IO مع Redis adapter | الرسايل تظهر فورًا، ويقبل أكتر من instance بعدين |
| الميديا | واجهة تخزين واحدة: disk على الـ VPS في الأول، وS3/R2 لما نكبر من غير تغيير كود | إنستجرام محتاج رابط عام للصورة، ونقدر ننقل لـ Cloudflare R2 من غير تغيير كود |
| الاختبارات | Vitest للـ logic، Playwright لمسارات أساسية (login، رد على رسالة، جدولة بوست) | |
| CI | GitHub Actions: lint + typecheck + tests على كل PR | |
| التشغيل | Docker Compose + Caddy (HTTPS أوتوماتيك) | سهل على VPS واحد |
| Backups | pg_dump يومي، والاحتفاظ بـ 7 نسخ، مع نسخة خارج الـ VPS | |
| المراقبة | Uptime Kuma + logs بـ pino | مجاني |
| الأتمتة | n8n container منفصل، بيكلم الـ API بـ API key داخلي | التقارير والتنبيهات وربط المتاجر من غير ما نلمس الكود الأساسي |

## مبادئ
- لا تخزين لأي token أو باسورد في Git أو في الشات.
- كل عملية نشر أو إرسال لعميل حقيقي محتاجة ضغطة من مستخدم (مفيش إرسال تلقائي من غير إعداد صريح).
- عربي أولًا، والإنجليزي يتضاف بعدين بـ next-intl.

## الاستعداد للـ scaling (طلب كيرلس 2026-11-20)
- **الـ API stateless:** مفيش أي state في الذاكرة. الـ sessions في Postgres، والـ realtime بيعدّي على Redis pub/sub، فنقدر نشغّل أكتر من نسخة ورا load balancer.
- **الـ webhooks:** بتتسجل في جدول `WebhookEvent` وبنرد بـ 200 فورًا، والمعالجة في BullMQ worker. يعني لو جه ضغط كبير الرسايل بتستنى في الطابور ومبتضيعش.
- **Idempotency:** كل رسالة ليها `waMessageId` unique، فلو Meta بعتت نفس الحدث مرتين مبيتكررش. ونشر البوستات بيتخطى المنصات اللي اتنشر عليها قبل كده.
- **الترتيب:** حالة الرسالة (sent → delivered → read) مبترجعش لورا لو الأحداث وصلت بترتيب غلط.
- **Indexes:** على كل استعلام تقيل (`agencyId + lastMessageAt`، و`conversationId + createdAt`، و`agencyId + scheduledAt`).
- **Pagination بالـ cursor:** في الرسايل والمحادثات، مش offset، عشان تفضل سريعة مع ملايين الرسايل.
- **Workers منفصلة:** نقدر نزوّد عدد الـ workers لوحدهم من غير ما نلمس الـ API.
- **Rate limiting:** على تسجيل الدخول والتسجيل.
- **مرحلة متقدمة لما نحتاج:** Postgres read replica، وPgBouncer، وتقسيم جدول الرسايل partitioning بالشهر، ونقل الميديا لـ R2، وتشغيل أكتر من VPS.
