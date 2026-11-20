'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { CalendarDays, Menu, Sun, X, History, LogOut, Megaphone, MessageCircle, MessagesSquare, Plug, Users, Briefcase, ShoppingBag } from 'lucide-react';
import { api, ApiError, can, fetcher, ROLE_LABEL, type Me } from '@/lib/api';
import { cx } from '@/components/ui';
import { MeContext } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { useNotifications } from '@/lib/notify';
import { DemoBar } from '@/components/demo';
import { AccountBanner } from '@/components/account-banner';


const NAV = [
  { href: '/today', label: 'النهارده', icon: Sun, show: () => true },
  { href: '/inbox', label: 'المحادثات', icon: MessageCircle, show: () => true },
  // Moderators see it once a store is connected; managers always, to find where to connect one.
  { href: '/orders', label: 'الطلبات', icon: ShoppingBag, show: (m: Me, stores?: number) => can.manage(m.role) || (can.reply(m.role) && !!stores) },
  { href: '/comments', label: 'الكومنتات', icon: MessagesSquare, show: () => true },
  { href: '/calendar', label: 'البوستات', icon: CalendarDays, show: () => true },
  { href: '/ads', label: 'الإعلانات', icon: Megaphone, show: (m: Me) => can.manage(m.role) },
  { href: '/clients', label: 'العملاء', icon: Briefcase, show: () => true },
  { href: '/channels', label: 'القنوات', icon: Plug, show: (m: Me) => can.manage(m.role) },
  { href: '/team', label: 'الفريق', icon: Users, show: () => true },
  { href: '/activity', label: 'سجل النشاط', icon: History, show: (m: Me) => can.manage(m.role) }
] satisfies { href: string; label: string; icon: typeof Sun; show: (m: Me, stores?: number) => boolean }[];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { data: me, error } = useSWR<Me>('/me', fetcher as (p: string) => Promise<Me>);
  useRealtime(!!me);
  useNotifications(me?.user.id);
  const { data: comments } = useSWR<{ openCount: number }>(me ? '/comments?limit=1' : null, fetcher as never, { refreshInterval: 60_000 });
  const { data: adAlerts } = useSWR<{ count: number }>(me && can.manage(me.role) ? '/ads/alerts' : null, fetcher as never, { refreshInterval: 5 * 60_000 });
  const { data: orders } = useSWR<{ followUp: number; stores: number }>(me && can.reply(me.role) ? '/orders/counts' : null, fetcher as never, { refreshInterval: 5 * 60_000 });

  // On a phone: four pages in a bottom bar where the thumb is, the rest behind "المزيد".
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [path]);
  useEffect(() => { if (error instanceof ApiError && error.status === 401) router.replace('/login'); }, [error, router]);
  if (!me) return <div className="grid h-full place-items-center text-muted">{error && !(error instanceof ApiError && error.status === 401) ? 'مش قادرين نوصل للسيرفر. جرّب تاني بعد شوية.' : 'بيحمّل…'}</div>;

  const items = NAV.filter(n => n.show(me, orders?.stores));
  const badge = (href: string, active: boolean) => href === '/orders' && orders?.followUp
    ? <span className={cx('num rounded-full px-1.5 text-xs font-semibold', active ? 'bg-on-primary/20' : 'bg-warning text-white')}>{orders.followUp}<span className="sr-only"> محتاجة مكالمة</span></span>
    : href === '/ads' && adAlerts?.count
    ? <span className={cx('num rounded-full px-1.5 text-xs font-semibold', active ? 'bg-on-primary/20' : 'bg-danger text-white')}>{adAlerts.count}<span className="sr-only"> تنبيهات</span></span>
    : href === '/comments' && comments?.openCount
      ? <span className={cx('num rounded-full px-1.5 text-xs font-semibold', active ? 'bg-on-primary/20' : 'bg-sun text-[#0F1B2D]')}>{comments.openCount}<span className="sr-only"> محتاجة رد</span></span>
      : null;
  const bottom = items.slice(0, 4), rest = items.slice(4);
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
              <p className="truncate text-xs text-muted">{me.demo ? 'حساب تجريبي' : me.user.name} · {ROLE_LABEL[me.role]}</p>
            </div>
          </div>
          <nav aria-label="القائمة" className="flex flex-1 flex-col gap-1 px-3 max-md:hidden">
            {items.map(n => {
              const active = path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}
                  className={cx('relative flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 font-medium whitespace-nowrap', active ? 'bg-primary text-on-primary' : 'text-ink hover:bg-surface')}>
                  <n.icon size={20} strokeWidth={1.75} aria-hidden />{n.label}
                  <span className="ms-auto">{badge(n.href, active)}</span>
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
      <nav aria-label="القائمة" className="grid shrink-0 grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {bottom.map(n => {
          const active = path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cx('relative flex h-16 flex-col items-center justify-center gap-1 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary', active ? 'text-primary' : 'text-muted')}>
              <n.icon size={22} strokeWidth={1.75} aria-hidden />{n.label}
              {badge(n.href, false) && <span className="absolute top-1.5 start-1/2 ms-2">{badge(n.href, false)}</span>}
            </Link>
          );
        })}
        <button type="button" aria-expanded={more} aria-controls="more-menu" onClick={() => setMore(m => !m)} className={cx('flex h-16 flex-col items-center justify-center gap-1 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary', more || rest.some(n => path.startsWith(n.href)) ? 'text-primary' : 'text-muted')}>
          {more ? <X size={22} aria-hidden /> : <Menu size={22} aria-hidden />}المزيد
        </button>
      </nav>
      {more && (
        <div id="more-menu" className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-line bg-surface p-3 shadow-xl md:hidden">
          <ul className="grid grid-cols-2 gap-2">
            {rest.map(n => {
              const active = path.startsWith(n.href);
              return <li key={n.href}><Link href={n.href} aria-current={active ? 'page' : undefined} className={cx('flex h-12 items-center gap-3 rounded-[var(--radius-md)] px-3 font-semibold', active ? 'bg-primary text-on-primary' : 'bg-surface-2')}><n.icon size={20} aria-hidden />{n.label}<span className="ms-auto">{badge(n.href, active)}</span></Link></li>;
            })}
            <li><button onClick={logout} className="flex h-12 w-full items-center gap-3 rounded-[var(--radius-md)] bg-surface-2 px-3 font-semibold text-muted"><LogOut size={20} aria-hidden />خروج</button></li>
          </ul>
        </div>
      )}
      </div>
    </MeContext.Provider>
  );
}
