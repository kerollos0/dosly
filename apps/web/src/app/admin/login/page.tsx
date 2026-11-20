'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorText, Field, Input } from '@/components/ui';

export default function AdminLogin() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setError(null);
    try { await api('/admin/auth/login', { body: f }); router.replace('/admin'); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <main className="grid min-h-full place-items-center bg-surface-2 px-4">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-8">
        <div className="flex items-center gap-3"><img src="/dosly-mark.svg" alt="" width={36} height={36} /><h1 className="font-display text-2xl font-bold">إدارة دوسلي</h1></div>
        <Field label="الإيميل" id="email"><Input id="email" name="email" type="email" dir="ltr" autoComplete="username" required /></Field>
        <Field label="الباسورد" id="password"><Input id="password" name="password" type="password" dir="ltr" autoComplete="current-password" required /></Field>
        <Field label="الكود من تطبيق Authenticator" id="code"><Input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} dir="ltr" autoComplete="one-time-code" required /></Field>
        <ErrorText error={error} />
        <Button disabled={busy}>{busy ? 'بيدخل…' : 'ادخل'}</Button>
      </form>
    </main>
  );
}
