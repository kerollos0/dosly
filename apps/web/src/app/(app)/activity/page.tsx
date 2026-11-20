'use client';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { PageHeader } from '@/components/ui';
import { when } from '@/lib/when';

const LABEL: Record<string, string> = {
  'client.create': 'أضاف عميل', 'client.archive': 'أرشف عميل', 'client.assign': 'عيّن فريق لعميل',
  'team.invite': 'بعت دعوة', 'team.role': 'غيّر دور عضو', 'team.remove': 'شال عضو',
  'channel.whatsapp.connect': 'ربط رقم واتساب', 'channel.social.connect': 'ربط صفحة', 'channel.whatsapp.disconnect': 'فصل رقم واتساب', 'channel.social.disconnect': 'فصل صفحة',
  'conversation.update': 'غيّر حالة محادثة أو المسؤول عنها', 'post.create': 'عمل بوست', 'post.draft': 'كتب مسودة بوست', 'post.schedule': 'جدول بوست', 'post.approve': 'وافق على بوست', 'post.edit': 'عدّل بوست',
  'post.delete': 'مسح بوست', 'post.publish_now': 'نشر بوست حالًا', 'post.published': 'البوست اتنشر', 'post.failed': 'نشر البوست فشل', 'post.partial': 'البوست اتنشر جزئيًا',
  'post.client_approve': 'وافق على بوست من البوابة', 'post.client_changes': 'طلب تعديل على بوست من البوابة', 'client.portal_invite': 'ضاف حد لبوابة العميل', 'client.portal_settings': 'غيّر إعدادات بوابة العميل',
  'ads.account.connect': 'ربط حساب إعلانات', 'ads.account.disconnect': 'فصل حساب إعلانات', 'ads.alert.dismiss': 'قفل تنبيه إعلانات',
  'comment.reply': 'رد على كومنت', 'comment.private_reply': 'رد على كومنت في الخاص', 'comment.delete': 'مسح كومنت', 'comment.hide': 'خبّى كومنت', 'client.portal_remove': 'شال حد من بوابة العميل', 'demo.end': 'قفل الديمو',
  'dosly.payment': 'سجّل دفع الاشتراك', 'dosly.plan_change': 'غيّر الباقة', 'dosly.suspend': 'أوقف الحساب', 'dosly.unsuspend': 'رجّع الحساب', 'dosly.support_login': 'دخل كدعم فني (للعرض بس)'
};

export default function ActivityPage() {
  const { data } = useSWR<{ items: { id: string; action: string; userName: string | null; createdAt: string }[] }>('/audit', fetcher as never);
  return (
    <>
      <PageHeader title="سجل النشاط" sub="مين عمل إيه وإمتى." />
      <ol className="divide-y divide-line px-8 max-md:px-4">
        {data?.items.map(i => (
          <li key={i.id} className="flex justify-between gap-4 py-3">
            <span><b>{i.userName ?? (i.action.startsWith('post.client') ? 'العميل' : 'فريق دوسلي')}</b> {LABEL[i.action] ?? 'عمل تعديل'}</span>
            <span className="shrink-0 text-sm text-muted">{when(i.createdAt)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
