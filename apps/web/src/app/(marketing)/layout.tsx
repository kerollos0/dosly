import Link from 'next/link';

const NAV = [
  { href: '/#features', label: 'المميزات' },
  { href: '/#how', label: 'إزاي بتشتغل' },
  { href: '/#pricing', label: 'الأسعار' },
  { href: '/#faq', label: 'أسئلة' }
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-surface">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:p-2">تخطّى للمحتوى</a>
      <header className="sticky top-0 z-40 border-b border-line/70 bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6 max-sm:px-4">
          <Link href="/" aria-label="دوسلي، الرئيسية" className="shrink-0">
            <img src="/dosly-logo-ar.svg" alt="دوسلي" className="h-8 w-auto dark:hidden" />
            <img src="/dosly-logo-ar-reversed.svg" alt="دوسلي" className="hidden h-8 w-auto dark:block" />
          </Link>
          <nav aria-label="الرئيسية" className="flex items-center gap-1 max-md:hidden">
            {NAV.map(n => <a key={n.href} href={n.href} className="rounded-[var(--radius-md)] px-3 py-2 text-muted hover:text-ink">{n.label}</a>)}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-[var(--radius-md)] px-3 py-2 font-medium hover:bg-surface-2 max-sm:hidden">ادخل</Link>
            <Link href="/login#demo" className="rounded-[var(--radius-md)] bg-primary px-4 py-2 font-semibold text-on-primary hover:brightness-110">جرّب الديمو</Link>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="border-t border-line bg-surface-2">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-8 px-6 py-10 max-sm:px-4">
          <div className="flex max-w-xs flex-col gap-3">
            <img src="/dosly-logo-ar.svg" alt="دوسلي" className="h-8 w-fit dark:hidden" />
            <img src="/dosly-logo-ar-reversed.svg" alt="دوسلي" className="hidden h-8 w-fit dark:block" />
            <p className="text-sm text-muted">لوحة واحدة لوكالات التسويق: واتساب كل عميل، وبوستاته، وفريقك، وتقاريره.</p>
          </div>
          <nav aria-label="روابط" className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm">
            <a href="/#features" className="text-muted hover:text-ink">المميزات</a>
            <Link href="/privacy" className="text-muted hover:text-ink">سياسة الخصوصية</Link>
            <a href="/#pricing" className="text-muted hover:text-ink">الأسعار</a>
            <Link href="/terms" className="text-muted hover:text-ink">الشروط والأحكام</Link>
            <Link href="/login" className="text-muted hover:text-ink">تسجيل الدخول</Link>
            <Link href="/data-deletion" className="text-muted hover:text-ink">حذف البيانات</Link>
          </nav>
        </div>
        <p className="pb-8 text-center text-xs text-muted">© <span className="num">{new Date().getFullYear()}</span> دوسلي</p>
      </footer>
    </div>
  );
}
