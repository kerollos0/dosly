'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { api, fetcher, type Client } from '@/lib/api';
import { Button, ErrorText, Field, Input, PageHeader, Pill, Select } from '@/components/ui';

type Channels = {
  whatsapp: { id: string; clientId: string; displayPhone: string; verifiedName: string | null; status: string }[];
  social: { id: string; clientId: string; platform: string; name: string; status: string }[];
};

export default function ChannelsPage() {
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const { data, mutate } = useSWR<Channels>('/channels', fetcher as never);
  const [waError, setWaError] = useState<string | null>(null);
  const [soError, setSoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientName = (id: string) => clients?.find(c => c.id === id)?.name ?? '';

  async function submit(e: React.FormEvent<HTMLFormElement>, path: string, setErr: (s: string | null) => void) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true); setErr(null);
    try { await api(path, { body: Object.fromEntries(new FormData(form)) }); form.reset(); await mutate(); } catch (err) { setErr((err as Error).message); } finally { setBusy(false); }
  }
  async function remove(kind: string, id: string) { await api(`/channels/${kind}/${id}`, { method: 'DELETE' }); await mutate(); }

  const ClientSelect = () => (
    <Field label="العميل" id="clientId">
      <Select id="clientId" name="clientId" required defaultValue=""><option value="" disabled>اختار العميل</option>{clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
    </Field>
  );

  return (
    <>
      <PageHeader title="القنوات" sub="اربط أرقام واتساب وصفحات فيسبوك وحسابات إنستجرام لكل عميل. التوكنز بتتخزن متشفرة ومش بتظهر تاني." />
      <div className="grid gap-8 p-8 lg:grid-cols-2 max-md:p-4">
        <section className="flex flex-col gap-4">
          <h2 className="font-display text-[22px] font-semibold">واتساب</h2>
          <ul className="flex flex-col gap-2">
            {data?.whatsapp.map(w => (
              <li key={w.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line p-3">
                <span><span className="num font-semibold">{w.displayPhone}</span> · {clientName(w.clientId)} {w.verifiedName && <span className="text-muted">({w.verifiedName})</span>}</span>
                <span className="flex items-center gap-2"><Pill tone={w.status === 'CONNECTED' ? 'good' : 'bad'}>{w.status === 'CONNECTED' ? 'متصل' : 'مفصول'}</Pill><Button size="sm" variant="ghost" onClick={() => remove('whatsapp', w.id)}>فصل</Button></span>
              </li>
            ))}
          </ul>
          <form onSubmit={e => submit(e, '/channels/whatsapp', setWaError)} className="flex flex-col gap-4 rounded-[var(--radius-md)] bg-surface-2 p-4">
            <h3 className="font-semibold">ربط رقم</h3>
            <ClientSelect />
            <Field label="Phone number ID" id="phoneNumberId" hint="من صفحة WhatsApp > API Setup في تطبيق Meta"><Input id="phoneNumberId" name="phoneNumberId" dir="ltr" inputMode="numeric" required /></Field>
            <Field label="WhatsApp Business Account ID" id="wabaId"><Input id="wabaId" name="wabaId" dir="ltr" inputMode="numeric" required /></Field>
            <Field label="Access token" id="wa-token" hint="استخدم System User token دائم. التوكن المؤقت بيخلص بعد 24 ساعة."><Input id="wa-token" name="accessToken" type="password" dir="ltr" autoComplete="off" required /></Field>
            <ErrorText error={waError} />
            <Button disabled={busy}>اربط الرقم</Button>
          </form>
        </section>
        <section className="flex flex-col gap-4">
          <h2 className="font-display text-[22px] font-semibold">فيسبوك وإنستجرام</h2>
          <ul className="flex flex-col gap-2">
            {data?.social.map(s => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line p-3">
                <span><b>{s.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'}</b> · {s.name} · {clientName(s.clientId)}</span>
                <Button size="sm" variant="ghost" onClick={() => remove('social', s.id)}>فصل</Button>
              </li>
            ))}
          </ul>
          <form onSubmit={e => submit(e, '/channels/social', setSoError)} className="flex flex-col gap-4 rounded-[var(--radius-md)] bg-surface-2 p-4">
            <h3 className="font-semibold">ربط صفحة أو حساب</h3>
            <ClientSelect />
            <Field label="المنصة" id="platform"><Select id="platform" name="platform"><option value="FACEBOOK_PAGE">صفحة فيسبوك</option><option value="INSTAGRAM">حساب إنستجرام Professional</option></Select></Field>
            <Field label="الاسم" id="name"><Input id="name" name="name" required /></Field>
            <Field label="Page ID أو Instagram account ID" id="externalId"><Input id="externalId" name="externalId" dir="ltr" inputMode="numeric" required /></Field>
            <Field label="Page access token" id="so-token"><Input id="so-token" name="accessToken" type="password" dir="ltr" autoComplete="off" required /></Field>
            <ErrorText error={soError} />
            <Button disabled={busy}>اربط</Button>
          </form>
        </section>
      </div>
    </>
  );
}
