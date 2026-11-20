'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorText, Field, Input } from '@/components/ui';

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setError(null);
    try {
      await api('/auth/signup', { body: f });
      router.replace('/clients');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="font-display text-[28px] font-bold">حساب وكالة جديد</h1>
      <Field label="اسم الوكالة" id="agencyName"><Input id="agencyName" name="agencyName" required minLength={2} /></Field>
      <Field label="اسمك" id="name"><Input id="name" name="name" required minLength={2} autoComplete="name" /></Field>
      <Field label="الإيميل" id="email"><Input id="email" name="email" type="email" dir="ltr" required autoComplete="email" /></Field>
      <Field label="الباسورد" id="password" hint="10 حروف على الأقل"><Input id="password" name="password" type="password" dir="ltr" minLength={10} required autoComplete="new-password" /></Field>
      <ErrorText error={error} />
      <Button disabled={busy}>{busy ? 'بيتعمل…' : 'اعمل الحساب'}</Button>
      <p className="text-sm text-muted">عندك حساب؟ <Link className="font-semibold text-faience-ink" href="/login">ادخل</Link></p>
    </form>
  );
}
