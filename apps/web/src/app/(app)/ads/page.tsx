'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { AlertTriangle, BellOff, CircleSlash, PauseCircle, RefreshCw, Wallet } from 'lucide-react';
import { api, fetcher, type Client } from '@/lib/api';
import { ACCOUNT_STATUS, alertText, CURRENCY_NAME, type AdAccount, type AdAlert, type AdAlertKind, type AdsOverview } from '@/lib/ads';
import { AdKpis, CampaignTable, SpendBars, type AccountState } from '@/components/ads';
import { Button, Empty, ErrorText, PageHeader, Select, cx } from '@/components/ui';

const RANGES = [{ days: 7, label: 'آخر أسبوع' }, { days: 30, label: 'آخر شهر' }, { days: 90, label: 'آخر 3 شهور' }];
const ALERT_ICON: Record<AdAlertKind, typeof AlertTriangle> = {
  ACCOUNT_PROBLEM: CircleSlash, SPEND_CAP_NEAR: Wallet, CAMPAIGN_ISSUES: AlertTriangle, CAMPAIGN_STOPPED: PauseCircle, BUDGET_LOW: Wallet
};

/** "من 5 دقايق", "من ساعتين", "من 3 أيام": Egyptian counting, 3 to 10 take the plural. */
function since(iso: string | null) {
  if (!iso) return null;
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  const say = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : `${n} ${n >= 3 && n <= 10 ? few : many}`);
  if (min < 1) return 'دلوقتي';
  if (min < 60) return `من ${say(min, 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة')}`;
  const h = Math.round(min / 60);
  if (h < 24) return `من ${say(h, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
  const d = Math.round(h / 24);
  return `من ${say(d, 'يوم', 'يومين', 'أيام', 'يوم')}`;
}

export default function AdsPage() {
  const [clientId, setClientId] = useState('');
  const [days, setDays] = useState(30);
  const q = `days=${days}${clientId ? `&clientId=${clientId}` : ''}`;
  const { mutate: mutateAny } = useSWRConfig();
  const { data: clients } = useSWR<Client[]>('/clients', fetcher as never);
  const { data, error, mutate } = useSWR<AdsOverview>(`/ads/overview?${q}`, fetcher as never, { keepPreviousData: true });
  const { data: alerts } = useSWR<{ items: AdAlert[] }>(`/ads/alerts${clientId ? `?clientId=${clientId}` : ''}`, fetcher as never);
  const { data: accounts, mutate: mutateAccounts } = useSWR<AdAccount[]>('/ads/accounts', fetcher as never);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const clientName = (id: string) => clients?.find(c => c.id === id)?.name ?? '';
  const accountState = (id: string): AccountState => {
    const a = accounts?.find(x => x.id === id);
    if (!a) return null;
    if (a.accountStatus !== 1) return { label: `واقفة: ${ACCOUNT_STATUS[a.accountStatus] ?? 'مشكلة في الحساب'}`, tone: 'bad' };
    if (a.status === 'ERROR') return { label: '', tone: 'neutral', stale: true }; // our link broke; the campaign itself may still run
    return null;
  };
  // Every alerts list, including the sidebar badge, is refreshed together.
  const refreshAlerts = () => mutateAny(k => typeof k === 'string' && k.startsWith('/ads/alerts'));

  async function syncNow() {
    setActionError(null);
    const list = (accounts ?? []).filter(a => a.status === 'CONNECTED' && (!clientId || a.clientId === clientId));
    if (!list.length) { setActionError('مفيش حساب إعلاني شغال نحدّثه. راجع صفحة القنوات.'); return; }
    setSyncing(true); setNotice('بنجيب الأرقام الجديدة من ميتا…');
    const results = await Promise.allSettled(list.map(a => api(`/ads/accounts/${a.id}/sync`, { method: 'POST' })));
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) setActionError((failed.reason as Error).message);
    // The worker reads Meta in the background; its realtime event refreshes the page too.
    timer.current = setTimeout(() => { void mutate(); void refreshAlerts(); void mutateAccounts(); setSyncing(false); setNotice(null); }, 3000);
  }
  async function dismiss(id: string) {
    setActionError(null);
    try { await api(`/ads/alerts/${id}/dismiss`, { method: 'POST' }); await refreshAlerts(); }
    catch (e) { setActionError((e as Error).message); }
  }

  const noAccounts = accounts && accounts.length === 0;
  const clientHasNoAccount = !!clientId && !!accounts && !accounts.some(a => a.clientId === clientId);
  const updated = since(data?.syncedAt ?? null);
  return (
    <>
      <PageHeader title="الإعلانات" sub="صرف ونتايج حملات فيسبوك وإنستجرام لكل عميل. الأرقام بتتحدث من ميتا كل ربع ساعة تقريبًا."
        action={!noAccounts && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ads-client" className="sr-only">العميل</label>
            <Select id="ads-client" value={clientId} onChange={e => setClientId(e.target.value)} className="w-52">
              <option value="">كل العملاء</option>
              {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <div role="group" aria-label="الفترة" className="flex rounded-[var(--radius-md)] border border-line p-0.5">
              {RANGES.map(r => (
                <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)}
                  className={cx('h-9 rounded-[calc(var(--radius-md)-2px)] px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary', days === r.days ? 'bg-primary text-on-primary' : 'text-muted hover:text-ink')}>{r.label}</button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={syncNow} disabled={syncing} className="h-9">
              <RefreshCw size={16} aria-hidden className={syncing ? 'animate-spin' : ''} />حدّث الأرقام
            </Button>
          </div>
        )} />

      {noAccounts ? (
        <Empty title="لسه مفيش حسابات إعلانية">
          اربط الحساب الإعلاني بتاع كل عميل من <Link href="/channels" className="font-semibold text-primary underline">صفحة القنوات</Link>، وهنجيب الصرف والنتايج لوحدنا كل ربع ساعة.
        </Empty>
      ) : (
        <div className="flex flex-col gap-6 p-8 max-md:p-4">
          <p role="status" className={cx('text-sm text-muted', !notice && 'sr-only')}>{notice}</p>
          <ErrorText error={actionError} />
          {!!alerts?.items.length && (
            <section aria-labelledby="ads-alerts-h" className="flex flex-col gap-2">
              <h2 id="ads-alerts-h" className="font-display text-[20px] font-semibold">محتاج انتباهك</h2>
              <ul className="flex flex-col gap-2">
                {alerts.items.map(a => {
                  const t = alertText(a);
                  const Icon = ALERT_ICON[a.kind];
                  const severe = a.kind === 'ACCOUNT_PROBLEM' || a.kind === 'CAMPAIGN_ISSUES';
                  return (
                    <li key={a.id} className={cx('flex flex-wrap items-start gap-3 rounded-[var(--radius-md)] border p-3', severe ? 'border-danger/40 bg-danger/5' : 'border-warning/40 bg-warning/5')}>
                      <Icon size={20} aria-hidden className={cx('mt-0.5 shrink-0', severe ? 'text-danger' : 'text-warning')} />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{t.title}</p>
                        <p className="text-sm text-muted">{t.body}</p>
                        <p className="mt-1 text-xs text-muted">{[clientId ? null : clientName(a.clientId), since(a.openedAt)].filter(Boolean).join(' · ')}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => dismiss(a.id)} aria-label={`اقفل التنبيه: ${t.title}`} title="هيرجع تاني لو المشكلة اتكررت">
                        <BellOff size={14} aria-hidden />اقفل التنبيه
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {clientHasNoAccount ? (
            <p className="rounded-[var(--radius-md)] border border-line p-4 text-muted">
              العميل ده ملوش حساب إعلاني مربوط. <Link href="/channels" className="font-semibold text-primary underline">اربطه من صفحة القنوات</Link>.
            </p>
          ) : error && !data ? (
            <ErrorText error="مش قادرين نجيب أرقام الإعلانات دلوقتي. جرّب تاني بعد شوية." />
          ) : !data ? (
            <p role="status" className="text-muted">بيحمّل…</p>
          ) : (
            <>
              {data.currencies.length === 0 && <p className="text-muted">مفيش صرف في الفترة دي.</p>}
              {data.currencies.map(b => (
                <section key={b.currency} aria-label={`الحسابات ${CURRENCY_NAME[b.currency] ?? b.currency}`} className="flex flex-col gap-3">
                  {data.currencies.length > 1 && <h2 className="font-display text-[20px] font-semibold">الحسابات {CURRENCY_NAME[b.currency] ?? <span dir="ltr">{b.currency}</span>}</h2>}
                  <AdKpis block={b} />
                  <SpendBars block={b} />
                </section>
              ))}
              {data.campaigns.length > 0 && (
                <section aria-labelledby="ads-camp-h" className="flex flex-col gap-3">
                  <h2 id="ads-camp-h" className="font-display text-[20px] font-semibold">الحملات</h2>
                  <CampaignTable rows={data.campaigns} clientName={clientId ? undefined : clientName} accountState={accountState} />
                </section>
              )}
              <p className="text-xs text-muted">
                {updated ? `آخر تحديث ${updated}.` : 'لسه ماجبناش أرقام من ميتا.'} أرقام آخر 4 أسابيع ممكن تتغير شوية، لأن ميتا بتحسب بعض النتايج متأخر.
                {data.accountsWithErrors > 0 && <> {data.accountsWithErrors === 1 ? 'فيه حساب الربط بتاعه وقف' : `فيه ${data.accountsWithErrors} حسابات الربط بتاعها وقف`}، <Link href="/channels" className="font-semibold text-primary underline">اربطه تاني</Link>.</>}
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
