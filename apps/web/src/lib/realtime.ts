'use client';
import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { useSWRConfig } from 'swr';

export type RealtimeEvent = { type: string; conversationId?: string; postId?: string; messageId?: string; direction?: 'IN' | 'OUT'; clientId?: string; waNumberId?: string };

/**
 * SWR's filtered mutate skips useSWRInfinite keys, so a paged list asks to be refreshed itself
 * when an event of its kind arrives (a burst refreshes once).
 */
export function useLiveRefresh(prefix: string, refresh: () => unknown) {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      if (!(e as CustomEvent<RealtimeEvent>).detail?.type.startsWith(prefix) || t) return;
      t = setTimeout(() => { t = undefined; void ref.current(); }, 1000);
    };
    window.addEventListener('dosly:event', on);
    return () => { clearTimeout(t); window.removeEventListener('dosly:event', on); };
  }, [prefix]);
}

/** One socket per tab. Events only invalidate cached data; SWR refetches what is on screen. */
export function useRealtime(enabled: boolean) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!enabled) return;
    let todayTimer: ReturnType<typeof setTimeout> | undefined;
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['polling', 'websocket'] }); // polling first works through any proxy, then upgrades
    socket.on('event', (e: RealtimeEvent) => {
      // Other parts of the app (notifications) listen without opening a second socket.
      window.dispatchEvent(new CustomEvent<RealtimeEvent>('dosly:event', { detail: e }));
      if (e.type.startsWith('message') || e.type.startsWith('conversation')) {
        void mutate(k => typeof k === 'string' && (k.startsWith('/conversations') || k === '/clients'));
      }
      if (e.type === 'templates.updated') void mutate(k => typeof k === 'string' && k.endsWith('/templates'));
      if (e.type.startsWith('comment')) void mutate(k => typeof k === 'string' && k.includes('/comments')); // paged lists refresh through useLiveRefresh
      if (e.type.startsWith('ads.')) void mutate(k => typeof k === 'string' && k.startsWith('/ads'));
      if (e.type.startsWith('post')) void mutate(k => typeof k === 'string' && k.startsWith('/posts'));
      // Orders: the orders page (and its paged list), the panel beside a chat, and sales on the ads page.
      if (e.type.startsWith('order.')) void mutate(k => typeof k === 'string' && (k.includes('/orders') || k.startsWith('/ads/overview')));
      if (e.type.startsWith('invoice.')) void mutate(k => typeof k === 'string' && k.startsWith('/billing'));
      // The "today" screen counts these. Delivery receipts don't change it, and a burst refreshes once.
      if (/^(message\.new|conversation\.|comment\.|ads\.alert|post\.|order\.|invoice\.)/.test(e.type) && !todayTimer) {
        todayTimer = setTimeout(() => { todayTimer = undefined; void mutate('/today'); }, 2000);
      }
    });
    return () => { clearTimeout(todayTimer); socket.disconnect(); };
  }, [enabled, mutate]);
}
