# تشغيل دوسلي على الـ VPS

الخطوات دي على Ubuntu 22 أو 24 (Contabo). كل حاجة شغالة بـ Docker، فمش محتاج تسطّب Node ولا Postgres على السيرفر.

## 1. الدومين
- اعمل سجل **A** لـ `app.الدومين` يشاور على IP الـ VPS.
- واعمل سجل **A** كمان لـ `n8n.app.الدومين`.

## 2. تسطيب Docker (مرة واحدة)
```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # اخرج وادخل تاني بعدها
```

## 3. الفايرول
```sh
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## 4. الكود
```sh
sudo mkdir -p /opt/dosly && sudo chown $USER /opt/dosly
git clone https://github.com/kerollos0/dosly.git /opt/dosly
cd /opt/dosly
cp .env.example .env
nano .env
```
املا `.env`: الدومين، والإيميل، و`openssl rand -hex 32` لكل سر، و`META_APP_SECRET` من تطبيق Meta (App settings > Basic).

## 5. التشغيل
```sh
docker compose up -d --build
docker compose ps         # كل الخدمات لازم تبقى running أو healthy
docker compose logs -f api
```
افتح `https://app.الدومين/signup` واعمل حساب الوكالة. بعدها حط `ALLOW_SIGNUP=false` في `.env` واعمل `docker compose up -d`.

## 6. ربط Webhook واتساب
في تطبيق Meta > WhatsApp > Configuration:
- **Callback URL:** `https://app.الدومين/webhooks/meta`
- **Verify token:** نفس قيمة `META_VERIFY_TOKEN`
- اعمل Subscribe على **messages** (الرسايل والصور والفويس وحالات الإرسال) و **message_template_status_update** (لما Meta توافق على قالب أو ترفضه أو توقفه).
- التوكن لازم يكون فيه صلاحية `whatsapp_business_management` عشان دوسلي يقرا القوالب، و `whatsapp_business_messaging` عشان يبعت.

## 6.1 ربط فيسبوك وإنستجرام (الكومنتات والرسايل)
- في تطبيق Meta > Webhooks: اختار **Page** واعمل Subscribe على `feed` و `messages` و `message_echoes` و `message_reads` و `message_deliveries` و `messaging_postbacks`. واختار **Instagram** واعمل Subscribe على `comments` و `messages` و `messaging_seen`. نفس الـ Callback URL والـ Verify token.
- لما تربط صفحة أو حساب إنستجرام من صفحة القنوات، دوسلي بيعمل `subscribed_apps` للصفحة (أو الصفحة اللي الإنستجرام مربوط بيها) لوحده. حقول إنستجرام نفسها بتتظبط من الـ App Dashboard بس. التوكن لازم يكون Page token بتاع الصفحة نفسها.
- حط `META_APP_ID` في `.env` عشان الـ worker يعرف رسايل دوسلي نفسها لما ترجع echo. حساب إنستجرام لازم يكون Professional ومربوط بالصفحة، وخلّي «السماح بالوصول للرسايل» شغال من إعدادات إنستجرام.
- الصلاحيات اللي محتاجة App Review: `pages_messaging`، `pages_manage_metadata`، `pages_read_engagement`، `pages_manage_engagement`، `pages_read_user_content`، `instagram_basic`، `instagram_manage_comments`، `instagram_manage_messages`، و Human Agent عشان الرد بعد 24 ساعة.

## 6.2 الإعلانات

- كل وكالة بتربط الحساب الإعلاني بتاع العميل من صفحة القنوات: رقم الحساب و System User token عليه صلاحية `ads_read` على الحساب ده.
- الصلاحية محتاجة App Review (`ads_read`) عشان تشتغل مع حسابات ناس برا التطبيق. من غيرها شغالة على حسابات أدمنز التطبيق بس (Development tier بحدود أقل).
- مفيش Webhook مطلوب: الووركر بيقرا كل 15 دقيقة.

## 7. الباك أب
```sh
crontab -e
# ضيف السطر ده:
30 3 * * * /opt/dosly/deploy/backup.sh
```
وانسخ فولدر `backups` لمكان برّه السيرفر (Google Drive بـ rclone مثلًا).

## التحديث
```sh
cd /opt/dosly && git pull && docker compose up -d --build
```
الـ migrations بتشتغل لوحدها قبل الـ API.

## لو حاجة وقفت
- `docker compose logs --tail 100 api` أو `worker`.
- الرسايل مش بتوصل؟ اتأكد إن الـ webhook متعمله Subscribe، وإن `META_APP_SECRET` صح (لو غلط، الـ API بيرفض الرسايل ويكتب "bad signature").
