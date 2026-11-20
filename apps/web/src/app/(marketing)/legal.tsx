/** Shared shell for the legal pages. They are drafts until reviewed; the banner says so. */
export function Legal({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16 max-sm:px-4 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_li]:mb-1 [&_p]:mb-3 [&_p]:leading-8 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:ps-6">
      <p role="note" className="mb-8 rounded-[var(--radius-md)] border border-sun/60 bg-sun/15 p-3 text-sm font-semibold">مسودة للمراجعة قبل الإطلاق. البيانات اللي بين [ ] لسه هتتحدد.</p>
      <h1 className="font-display text-[34px] font-bold">{title}</h1>
      <p className="text-sm text-muted">آخر تحديث: <span className="num">{updated}</span></p>
      {children}
    </article>
  );
}
