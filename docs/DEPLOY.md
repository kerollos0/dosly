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
