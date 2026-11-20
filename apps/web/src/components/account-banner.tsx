'use client';
import { api, type Me } from '@/lib/api';

/** Tells the agency, in one line, when its account is limited and why. Nothing shows on a healthy account. */
export function AccountBanner({ me }: { me: Me }) {
  const daysLeft = me.agency.trialEndsAt ? Math.ceil((new Date(me.agency.trialEndsAt).getTime() - Date.now()) / 86400_000) : null;
  let text: string | null = null;
  let tone = 'border-sun/60 bg-sun/15';
  if (me.readOnly === 'support') { text = 'إنت داخل كدعم فني من دوسلي. للعرض بس، والدخول ده متسجل في سجل نشاط الوكالة.'; tone = 'border-faience/50 bg-faience/12'; }
  else if (me.readOnly === 'suspended') { text = `الحساب موقوف مؤقتًا${me.agency.suspendedReason ? `: ${me.agency.suspendedReason}` : ''}. تقدر تشوف كل حاجة، بس الرد والنشر واقفين لحد ما تكلّمنا.`; tone = 'border-danger/40 bg-danger/10'; }
  else if (me.readOnly === 'trial_ended') { text = 'التجربة المجانية خلصت. بياناتك كلها محفوظة، واشترك عشان ترجع ترد وتنشر.'; tone = 'border-danger/40 bg-danger/10'; }
  else if (me.readOnly === 'unpaid') { text = 'الاشتراك خلص. بياناتك محفوظة، وجدّد عشان ترجع ترد وتنشر.'; tone = 'border-danger/40 bg-danger/10'; }
  else if (!me.demo && me.agency.plan === 'TRIAL' && daysLeft !== null && daysLeft <= 7) text = `فاضل ${daysLeft} ${daysLeft >= 3 && daysLeft <= 10 ? 'أيام' : 'يوم'} في التجربة المجانية.`;
  if (!text) return null;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm font-semibold ${tone}`}>
      <span>{text}</span>
      {me.readOnly === 'support' && <button className="text-faience-ink underline" onClick={async () => { await api('/auth/logout', { method: 'POST' }); window.location.href = '/admin'; }}>اخرج وارجع للإدارة</button>}
    </div>
  );
}
