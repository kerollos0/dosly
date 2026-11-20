'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { Building2, FlaskConical, MessageCircle, MessageSquarePlus, MessagesSquare, Receipt, ShoppingBag, X } from 'lucide-react';
import { api, ROLE_LABEL, type Me, type Role } from '@/lib/api';
import { Button, cx, ErrorText, Select } from './ui';

const ROLES: Role[] = ['OWNER', 'MANAGER', 'MODERATOR', 'WRITER'];
const ROLE_HINT: Record<Role, string> = {
  OWNER: 'كل حاجة: الفريق والقنوات والعملاء',
  MANAGER: 'يدير العملاء ويوافق على البوستات',
  MODERATOR: 'يرد على رسايل العملاء المتعينين له بس',
  WRITER: 'يكتب بوستات وتستنى موافقة المدير'
};

/** True when the server runs in demo mode. */
export function useDemoAvailable() {
  const [on, setOn] = useState(false);
  useEffect(() => { api('/demo/info').then(() => setOn(true), () => setOn(false)); }, []);
  return on;
}

/** The "try it" card on the login page: pick a role and get a private sandbox agency. */
export function DemoStart() {
  const router = useRouter();
  const [role, setRole] = useState<Role>('OWNER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true); setError(null);
    try { await api('/demo/start', { body: { role } }); router.replace('/today'); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <section id="demo" aria-labelledby="demo-h" className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-faience/40 bg-faience/8 p-4">
      <h2 id="demo-h" className="flex items-center gap-2 font-display text-lg font-bold"><FlaskConical size={20} aria-hidden className="text-faience-ink" />جرّب دوسلي من غير حساب</h2>
      <p className="text-sm text-muted">هتدخل على وكالة تجريبية خاصة بيك فيها 4 عملاء ومحادثات وبوستات. محدش غيرك هيشوفها، وبتتمسح بعد 24 ساعة.</p>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-2 text-sm font-semibold">ادخل بصفتك</legend>
        {ROLES.map(r => (
          <label key={r} className={`flex cursor-pointer flex-col rounded-[var(--radius-md)] border p-2 text-sm ${role === r ? 'border-primary bg-surface' : 'border-line'}`}>
            <span className="flex items-center gap-2 font-semibold"><input type="radio" name="demo-role" value={r} checked={role === r} onChange={() => setRole(r)} />{ROLE_LABEL[r]}</span>
            <span className="text-xs text-muted">{ROLE_HINT[r]}</span>
          </label>
        ))}
      </fieldset>
      <ErrorText error={error} />
      <Button type="button" onClick={start} disabled={busy}>{busy ? 'بنجهّز الوكالة…' : 'ادخل الديمو'}</Button>
    </section>
  );
}

/** The strip across the top of every page in a demo sandbox. */
export function DemoBar({ me }: { me: Me }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [note, setNote] = useState<string | null>(null);
  // On a phone the tools fold behind one button, so the bar doesn't eat a third of the screen.
  const [open, setOpen] = useState(false);

  async function switchRole(role: Role) {
    await api('/demo/switch', { body: { role } });
    await mutate(() => true, undefined, { revalidate: true }); // every cached list depends on the role
  }
  async function newCustomer() {
    setNote(null);
    try { await api('/demo/inbound', { body: {} }); setNote('وصلت رسالة جديدة من عميل'); }
    catch (e) { setNote((e as Error).message); }
  }
  async function social(kind: 'comment' | 'message') {
    setNote(null);
    try { await api('/demo/social', { body: { kind } }); setNote(kind === 'comment' ? 'وصل كومنت جديد على بوست' : 'وصلت رسالة على ماسنجر أو إنستجرام'); }
    catch (e) { setNote((e as Error).message); }
  }
  async function newOrder() {
    setNote(null);
    try { await api('/demo/order', { body: {} }); setNote('وصل طلب جديد من المتجر، ورسالة التأكيد راحت للعميل على واتساب'); }
    catch (e) { setNote((e as Error).message); }
  }
  async function clientPays() {
    setNote(null);
    try { await api('/demo/client-pays', { method: 'POST' }); setNote('عميل قال إنه حوّل فلوس فاتورة. افتح الفواتير وأكد إن الفلوس وصلت'); }
    catch (e) { setNote((e as Error).message); }
  }
  async function openAdmin() { await api('/demo/admin', { method: 'POST' }); router.push('/admin'); }
  async function end() { await api('/demo/end', { method: 'POST' }); router.replace('/login'); }

  return (
    <div role="region" aria-label="أدوات الديمو" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-sun/60 bg-sun/15 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 font-semibold"><FlaskConical size={16} aria-hidden />ديمو: محدش حقيقي بيستلم أي رسالة أو بوست هنا</span>
      <button type="button" aria-expanded={open} aria-controls="demo-tools" onClick={() => setOpen(o => !o)} className="ms-auto flex h-9 items-center gap-1 rounded-[var(--radius-md)] border border-sun/60 px-3 font-semibold md:hidden">{open ? 'اخفي الأدوات' : 'أدوات الديمو'}</button>
      <div id="demo-tools" className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 md:contents', !open && 'max-md:hidden')}>
      <label className="flex items-center gap-2">
        <span className="whitespace-nowrap text-muted">شوف الشاشة بصفتك</span>
        <Select className="h-8 w-auto py-0 text-sm" value={me.role} onChange={e => switchRole(e.target.value as Role)}>
          {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
      </label>
      <Button size="sm" variant="ghost" onClick={newCustomer}><MessageSquarePlus size={16} aria-hidden />ابعت رسالة من عميل</Button>
      <Button size="sm" variant="ghost" onClick={() => social('comment')}><MessagesSquare size={16} aria-hidden />كومنت جديد</Button>
      <Button size="sm" variant="ghost" onClick={() => social('message')}><MessageCircle size={16} aria-hidden />رسالة ماسنجر/إنستجرام</Button>
      <Button size="sm" variant="ghost" onClick={newOrder}><ShoppingBag size={16} aria-hidden />طلب جديد من المتجر</Button>
      {(me.role === 'OWNER' || me.role === 'MANAGER') && <Button size="sm" variant="ghost" onClick={clientPays}><Receipt size={16} aria-hidden />عميل دفع فاتورة</Button>}
      <Button size="sm" variant="ghost" onClick={openAdmin}><Building2 size={16} aria-hidden />لوحة إدارة دوسلي</Button>
      <button onClick={end} className="ms-auto flex items-center gap-1 text-muted hover:text-ink"><X size={16} aria-hidden />إنهاء الديمو</button>
      </div>
      {note && <span role="status" className="text-muted">{note}</span>}
    </div>
  );
}
