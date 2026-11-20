'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/** Opens the one-time link. The token sits after "#", so it never reaches any server log. */
export default function PortalLogin() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const token = window.location.hash.slice(1);
    history.replaceState(null, '', '/portal/login'); // drop the token from the address bar and history
    if (!token) { setError('اللينك ناقص. افتح اللينك اللي الوكالة بعتتهولك زي ما هو.'); return; }
    api('/portal/auth/consume', { body: { token } }).then(() => router.replace('/portal'), e => setError((e as Error).message));
  }, [router]);
  return (
    <main className="grid min-h-full place-items-center bg-surface-2 px-4">
      <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-line bg-surface p-8 text-center">
        <img src="/dosly-mark.svg" alt="" width={48} height={48} className="mx-auto mb-4" />
        {error ? <p role="alert" className="text-danger">{error}</p> : <p className="text-muted">بندخّلك…</p>}
      </div>
    </main>
  );
}
