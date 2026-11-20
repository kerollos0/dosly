export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center bg-surface-2 px-4 py-12">
      <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-line bg-surface p-8 max-sm:p-6">
        <img src="/dosly-logo-ar.svg" alt="دوسلي" height={40} className="mb-8 h-10 w-auto dark:hidden" />
        <img src="/dosly-logo-ar-reversed.svg" alt="دوسلي" height={40} className="mb-8 hidden h-10 w-auto dark:block" />
        {children}
      </div>
    </main>
  );
}
