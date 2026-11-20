'use client';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useSWRConfig } from 'swr';

export type RealtimeEvent = { type: string; conversationId?: string; postId?: string; messageId?: string; direction?: 'IN' | 'OUT'; clientId?: string; waNumberId?: string };

/** One socket per tab. Events only invalidate cached data; SWR refetches what is on screen. */
export function useRealtime(enabled: boolean) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!enabled) return;
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['polling', 'websocket'] }); // polling first works through any proxy, then upgrades
    socket.on('event', (e: RealtimeEvent) => {
      // Other parts of the app (notifications) listen without opening a second socket.
      window.dispatchEvent(new CustomEvent<RealtimeEvent>('dosly:event', { detail: e }));
      if (e.type.startsWith('message') || e.type.startsWith('conversation')) {
        void mutate(k => typeof k === 'string' && (k.startsWith('/conversations') || k === '/clients'));
      }
      if (e.type === 'templates.updated') void mutate(k => typeof k === 'string' && k.endsWith('/templates'));
      if (e.type.startsWith('comment')) void mutate(k => typeof k === 'string' && k.includes('/comments')); // includes the paged list's $inf$ key
      if (e.type.startsWith('ads.')) void mutate(k => typeof k === 'string' && k.startsWith('/ads'));
      if (e.type.startsWith('post')) void mutate(k => typeof k === 'string' && k.startsWith('/posts'));
    });
    return () => { socket.disconnect(); };
  }, [enabled, mutate]);
}
