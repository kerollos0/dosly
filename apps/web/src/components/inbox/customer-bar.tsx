'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { ChevronDown, NotebookPen, Plus, X } from 'lucide-react';
import { api, fetcher } from '@/lib/api';
import { customerSource, STAGES, type CustomerDetail, type Stage } from '@/lib/customers';
import { cx, ErrorText, Select, Textarea } from '@/components/ui';

type Patch = Partial<Pick<CustomerDetail, 'stage' | 'tags' | 'note'>>;

/**
 * Under the chat header: where this customer is (new → bought), where they came from, labels and a note.
 * The team moves them along while chatting; orders from the store move them too.
 * On a phone only the stage shows; labels and the note open behind «تفاصيل الزبون», so the chat keeps its room.
 */
export function CustomerBar({ contactId, canEdit }: { contactId: string; canEdit: boolean }) {
  const { data: c, error: loadErr, mutate } = useSWR<CustomerDetail>(`/customers/${contactId}`, fetcher as never);
  const [adding, setAdding] = useState(false);
  const [tag, setTag] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Only take the saved note while the box is closed, so a refresh never overwrites what someone is typing.
  useEffect(() => { if (!noteOpen) setNote(c?.note ?? ''); }, [c?.id, c?.note, noteOpen]);
  useEffect(() => { setAdding(false); setNoteOpen(false); setMore(false); setErr(null); setSaved(false); }, [contactId]);

  if (loadErr && !c) return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line bg-surface px-6 py-1 text-sm max-md:px-4">
      <span className="text-danger">مقدرناش نجيب بيانات الزبون.</span>
      <button type="button" onClick={() => void mutate()} className="min-h-11 px-2 font-semibold text-primary">جرّب تاني</button>
    </div>
  );
  if (!c) return <div aria-busy="true" className="h-[61px] border-b border-line bg-surface" />;

  async function save(body: Patch, failMsg: string) {
    setErr(null); setSaved(false);
    const before = c;
    await mutate(x => x && { ...x, ...body }, { revalidate: false });
    try {
      await api(`/customers/${contactId}`, { method: 'PATCH', body });
      if ('note' in body) setSaved(true);
      await mutate();
    } catch (e) {
      await mutate(before, { revalidate: false });
      setErr(`${failMsg} ${(e as Error).message || ''}`.trim());
    }
  }
  const addTag = () => { const t = tag.trim(); if (t && !c.tags.includes(t)) void save({ tags: [...c.tags, t] }, 'مقدرناش نحفظ العلامة. جرّب تاني.'); setTag(''); setAdding(false); };
  const suggestions = c.clientTags.filter(t => !c.tags.includes(t));
  const source = customerSource(c);

  return (
    <div className="flex flex-col gap-1 border-b border-line bg-surface px-6 py-2 max-md:px-4">
      <div className={cx('flex items-center gap-2 text-sm md:flex-wrap', more && 'max-md:flex-wrap')}>
        {canEdit ? (
          <>
            <label htmlFor="cb-stage" className="text-muted max-md:sr-only">المرحلة</label>
            <div className="w-36 max-md:w-28"><Select id="cb-stage" className="h-11" value={c.stage} onChange={e => void save({ stage: e.target.value as Stage }, 'مقدرناش نغيّر المرحلة. جرّب تاني.')}>
              {STAGES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
            </Select></div>
          </>
        ) : <span className="font-semibold">{STAGES.find(s => s.v === c.stage)?.label}</span>}
        <span className="min-w-0 max-w-full truncate text-muted max-md:flex-1 max-md:basis-0" title={source}>· {source}</span>
        <button type="button" aria-expanded={more} onClick={() => setMore(o => !o)} className="inline-flex h-11 shrink-0 items-center gap-1 px-1 font-semibold text-primary md:hidden">
          التفاصيل<ChevronDown size={14} aria-hidden className={cx('transition-transform', more && 'rotate-180')} />
        </button>
        <span className={cx('flex flex-wrap items-center gap-1 max-md:basis-full md:ms-auto', !more && 'max-md:hidden')}>
          {c.tags.map(t => (
            <span key={t} className="inline-flex min-h-11 items-center rounded-full bg-surface-2 ps-3 text-xs font-semibold">
              {t}
              {canEdit ? <button type="button" aria-label={`شيل علامة ${t}`} onClick={() => void save({ tags: c.tags.filter(x => x !== t) }, 'مقدرناش نشيل العلامة. جرّب تاني.')} className="grid size-11 place-items-center text-muted hover:text-danger"><X size={12} aria-hidden /></button> : <span className="pe-3" />}
            </span>
          ))}
          {canEdit && (adding ? (
            <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); addTag(); }}>
              <label htmlFor="cb-tag" className="sr-only">علامة جديدة</label>
              <input id="cb-tag" list="cb-tags" autoFocus maxLength={30} value={tag} onChange={e => setTag(e.target.value)} onBlur={() => (tag.trim() ? addTag() : setAdding(false))}
                placeholder="مثلًا: جملة، عميل دايم" className="h-11 w-40 rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm" />
              <datalist id="cb-tags">{suggestions.map(t => <option key={t} value={t} />)}</datalist>
            </form>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="inline-flex h-11 items-center gap-1 rounded-[var(--radius-md)] px-2 font-semibold text-primary hover:bg-surface-2"><Plus size={14} aria-hidden />علامة</button>
          ))}
          {canEdit && (
            <button type="button" aria-expanded={noteOpen} onClick={() => { setNoteOpen(o => !o); setSaved(false); }} className="inline-flex h-11 items-center gap-1 rounded-[var(--radius-md)] px-2 font-semibold text-primary hover:bg-surface-2">
              <NotebookPen size={14} aria-hidden />{c.note ? 'الملاحظة' : 'ملاحظة'}
            </button>
          )}
        </span>
      </div>
      {!noteOpen && c.note && <p className={cx('text-sm text-muted', !more && 'max-md:hidden')} dir="auto"><span className="font-semibold">ملاحظة:</span> {c.note}</p>}
      {noteOpen && (
        <div className="flex flex-col gap-1">
          <label htmlFor="cb-note" className="sr-only">ملاحظة عن الزبون</label>
          <Textarea id="cb-note" rows={2} maxLength={2000} value={note} onChange={e => { setNote(e.target.value); setSaved(false); }} placeholder="أي حاجة الفريق لازم يعرفها عن الزبون ده (مقاسه، عنوانه، بيحب إيه)"
            onBlur={() => { if (note.trim() !== (c.note ?? '')) void save({ note: note.trim() || null }, 'مقدرناش نحفظ الملاحظة، اللي كتبته لسه موجود. جرّب تاني.'); }} />
          <p className="text-xs text-muted">بتتحفظ لوحدها أول ما تسيب الخانة. الزبون مش بيشوفها. <span role="status" className="font-semibold text-success">{saved ? 'اتحفظت ✓' : ''}</span></p>
        </div>
      )}
      <ErrorText error={err} />
    </div>
  );
}
