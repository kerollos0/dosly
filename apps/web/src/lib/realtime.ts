'use client';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useSWRConfig } from 'swr';

type Event = { type: string; conversationId?: string; postId?: string };

/** One socket per tab. Events only invalidate cached data; SWR refetches what is on screen. */
export function useRealtime(enabled: boolean) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!enabled) return;
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['polling', 'websocket'] }); // polling first works through any proxy, then upgrades
    socket.on('event', (e: Event) => {
      if (e.type.startsWith('message') || e.type.startsWith('conversation')) {
        void mutate(k => typeof k === 'string' && (k.startsWith('/conversations') || k === '/clients'));
      }
      if (e.type.startsWith('post')) void mutate(k => typeof k === 'string' && k.startsWith('/posts'));
    });
    return () => { socket.disconnect(); };
  }, [enabled, mutate]);
}
