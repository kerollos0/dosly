'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { Copy, ExternalLink } from 'lucide-react';
import { api, fetcher, type Client } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, ErrorText, Field, Input } from './ui';

type PortalInfo = { requiresClientApproval: boolean; showAdsInPortal: boolean; users: { id: string; name: string; email: string; lastLoginAt: string | null }[] };

/** Agency side of the client portal: who can sign in, and whether posts wait for the client's OK. */
export function PortalPanel({ client, canManage }: { client: Client; canManage: boolean }) {
  const me = useMe();
  const router = useRouter();
  const { data, mutate } = useSWR<PortalInfo>(`/clients/${client.id}/portal`, fetcher as never);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(setting: 'requiresClientApproval' | 'showAdsInPortal', on: boolean) {
    try { await api(`/clients/${client.id}/portal/settings`, { method: 'PUT', body: { [setting]: on } }); await mutate(); } catch (e) { setError((e as Error).message); }
  }
  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    try {
      const r = await api<{ user: { name: string }; link: { url: string } }>(`/clients/${client.id}/portal/users`, { body: f });
      setLink({ name: r.user.name, url: r.link.url }); setCopied(false); setError(null); form.reset(); await mutate();
    } catch (err) { setError((err as Error).message); }
  }
  async function newLink(uid: string, name: string) {
    const r = await api<{ link: { url: string } }>(`/clients/${client.id}/portal/users/${uid}/link`, { method: 'POST' });
    setLink({ name, url: r.link.url }); setCopied(false);
  }
  async function remove(uid: string) { await api(`/clients/${client.id}/portal/users/${uid}`, { method: 'DELETE' }); await mutate(); }
  async function openAsClient() {
    await api('/demo/portal', { body: { clientId: client.id } });
    router.push('/portal');
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">صاحب البيزنس بيدخل البوابة بلينك من غير باسورد. بيشوف البوستات الجاية وتقرير الشهر (ومعاه الإعلانات لو سبتها ظاهرة)، ومش بيشوف المحادثات ولا فريقك.</p>

      <label className="flex items-start gap-3 rounded-[var(--radius-md)] border border-line p-3">
        <input type="checkbox" className="mt-1" checked={data?.requiresClientApproval ?? false} disabled={!canManage || !data} onChange={e => toggle('requiresClientApproval', e.target.checked)} />
        <span><span className="font-semibold">البوستات تستنى موافقة العميل</span><br /><span className="text-sm text-muted">البوست المجدول مش هيتنشر غير لما العميل يوافق عليه من البوابة.</span></span>
      </label>
      <label className="flex items-start gap-3 rounded-[var(--radius-md)] border border-line p-3">
        <input type="checkbox" className="mt-1" checked={data?.showAdsInPortal ?? true} disabled={!canManage || !data} onChange={e => toggle('showAdsInPortal', e.target.checked)} />
        <span><span className="font-semibold">العميل يشوف أرقام الإعلانات</span><br /><span className="text-sm text-muted">الصرف والنتايج وتكلفة كل نتيجة بتظهر في تقرير الشهر في البوابة.</span></span>
      </label>

      <section aria-labelledby="pu-h" className="flex flex-col gap-2">
        <h3 id="pu-h" className="font-semibold">مين يقدر يدخل</h3>
        {data?.users.length === 0 && <p className="text-sm text-muted">مفيش حد لسه.</p>}
        <ul className="flex flex-col divide-y divide-line">
          {data?.users.map(u => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span><span className="font-medium">{u.name}</span> <span className="text-sm text-muted" dir="ltr">{u.email.includes('@demo.dosly.invalid') ? '' : u.email}</span><br /><span className="text-xs text-muted">{u.lastLoginAt ? `آخر دخول ${new Date(u.lastLoginAt).toLocaleDateString('ar-EG-u-nu-latn')}` : 'لسه مدخلش'}</span></span>
              {canManage && <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => newLink(u.id, u.name)}>لينك دخول</Button><Button size="sm" variant="danger" onClick={() => remove(u.id)}>شيل</Button></span>}
            </li>
          ))}
        </ul>
      </section>

      {link && (
        <div role="status" className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-faience/40 bg-faience/8 p-3">
          <p className="text-sm">ابعت اللينك ده لـ {link.name} على الواتساب. بيشتغل مرة واحدة وخلال 7 أيام.</p>
          <div className="flex gap-2"><Input readOnly value={link.url} dir="ltr" className="text-xs" onFocus={e => e.currentTarget.select()} aria-label="لينك الدخول" />
            <Button size="sm" type="button" onClick={async () => { await navigator.clipboard.writeText(link.url); setCopied(true); }}><Copy size={16} aria-hidden />{copied ? 'اتنسخ' : 'انسخ'}</Button></div>
        </div>
      )}

      {canManage && (
        <form onSubmit={invite} className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <Field label="الاسم" id="pu-name"><Input id="pu-name" name="name" required minLength={2} /></Field>
          <Field label="الإيميل" id="pu-email"><Input id="pu-email" name="email" type="email" dir="ltr" required /></Field>
          <Button className="col-span-full" variant="ghost">ضيف شخص وطلّع لينك دخول</Button>
        </form>
      )}
      <ErrorText error={error} />
      {me.demo && data?.users.length ? <Button type="button" onClick={openAsClient}><ExternalLink size={16} aria-hidden />افتح البوابة كأنك العميل</Button> : null}
    </div>
  );
}
