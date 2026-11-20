'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorText, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await api('/auth/login', { body: { email: f.get('email'), password: f.get('password') } });
      router.replace('/inbox');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="font-display text-[28px] font-bold">تسجيل الدخول</h1>
      <Field label="الإيميل" id="email"><Input id="email" name="email" type="email" dir="ltr" autoComplete="email" required /></Field>
      <Field label="الباسورد" id="password"><Input id="password" name="password" type="password" dir="ltr" autoComplete="current-password" required /></Field>
      <ErrorText error={error} />
      <Button disabled={busy}>{busy ? 'بيدخل…' : 'ادخل'}</Button>
      <p className="text-sm text-muted">وكالة جديدة؟ <Link className="font-semibold text-faience-ink" href="/signup">اعمل حساب</Link></p>
    </form>
  );
}
