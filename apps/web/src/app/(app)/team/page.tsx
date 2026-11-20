'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { api, can, fetcher, ROLE_LABEL, type Member, type Role } from '@/lib/api';
import { useMe } from '@/lib/me';
import { Button, ErrorText, Field, Input, Modal, PageHeader, Pill, Select } from '@/components/ui';

export default function TeamPage() {
  const me = useMe();
  const { data, mutate } = useSWR<{ members: Member[]; invites: { id: string; email: string; role: Role }[] }>('/team', fetcher as never);
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const manage = can.manage(me.role);

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try { const r = await api<{ link: string }>('/team/invites', { body: f }); setLink(r.link); setError(null); await mutate(); } catch (err) { setError((err as Error).message); }
  }
  async function act(fn: () => Promise<unknown>) { try { await fn(); await mutate(); } catch (err) { alertError((err as Error).message); } }
  const alertError = (m: string) => setError(m);

  return (
    <>
      <PageHeader title="الفريق" sub="المودريتورز وكتّاب المحتوى والمديرين." action={manage && <Button onClick={() => { setInviting(true); setLink(null); }}>دعوة عضو</Button>} />
      <div className="p-8 max-md:p-4">
        <ErrorText error={!inviting ? error : null} />
        <div className="overflow-x-auto">
          <table className="w-full text-start">
            <thead><tr className="border-b border-line text-[13px] text-muted"><th className="py-2 text-start">الاسم</th><th className="text-start">الإيميل</th><th className="text-start">الدور</th><th /></tr></thead>
            <tbody>
              {data?.members.map(m => (
                <tr key={m.id} className="border-b border-line">
                  <td className="py-3 font-semibold">{m.name}</td>
                  <td className="num text-muted">{m.email.endsWith(".invalid") ? "حساب ديمو" : m.email}</td>
                  <td>
                    {manage && m.role !== 'OWNER' && m.id !== me.user.id ? (
                      <Select aria-label={`دور ${m.name}`} className="h-9 w-40" defaultValue={m.role} onChange={e => act(() => api(`/team/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }))}>
                        {(['MANAGER', 'MODERATOR', 'WRITER'] as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </Select>
                    ) : <Pill tone="info">{ROLE_LABEL[m.role]}</Pill>}
                  </td>
                  <td className="text-end">{manage && m.role !== 'OWNER' && m.id !== me.user.id && <Button size="sm" variant="danger" onClick={() => act(() => api(`/team/${m.id}`, { method: 'DELETE' }))}>شيل</Button>}</td>
                </tr>
              ))}
              {data?.invites.map(i => (
                <tr key={i.id} className="border-b border-line text-muted">
                  <td className="py-3">دعوة مستنية</td><td className="num">{i.email}</td><td>{ROLE_LABEL[i.role]}</td>
                  <td className="text-end">{manage && <Button size="sm" variant="ghost" onClick={() => act(() => api(`/team/invites/${i.id}`, { method: 'DELETE' }))}>إلغاء</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Modal open={inviting} onClose={() => setInviting(false)} title="دعوة عضو">
        {link ? (
          <div className="flex flex-col gap-3">
            <p>ابعت اللينك ده للعضو على واتساب. صالح لمدة 7 أيام ولمرة واحدة.</p>
            <Input readOnly value={link} dir="ltr" onFocus={e => e.currentTarget.select()} />
            <Button onClick={() => navigator.clipboard.writeText(link).catch(() => {})}>انسخ اللينك</Button>
          </div>
        ) : (
          <form onSubmit={invite} className="flex flex-col gap-4">
            <Field label="الإيميل" id="email"><Input id="email" name="email" type="email" dir="ltr" required /></Field>
            <Field label="الدور" id="role">
              <Select id="role" name="role" defaultValue="MODERATOR">
                <option value="MODERATOR">مودريتور: يرد على رسايل العملاء المتعين عليهم</option>
                <option value="WRITER">كاتب محتوى: يكتب بوستات وتستنى الموافقة</option>
                <option value="MANAGER">مدير: كل حاجة ما عدا إعدادات الوكالة</option>
              </Select>
            </Field>
            <ErrorText error={error} />
            <Button>اعمل لينك الدعوة</Button>
          </form>
        )}
      </Modal>
    </>
  );
}
