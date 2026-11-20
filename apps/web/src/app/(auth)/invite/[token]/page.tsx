'use client';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorText, Field, Input } from '@/components/ui';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      await api('/invites/accept', { body: { token, name: f.get('name'), password: f.get('password') } });
      router.replace('/today');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="font-display text-[28px] font-bold">انضم لفريق الوكالة</h1>
      <p className="text-muted">اكتب اسمك واختار باسورد. لو عندك حساب دوسلي بنفس الإيميل، اكتب الباسورد بتاعه.</p>
      <Field label="اسمك" id="name"><Input id="name" name="name" required minLength={2} /></Field>
      <Field label="الباسورد" id="password" hint="10 حروف على الأقل"><Input id="password" name="password" type="password" dir="ltr" minLength={10} required /></Field>
      <ErrorText error={error} />
      <Button disabled={busy}>انضم</Button>
    </form>
  );
}
