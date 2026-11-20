'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import useSWR from 'swr';
import { api, ApiError, fetcher } from '@/lib/api';
import { cx } from '@/components/ui';
import { PortalContext, type PortalMe } from '@/lib/portal';


const NAV = [{ href: '/portal', label: 'البوستات' }, { href: '/portal/report', label: 'تقرير الشهر' }];

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

  async function logout() { await api('/portal/auth/logout', { method: 'POST' }); router.replace('/portal/login'); }

  return (
    <PortalContext.Provider value={me}>
      <div className="flex min-h-full flex-col bg-surface-2">
        {me.demo && <p className="border-b border-sun/60 bg-sun/15 px-4 py-2 text-center text-sm font-semibold">ديمو: إنت دلوقتي شايف البوابة زي صاحب البيزنس بالظبط. <Link href="/clients" className="text-faience-ink underline">ارجع للوحة الوكالة</Link></p>}
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4 max-sm:px-4">
            <div>
              <p className="font-display text-xl font-bold">{me.client.name}</p>
              <p className="text-sm text-muted">بتدير حساباتك {me.agency.name}</p>
            </div>
            <nav aria-label="البوابة" className="flex items-center gap-1">
              {NAV.map(n => {
                const active = n.href === '/portal' ? path === '/portal' : path.startsWith(n.href);
                return <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cx('rounded-[var(--radius-md)] px-3 py-2 font-medium', active ? 'bg-primary text-on-primary' : 'hover:bg-surface-2')}>{n.label}</Link>;
              })}
              <button onClick={logout} className="px-3 py-2 text-sm text-muted hover:text-ink">خروج</button>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8 max-sm:px-4">{children}</main>
        <footer className="py-6 text-center text-xs text-muted">أهلًا {me.user.name} · <span dir="ltr">Powered by Dosly</span></footer>
      </div>
    </PortalContext.Provider>
  );
}
