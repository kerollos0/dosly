'use client';
import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { ShoppingBag, X } from 'lucide-react';
import { fetcher } from '@/lib/api';
import type { Order } from '@/lib/orders';
import { OrderCard } from '@/components/orders';

type Res = { hasStore: boolean; items: Order[] };

/**
 * The customer's store orders beside the chat: status, items, shipping. A side column on wide
 * screens; a button in the chat header opens it as a sheet on smaller ones. Hidden when the
 * client has no store connected.
 */
export function useCustomerOrders(conversationId: string, enabled: boolean) {
  return useSWR<Res>(enabled ? `/conversations/${conversationId}/orders` : null, fetcher as never);
}

export function OrdersButton({ data, onOpen }: { data?: Res; onOpen: () => void }) {
  if (!data?.hasStore) return null;
  return (
    <button type="button" onClick={onOpen} className="flex h-9 items-center gap-1 rounded-[var(--radius-md)] border border-line px-3 text-sm font-semibold hover:bg-surface-2 2xl:hidden">
      <ShoppingBag size={16} aria-hidden />الطلبات{data.items.length ? <span className="num">({data.items.length})</span> : null}
    </button>
  );
}

function List({ data }: { data: Res }) {
  if (!data.items.length) return <p className="text-sm text-muted">العميل ده ملوش طلبات في المتجر لسه.</p>;
  return <ul className="flex flex-col gap-2">{data.items.map(o => <li key={o.id}><OrderCard o={o} compact /></li>)}</ul>;
}

export function OrdersPanel({ data, open, onClose }: { data?: Res; open: boolean; onClose: () => void }) {
  // The sheet takes focus while open and hands it back to whatever opened it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); opener?.focus(); };
  }, [open]);
  if (!data?.hasStore) return null;
  return (
    <>
      <aside aria-labelledby="cust-orders-h" className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-s border-line bg-surface p-4 max-2xl:hidden">
        <h2 id="cust-orders-h" className="flex items-center gap-2 font-semibold"><ShoppingBag size={18} aria-hidden />طلبات العميل</h2>
        <List data={data} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30 2xl:hidden" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
          <div role="dialog" aria-modal="true" aria-label="طلبات العميل" className="flex h-full w-[min(24rem,100%)] flex-col gap-3 overflow-y-auto bg-surface p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-semibold"><ShoppingBag size={18} aria-hidden />طلبات العميل</h2>
              <button type="button" onClick={onClose} autoFocus aria-label="إغلاق" className="rounded p-1 text-muted hover:bg-surface-2"><X size={18} aria-hidden /></button>
            </div>
            <List data={data} />
          </div>
        </div>
      )}
    </>
  );
}
