'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import useSWR from 'swr';
import { CalendarDays, History, LogOut, MessageCircle, Plug, Users, Briefcase } from 'lucide-react';
import { api, ApiError, can, fetcher, ROLE_LABEL, type Me } from '@/lib/api';
import { cx } from '@/components/ui';
import { MeContext } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { useNotifications } from '@/lib/notify';
import { DemoBar } from '@/components/demo';
import { AccountBanner } from '@/components/account-banner';


const NAV = [
  { href: '/inbox', label: 'المحادثات', icon: MessageCircle, show: () => true },
  { href: '/calendar', label: 'جدولة البوستات', icon: CalendarDays, show: () => true },
  { href: '/clients', label: 'العملاء', icon: Briefcase, show: () => true },
  { href: '/channels', label: 'القنوات', icon: Plug, show: (m: Me) => can.manage(m.role) },
  { href: '/team', label: 'الفريق', icon: Users, show: () => true },
  { href: '/activity', label: 'سجل النشاط', icon: History, show: (m: Me) => can.manage(m.role) }
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { data: me, error } = useSWR<Me>('/me', fetcher as (p: string) => Promise<Me>);
  useRealtime(!!me);
  useNotifications(me?.user.id);

  useEffect(() => { if (error instanceof ApiError && error.status === 401) router.replace('/login'); }, [error, router]);
  if (!me) return <div className="grid h-full place-items-center text-muted">{error && !(error instanceof ApiError && error.status === 401) ? 'مش قادرين نوصل للسيرفر. جرّب تاني بعد شوية.' : 'بيحمّل…'}</div>;

  async function logout() { await api('/auth/logout', { method: 'POST' }); router.replace('/login'); }

  return (
    <MeContext.Provider value={me}>
      <div className="flex h-full flex-col">
      {me.demo && <DemoBar me={me} />}
      <AccountBanner me={me} />
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside className="flex w-60 shrink-0 flex-col border-e border-line bg-surface-2 max-md:w-full max-md:border-e-0 max-md:border-b">
          <div className="flex items-center gap-3 px-5 py-5 max-md:py-3">
            <img src="/dosly-mark.svg" alt="" width={36} height={36} />
            <div className="min-w-0">
              <p className="truncate font-display font-bold">{me.agency.name}</p>
              <p className="truncate text-xs text-muted">{me.user.name} · {ROLE_LABEL[me.role]}</p>
            </div>
          </div>
          <nav aria-label="القائمة" className="flex flex-1 flex-col gap-1 px-3 max-md:flex-row max-md:overflow-x-auto max-md:pb-2">
            {NAV.filter(n => n.show(me)).map(n => {
              const active = path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                  className={cx('flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 font-medium whitespace-nowrap', active ? 'bg-primary text-on-primary' : 'text-ink hover:bg-surface')}>
                  <n.icon size={20} strokeWidth={1.75} aria-hidden />{n.label}
                </Link>
              );
            })}
          </nav>
          <button onClick={logout} className="m-3 flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-muted hover:bg-surface max-md:hidden">
            <LogOut size={20} strokeWidth={1.75} aria-hidden />خروج
          </button>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      </div>
    </MeContext.Provider>
  );
}
