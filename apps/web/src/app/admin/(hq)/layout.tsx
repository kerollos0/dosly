'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import useSWR from 'swr';
import { Activity, Building2, LayoutDashboard, LogOut } from 'lucide-react';
import { api, ApiError, fetcher } from '@/lib/api';
import { cx } from '@/components/ui';

const NAV = [
  { href: '/admin', label: 'نظرة عامة', icon: LayoutDashboard },
  { href: '/admin/agencies', label: 'الوكالات', icon: Building2 },
  { href: '/admin/health', label: 'صحة النظام', icon: Activity }
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { data: me, error } = useSWR<{ name: string; readOnly: boolean }>('/admin/me', fetcher as never);
  useEffect(() => { if (error instanceof ApiError && error.status === 401) router.replace('/admin/login'); }, [error, router]);
  if (!me) return <div className="grid h-full place-items-center text-muted">بيحمّل…</div>;
  async function logout() { await api('/admin/auth/logout', { method: 'POST' }); router.replace(me?.readOnly ? '/today' : '/admin/login'); }
  return (
    <div className="flex h-full flex-col">
      {me.readOnly && <p className="border-b border-sun/60 bg-sun/15 px-4 py-2 text-center text-sm font-semibold">ديمو: دي لوحة إدارة دوسلي نفسها (ليك إنت كصاحب المنتج). للعرض بس، ومش بتظهر غير وكالات الديمو. <Link href="/inbox" className="text-faience-ink underline">ارجع للوكالة</Link></p>}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <aside className="flex w-56 shrink-0 flex-col bg-ink text-surface max-md:w-full">
          <div className="flex items-center gap-3 px-5 py-5 max-md:py-3"><img src="/dosly-mark.svg" alt="" width={32} height={32} /><div><p className="font-display font-bold">دوسلي HQ</p><p className="text-xs opacity-70">{me.name}</p></div></div>
          <nav aria-label="الإدارة" className="flex flex-1 flex-col gap-1 px-3 max-md:flex-row max-md:overflow-x-auto max-md:pb-2">
            {NAV.map(n => {
              const active = n.href === '/admin' ? path === '/admin' : path.startsWith(n.href);
              return <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cx('flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 whitespace-nowrap', active ? 'bg-faience text-[#062421] font-semibold' : 'opacity-85 hover:bg-white/10')}><n.icon size={18} aria-hidden />{n.label}</Link>;
            })}
          </nav>
          <button onClick={logout} className="m-3 flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 opacity-75 hover:bg-white/10 max-md:hidden"><LogOut size={18} aria-hidden />خروج</button>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto bg-surface">{children}</main>
      </div>
    </div>
  );
}
