/** Shared shell for the legal pages. Company details live in lib/company.ts. */
export function Legal({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16 max-sm:px-4 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_li]:mb-1 [&_p]:mb-3 [&_p]:leading-8 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:ps-6">
      <h1 className="font-display text-[34px] font-bold">{title}</h1>
      <p className="text-sm text-muted">آخر تحديث: <span className="num">{updated}</span></p>
      {children}
    </article>
  );
}
