'use client';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type Ref, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' };
export function Button({ variant = 'primary', size = 'md', className, ...p }: BtnProps) {
  return <button {...p} className={cx(
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed',
    size === 'sm' ? 'h-8 px-3 text-sm' : size === 'lg' ? 'h-12 px-5 text-base' : 'h-10 px-4',
    variant === 'primary' && 'bg-primary text-on-primary hover:brightness-110',
    variant === 'ghost' && 'border border-line text-ink hover:bg-surface-2',
    variant === 'danger' && 'border border-danger text-danger hover:bg-danger/10',
    className)} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx('h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-ink placeholder:text-muted', className)} />;
});

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx('w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted', className)} />;
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx('h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-ink', className)} />;
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-semibold">{label}</label>
      {children}
      {hint && <p className="text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function PageHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-8 py-6 max-md:px-4">
      <div>
        <h1 className="font-display text-[28px] font-bold leading-9">{title}</h1>
        {sub && <p className="mt-1 text-muted">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

const PILL: Record<string, string> = {
  good: 'bg-success/12 text-success', warn: 'bg-warning/12 text-warning', bad: 'bg-danger/12 text-danger', info: 'bg-faience/12 text-faience-ink', sun: 'bg-sun text-[#0F1B2D]', neutral: 'bg-surface-2 text-muted'
};
export function Pill({ tone = 'neutral', children }: { tone?: keyof typeof PILL; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', PILL[tone])}>{children}</span>;
}

export function ErrorText({ error }: { error?: string | null }) {
  return error ? <p role="alert" className="text-sm text-danger">{error}</p> : null;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    // Focus moves into the dialog, Escape closes it, and focus returns to what opened it.
    requestAnimationFrame(() => { if (!box.current?.contains(document.activeElement)) (box.current?.querySelector<HTMLElement>('input,select,textarea,button:not([aria-label="إغلاق"])') ?? box.current)?.focus(); });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); back?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="max-h-[90vh] focus:outline-none w-full max-w-lg overflow-y-auto rounded-[var(--radius-lg)] bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-[22px] font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="إغلاق" className="grid size-11 place-items-center rounded-[var(--radius-md)] text-muted hover:bg-surface-2">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <img src="/dosly-mark.svg" alt="" width={48} height={48} className="opacity-80" />
      <h2 className="font-display text-[22px] font-semibold">{title}</h2>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

export { cx };
