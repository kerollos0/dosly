'use client';
import Link from 'next/link';
import useSWR from 'swr';
import { AlertTriangle, CalendarCheck, CalendarDays, CheckCircle2, FileClock, Megaphone, MessageCircle, MessagesSquare, PencilLine, type LucideIcon } from 'lucide-react';
import { fetcher } from '@/lib/api';
import { useMe } from '@/lib/me';
import { cx, ErrorText } from '@/components/ui';
import { ago, count, greeting, when } from '@/lib/when';

type Today = {
  inbox: { waiting: number; mine: number; oldestWaitingAt: string | null } | null;
  comments: number | null;
  posts: {
    draftsToApprove: number | null; changesRequested: number | null; failed: number | null; waitingForClient: number | null; publishingToday: number;
    changes: { id: string; scheduledAt: string | null; note: string | null; client: string }[];
  };
  adAlerts: number | null;
};

type Task = { key: string; icon: LucideIcon; tone: 'bad' | 'warn' | 'info'; title: string; sub?: string; href: string; action: string; extra?: React.ReactNode };

const TONE = { bad: 'border-danger/40 bg-danger/5 text-danger', warn: 'border-warning/40 bg-warning/5 text-warning', info: 'border-line bg-surface text-faience-ink' };

function TaskCard({ t }: { t: Task }) {
  const Icon = t.icon;
  return (
    <li className={cx('relative flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] border p-4', TONE[t.tone].split(' ').slice(0, 2).join(' '))}>
      <span className={cx('grid size-11 shrink-0 place-items-center rounded-full bg-surface', TONE[t.tone].split(' ')[2])}><Icon size={22} aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold">{t.title}</p>
        {t.sub && <p className="text-muted">{t.sub}</p>}
        {t.extra}
      </div>
      <Link href={t.href} className="inline-flex h-11 after:absolute after:inset-0 after:rounded-[var(--radius-lg)] after:content-[''] items-center rounded-[var(--radius-md)] bg-primary px-5 font-semibold text-on-primary hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary max-sm:w-full max-sm:justify-center">{t.action}</Link>
    </li>
  );
}

/** The first screen: what needs doing now, in plain sentences, with one button each. */
export default function TodayPage() {
  const me = useMe();
  const { data: d, error } = useSWR<Today>('/today', fetcher as never, { refreshInterval: 60_000 });
  const first = me.user.name.split(' ')[0];

  const tasks: Task[] = [];
  if (d) {
    const i = d.inbox, p = d.posts;
    if (i?.waiting) tasks.push({
      key: 'inbox', icon: MessageCircle, tone: 'bad', href: '/inbox', action: 'رد على العملاء',
      title: `${count(i.waiting, 'عميل واحد مستني', 'عميلين مستنيين', 'عملاء مستنيين', 'عميل مستني')} رد`,
      sub: [i.mine ? count(i.mine, 'واحد منهم بتاعك', 'اتنين منهم بتوعك', 'منهم بتوعك', 'منهم بتوعك') : null, i.oldestWaitingAt ? `أقدم واحد مستني ${ago(i.oldestWaitingAt)}` : null].filter(Boolean).join('، ') || undefined
    });
    if (d.comments) tasks.push({ key: 'comments', icon: MessagesSquare, tone: 'warn', href: '/comments', action: 'شوف الكومنتات', title: `${count(d.comments, 'كومنت واحد مستني', 'كومنتين مستنيين', 'كومنتات مستنية', 'كومنت مستني')} رد` });
    if (p.changesRequested) tasks.push({
      key: 'changes', icon: PencilLine, tone: 'warn', href: '/calendar?show=changes', action: 'عدّل البوستات',
      title: p.changesRequested === 1 ? 'عميل طلب تعديل في بوست' : `العملاء طلبوا تعديل في ${count(p.changesRequested, '', 'بوستين', 'بوستات', 'بوست')}`,
      extra: (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {p.changes.map(c => <li key={c.id}><span className="font-semibold">{c.client}</span>{c.scheduledAt ? <span className="text-muted">، بوست {when(c.scheduledAt)}</span> : null}{c.note ? <>: «{c.note}»</> : null}</li>)}
          {p.changesRequested > p.changes.length && <li className="text-muted">و{count(p.changesRequested - p.changes.length, 'بوست كمان', 'بوستين كمان', 'بوستات كمان', 'بوست كمان')}</li>}
        </ul>
      )
    });
    if (p.failed) tasks.push({ key: 'failed', icon: AlertTriangle, tone: 'bad', href: '/calendar?show=failed', action: 'شوف البوستات', title: count(p.failed, 'بوست واحد منزلش', 'بوستين منزلوش', 'بوستات منزلتش', 'بوست منزلش'), sub: 'افتح البوست وشوف السبب، وبعدين دوس "جرّب تاني".' });
    if (p.draftsToApprove) tasks.push({ key: 'drafts', icon: FileClock, tone: 'warn', href: '/calendar?show=drafts', action: 'راجع المسودات', title: `${count(p.draftsToApprove, 'مسودة واحدة مستنية', 'مسودتين مستنيين', 'مسودات مستنية', 'مسودة مستنية')} موافقتك`, sub: 'الكاتب جهّزها، ومش هتتنشر غير لما توافق عليها.' });
    if (d.adAlerts) tasks.push({ key: 'ads', icon: Megaphone, tone: 'bad', href: '/ads', action: 'شوف التنبيهات', title: `${count(d.adAlerts, 'تنبيه واحد', 'تنبيهين', 'تنبيهات', 'تنبيه')} في الإعلانات`, sub: 'حساب واقف، أو حملة وقفت، أو ميزانية قرّبت تخلص.' });
  }
  // Problems that cost money or customers first, then the rest, each group in the order above.
  tasks.sort((a, b) => Number(b.tone === 'bad') - Number(a.tone === 'bad'));
  const info: { icon: LucideIcon; text: string }[] = d ? [
    d.posts.publishingToday ? { icon: CalendarCheck, text: `هيتنشر النهارده ${count(d.posts.publishingToday, 'بوست واحد', 'بوستين', 'بوستات', 'بوست')} في ميعادها، من غير ما تعمل حاجة.` } : { icon: CalendarDays, text: 'مفيش بوستات متجدولة النهارده.' },
    ...(d.posts.waitingForClient ? [{ icon: FileClock, text: `${count(d.posts.waitingForClient, 'بوست واحد مستني', 'بوستين مستنيين', 'بوستات مستنية', 'بوست مستني')} موافقة العميل. هيوصلك تنبيه أول ما العميل يرد.` }] : [])
  ] : [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8 max-md:p-4">
      <header>
        <h1 className="font-display text-[28px] font-bold leading-9">{greeting()} يا {first}</h1>
        <p className="mt-1 text-lg text-muted">
          {!d ? (error ? '' : 'بنشوف إيه اللي محتاجك…') : tasks.length ? `${count(tasks.length, 'حاجة واحدة محتاجة', 'حاجتين محتاجين', 'حاجات محتاجة', 'حاجة محتاجة')} تتعمل. ابدأ بأول واحدة.` : ''}
        </p>
      </header>
      {error && !d && <ErrorText error="مش قادرين نجيب الملخص دلوقتي. جرّب تاني بعد شوية." />}
      {d && !tasks.length && (
        <p role="status" className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-success/30 bg-success/5 p-5 text-lg">
          <CheckCircle2 size={26} aria-hidden className="mt-0.5 shrink-0 text-success" />كله تمام. مفيش حاجة مستنياك دلوقتي.
        </p>
      )}
      {!!tasks.length && <ul aria-label="محتاج تتعمل" className="flex flex-col gap-3">{tasks.map(t => <TaskCard key={t.key} t={t} />)}</ul>}
      {!!info.length && (
        <section aria-labelledby="today-info-h" className="flex flex-col gap-2">
          <h2 id="today-info-h" className="text-sm font-semibold text-muted">للعلم</h2>
          <ul className="flex flex-col gap-2">
            {info.map(x => { const Icon = x.icon; return <li key={x.text} className="flex items-center gap-3 text-muted"><Icon size={20} aria-hidden className="shrink-0" />{x.text}</li>; })}
          </ul>
        </section>
      )}
    </div>
  );
}
