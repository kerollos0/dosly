'use client';
import useSWR from 'swr';
import { format } from 'date-fns';
import { fetcher } from '@/lib/api';
import { PageHeader } from '@/components/ui';

const LABEL: Record<string, string> = {
  'client.create': 'أضاف عميل', 'client.archive': 'أرشف عميل', 'client.assign': 'عيّن فريق لعميل',
  'team.invite': 'بعت دعوة', 'team.role': 'غيّر دور عضو', 'team.remove': 'شال عضو',
  'channel.whatsapp.connect': 'ربط رقم واتساب', 'channel.social.connect': 'ربط صفحة', 'channel.whatsapp.disconnect': 'فصل رقم واتساب', 'channel.social.disconnect': 'فصل صفحة',
  'conversation.update': 'عدّل محادثة', 'post.draft': 'كتب مسودة بوست', 'post.schedule': 'جدول بوست', 'post.approve': 'وافق على بوست', 'post.edit': 'عدّل بوست',
  'post.delete': 'مسح بوست', 'post.publish_now': 'نشر بوست حالًا', 'post.published': 'البوست اتنشر', 'post.failed': 'نشر البوست فشل', 'post.partial': 'البوست اتنشر جزئيًا'
};

export default function ActivityPage() {
  const { data } = useSWR<{ items: { id: string; action: string; userName: string | null; createdAt: string }[] }>('/audit', fetcher as never);
  return (
    <>
      <PageHeader title="سجل النشاط" sub="مين عمل إيه وإمتى." />
      <ol className="divide-y divide-line px-8 max-md:px-4">
        {data?.items.map(i => (
          <li key={i.id} className="flex justify-between gap-4 py-3">
            <span><b>{i.userName ?? 'دوسلي'}</b> {LABEL[i.action] ?? i.action}</span>
            <span className="num text-sm text-muted">{format(new Date(i.createdAt), 'yyyy-MM-dd HH:mm')}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
