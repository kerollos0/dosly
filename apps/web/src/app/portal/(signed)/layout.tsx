'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { BarChart3, Images, LogOut, Receipt } from 'lucide-react';
import useSWR from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { cx } from '@/components/ui';
import { PortalContext, type PortalMe } from '@/lib/portal';


const NAV = [{ href: '/portal', label: 'البوستات', icon: Images }, { href: '/portal/report', label: 'تقرير الشهر', icon: BarChart3 }, { href: '/portal/billing', label: 'الفواتير', icon: Receipt }];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof Images; active: boolean }) {
  return <Link href={href} aria-current={active ? 'page' : undefined} className={cx('flex h-11 items-center gap-2 rounded-[var(--radius-md)] px-4 font-semibold focus-visible:outline-2 focus-visible:outline-primary', active ? 'bg-primary text-on-primary' : 'hover:bg-surface-2')}><Icon size={18} aria-hidden />{label}</Link>;
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { data: me, error } = useSWR<PortalMe>('/portal/me', fetcher as never);

  if (error instanceof ApiError && error.status === 401) {
    return (
      <main className="grid min-h-full place-items-center bg-surface-2 px-4">
        <div className="max-w-md rounded-[var(--radius-lg)] border border-line bg-surface p-8 text-center">
          <h1 className="mb-2 font-display text-xl font-bold">محتاج لينك دخول</h1>
          <p className="text-muted">اطلب من الوكالة اللي شغالة معاك تبعتلك لينك دخول للبوابة.</p>
        </div>
      </main>
    );
  }
  if (!me) return <div className="grid h-full place-items-center text-muted">بيحمّل…</div>;

  const isActive = (href: string) => (href === '/portal' ? path === '/portal' : href === '/portal/billing' ? path.startsWith(href) || path.startsWith('/portal/invoices') : path.startsWith(href));
  async function logout() { await api('/portal/auth/logout', { method: 'POST' }); router.replace('/portal/login'); }

  return (
    <PortalContext.Provider value={me}>
      <div className="flex min-h-full flex-col bg-surface-2">
        {me.demo && <p className="print:hidden border-b border-sun/60 bg-sun/15 px-4 py-2 text-center text-sm font-semibold">ديمو: إنت دلوقتي شايف البوابة زي صاحب البيزنس بالظبط. <Link href="/clients" className="text-faience-ink underline">ارجع للوحة الوكالة</Link></p>}
        <header className="border-b border-line bg-surface print:hidden">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4 max-sm:px-4">
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-bold">{me.client.name}</p>
              <p className="text-sm text-muted">{me.agency.name} بتدير حساباتك</p>
            </div>
            <nav aria-label="البوابة" className="flex items-center gap-1 max-sm:hidden">
              {NAV.map(n => <NavLink key={n.href} {...n} active={isActive(n.href)} />)}
            </nav>
            <button onClick={logout} className="flex h-11 shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-3 text-sm text-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"><LogOut size={16} aria-hidden />خروج</button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 max-sm:px-4 max-sm:pb-28 print:p-0">{children}</main>
        {/* On a phone the pages sit at the bottom, where the thumb is. */}
        <nav aria-label="البوابة" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t print:hidden border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
          {NAV.map(n => {
            const active = isActive(n.href), Icon = n.icon;
            return <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cx('flex h-16 flex-col items-center justify-center gap-1 text-sm font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary', active ? 'text-primary' : 'text-muted')}><Icon size={22} aria-hidden />{n.label}</Link>;
          })}
        </nav>
        <footer className="py-6 text-center max-sm:hidden print:hidden text-xs text-muted"><span dir="ltr">Powered by Dosly</span></footer>
      </div>
    </PortalContext.Provider>
  );
}
