'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { RefreshCw } from 'lucide-react';
import { api, fetcher, type Template, type TemplateField } from '@/lib/api';
import { Button, ErrorText, Input, Modal, Pill, cx } from '@/components/ui';
import { uploadWithProgress } from './upload';

const CATEGORY: Record<string, string> = { MARKETING: 'تسويقية', UTILITY: 'خدمية', AUTHENTICATION: 'كود تأكيد' };
const STATUS: Record<string, string> = { APPROVED: 'متوافق عليها', PENDING: 'في مراجعة Meta', REJECTED: 'مرفوضة', PAUSED: 'متوقفة مؤقتًا', DISABLED: 'متوقفة', ARCHIVED: 'متأرشفة', LOCKED: 'مقفولة', LIMIT_EXCEEDED: 'عدّت الحد' };
const HEADER_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt' } as const;
const HEADER_LABEL = { IMAGE: 'الصورة اللي في أول الرسالة', VIDEO: 'الفيديو اللي في أول الرسالة', DOCUMENT: 'الملف اللي في أول الرسالة' } as const;

function fieldLabel(f: TemplateField, t: Template) {
  const name = /^\d+$/.test(f.key) ? `{{${f.key}}}` : f.key.replace(/_/g, ' ');
  if (f.part === 'header') return `${name} في العنوان`;
  if (f.part === 'button') return `آخر رابط زرار «${t.shape.buttons[f.buttonIndex ?? 0]?.text ?? ''}»`;
  return name;
}
const fill = (text: string | undefined, values: Record<string, string>, prefix: string) =>
  (text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (all, k: string) => values[`${prefix}.${k}`]?.trim() || all);
const badParam = (v: string) => /[\n\t]/.test(v) || / {5,}/.test(v);

/** Approved WhatsApp templates for this conversation's number: pick one, fill its variables, see it, send it. */
export function TemplatePicker({ conversationId, open, onClose, onSent }: { conversationId: string; open: boolean; onClose: () => void; onSent: () => void }) {
  const { data, mutate } = useSWR<{ items: Template[]; syncedAt: string | null; windowOpen: boolean }>(open ? `/conversations/${conversationId}/templates` : null, fetcher as never);
  const [picked, setPicked] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const t = data?.items.find(x => x.id === picked) ?? null;
  const filePreview = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);

  const ready = t && t.shape.fields.every(f => values[f.id]?.trim() && !badParam(values[f.id]!)) && (!t.shape.headerMedia || file);

  function choose(id: string) { setPicked(id); setValues({}); setFile(null); setError(null); }
  async function sync() {
    setSyncing(true);
    try { await api(`/conversations/${conversationId}/templates/sync`, { method: 'POST' }); setTimeout(() => void mutate(), 1500); }
    catch (e) { setError((e as Error).message); } finally { setTimeout(() => setSyncing(false), 1500); }
  }
  async function send() {
    if (!t || !ready) return;
    setBusy(true); setError(null); setProgress(0);
    try {
      if (t.shape.headerMedia && file) {
        const form = new FormData();
        form.set('data', JSON.stringify({ templateId: t.id, values })); // fields must come before the file
        form.set('header', file);
        await uploadWithProgress(`/conversations/${conversationId}/template`, form, setProgress);
      } else {
        await api(`/conversations/${conversationId}/template`, { body: { templateId: t.id, values } });
      }
      onSent(); onClose(); setPicked(null); setValues({}); setFile(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="رسالة Template">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          {data?.windowOpen === false ? 'عدّى أكتر من 24 ساعة على آخر رسالة من العميل، فواتساب بيسمح بس بقوالب متوافق عليها. لما العميل يرد هتقدر تكلمه عادي.' : 'القوالب المتوافق عليها من Meta تقدر تبعتها في أي وقت.'}
          {' '}Meta بتحاسب على كل رسالة Template حسب نوعها.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{data?.syncedAt ? `آخر تحديث من Meta: ${new Date(data.syncedAt).toLocaleString('ar-EG-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span>
          <Button size="sm" variant="ghost" type="button" onClick={sync} disabled={syncing}><RefreshCw size={14} className={cx(syncing && 'animate-spin')} aria-hidden />حدّث القوالب</Button>
        </div>
        {!data ? <p className="text-muted">بيحمّل…</p> : data.items.length === 0 ? <p className="text-muted">مفيش قوالب على الرقم ده. اعملها من WhatsApp Manager وبعدين دوس «حدّث القوالب».</p> : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" role="listbox" aria-label="القوالب">
            {data.items.map(x => {
              const usable = x.status === 'APPROVED';
              return (
                <li key={x.id}>
                  <button type="button" role="option" aria-selected={picked === x.id} disabled={!usable} onClick={() => choose(x.id)}
                    className={cx('flex w-full flex-col gap-1 rounded-[var(--radius-md)] border px-3 py-2 text-start', picked === x.id ? 'border-primary bg-primary/8' : 'border-line hover:bg-surface-2', !usable && 'cursor-not-allowed opacity-60')}>
                    <span className="flex flex-wrap items-center gap-2">
                      <bdi className="font-semibold" dir="ltr">{x.name}</bdi>
                      <Pill tone={x.category === 'MARKETING' ? 'sun' : 'neutral'}>{CATEGORY[x.category] ?? x.category}</Pill>
                      {!usable && <Pill tone="bad">{STATUS[x.status] ?? x.status}</Pill>}
                    </span>
                    <span className="line-clamp-2 text-sm text-muted">{x.shape.body}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {t && (
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            {t.shape.headerMedia && (
              <label className="flex flex-col gap-1 text-sm font-semibold">{HEADER_LABEL[t.shape.headerMedia]}
                <input type="file" accept={HEADER_ACCEPT[t.shape.headerMedia]} onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-sm font-normal" />
              </label>
            )}
            {t.shape.fields.map(f => (
              <label key={f.id} className="flex flex-col gap-1 text-sm font-semibold">
                {fieldLabel(f, t)}
                <Input value={values[f.id] ?? ''} maxLength={f.part === 'button' ? 200 : 1024} dir="auto"
                  onChange={e => setValues(v => ({ ...v, [f.id]: e.target.value }))} aria-invalid={!!values[f.id] && badParam(values[f.id]!)} />
                {values[f.id] && badParam(values[f.id]!) && <span className="text-xs font-normal text-danger">واتساب مش بيقبل سطر جديد أو أكتر من 4 مسافات ورا بعض هنا.</span>}
              </label>
            ))}
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-muted">العميل هيشوفها كده:</figcaption>
              <div className="max-w-[85%] self-end rounded-[var(--radius-md)] bg-primary px-3 py-2 text-on-primary">
                {filePreview && <img src={filePreview} alt="" className="mb-2 max-h-40 rounded-[var(--radius-sm)]" />}
                {t.shape.headerMedia && !filePreview && <p className="mb-1 text-xs opacity-80">[{file ? file.name : HEADER_LABEL[t.shape.headerMedia]}]</p>}
                {t.shape.headerText && <p className="font-semibold">{fill(t.shape.headerText, values, 'header')}</p>}
                <p className="whitespace-pre-wrap">{fill(t.shape.body, values, 'body')}</p>
                {t.shape.footer && <p className="mt-1 text-xs opacity-80">{t.shape.footer}</p>}
                {t.shape.buttons.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{t.shape.buttons.map((b, i) => <span key={i} className="rounded-full border border-current/40 px-2 py-0.5 text-xs">{b.text}</span>)}</div>}
              </div>
            </figure>
          </div>
        )}
        <ErrorText error={error} />
        <div className="flex items-center justify-end gap-2">
          {busy && progress > 0 && progress < 1 && <span className="num text-sm text-muted">{Math.round(progress * 100)}%</span>}
          <Button variant="ghost" type="button" onClick={onClose}>إلغاء</Button>
          <Button type="button" onClick={send} disabled={!ready || busy}>{busy ? 'بيتبعت…' : 'ابعت'}</Button>
        </div>
      </div>
    </Modal>
  );
}
