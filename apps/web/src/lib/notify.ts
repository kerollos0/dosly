'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { RealtimeEvent } from './realtime';

/**
 * New-message alerts for the inbox: a short chime and a desktop notification when the message
 * is for me (assigned to me, or to nobody yet) and I am not already looking at that conversation.
 * The server decides who may see a conversation, so an event for a client I cannot see is dropped.
 */
type Prefs = { sound: boolean; desktop: boolean };
const KEY = 'dosly:notify';
const read = (): Prefs => { try { return { sound: true, desktop: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { sound: true, desktop: true }; } };
const write = (p: Prefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };

/** The conversation open on screen, so its own messages do not ring. */
let openConversation: string | null = null;
export const setOpenConversation = (id: string | null) => { openConversation = id; };

let ctx: AudioContext | null = null;
/** Browsers only allow sound after the person has interacted with the page, so the context is made on first click. */
function unlockAudio() { if (!ctx && typeof AudioContext !== 'undefined') ctx = new AudioContext(); void ctx?.resume(); }
function chime() {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const [i, f] of [880, 1320].entries()) { // two soft notes, no audio file to download
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + i * 0.12);
    g.gain.linearRampToValueAtTime(0.15, t0 + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.12 + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.4);
  }
}

/** Mounted once, in the app layout, so alerts work on every page. */
export function useNotifications(meId: string | undefined) {
  const [missed, setMissed] = useState(0);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
  }, []);

  // Unread count in the tab title and the installed-app badge while the tab is in the background.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = missed ? `(${missed}) ${base}` : base;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (missed ? nav.setAppBadge?.(missed) : nav.clearAppBadge?.())?.catch(() => {});
  }, [missed]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setMissed(0); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!meId) return;
    const onEvent = async (ev: Event) => {
      const e = (ev as CustomEvent<RealtimeEvent>).detail;
      if (e.type !== 'message.new' || e.direction !== 'IN' || !e.conversationId) return;
      if (e.conversationId === openConversation && !document.hidden) return;
      let c: { id: string; assigneeId: string | null; client: { name: string } | null; contact: { name: string | null; waId: string | null; username?: string | null }; lastPreview: string | null };
      try { c = await api(`/conversations/${e.conversationId}`); } catch { return; } // not mine to see
      if (c.assigneeId && c.assigneeId !== meId) return;
      const p = read();
      if (p.sound) chime();
      if (document.hidden) setMissed(n => n + 1);
      if (p.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        const n = new Notification(`${c.contact.name ?? (c.contact.waId ? '+' + c.contact.waId : c.contact.username ?? 'عميل')} · ${c.client?.name ?? ''}`, {
          body: c.lastPreview ?? 'رسالة جديدة', tag: `conv-${c.id}`, icon: '/dosly-mark.svg', lang: 'ar', dir: 'rtl'
        });
        n.onclick = () => { window.focus(); window.location.href = `/inbox?c=${c.id}`; n.close(); };
      }
    };
    window.addEventListener('dosly:event', onEvent);
    return () => window.removeEventListener('dosly:event', onEvent);
  }, [meId]);

}

/** The on/off switches shown in the inbox. */
export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<Prefs>({ sound: true, desktop: true });
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  useEffect(() => {
    setPrefs(read());
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, []);

  const enableDesktop = useCallback(async () => {
    unlockAudio();
    if (typeof Notification === 'undefined') return;
    const res = await Notification.requestPermission();
    setPermission(res);
    const next = { ...read(), desktop: res === 'granted' };
    write(next); setPrefs(next);
  }, []);
  const toggleSound = useCallback(() => { unlockAudio(); const next = { ...read(), sound: !read().sound }; write(next); setPrefs(next); }, []);

  return { prefs, permission, enableDesktop, toggleSound };
}
