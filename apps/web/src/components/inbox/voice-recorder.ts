'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Containers each browser records Opus or AAC into; the server re-encodes to WhatsApp's OGG/OPUS mono. */
const TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
export const MAX_VOICE_SEC = 10 * 60;

export type Recorder = {
  state: 'idle' | 'recording' | 'denied' | 'unsupported';
  seconds: number;
  level: number; // 0..1, for a simple input meter
  start(): Promise<void>;
  stop(): Promise<Blob | null>;
  cancel(): void;
};

export function useVoiceRecorder(): Recorder {
  const [state, setState] = useState<Recorder['state']>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number; raf: number; ctx: AudioContext } | null>(null);

  const cleanup = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer); cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach(t => t.stop()); // releases the microphone light
    void r.ctx.close();
    rec.current = null;
    setSeconds(0); setLevel(0);
  }, []);
  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => new Promise<Blob | null>(resolve => {
    const r = rec.current;
    if (!r) return resolve(null);
    r.mr.onstop = () => {
      const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
      cleanup(); setState('idle');
      resolve(blob.size > 0 ? blob : null);
    };
    r.mr.stop();
  }), [cleanup]);

  const start = useCallback(async () => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) { setState('unsupported'); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch { setState('denied'); return; }
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mr.start(1000); // a chunk per second, so a long note is not one huge buffer at the end
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(Math.min(1, peak / 64));
      if (rec.current) rec.current.raf = requestAnimationFrame(tick);
    };
    const began = Date.now();
    const timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSeconds(s);
      if (s >= MAX_VOICE_SEC) void stop();
    }, 250);
    rec.current = { mr, stream, chunks, timer, raf: requestAnimationFrame(tick), ctx };
    setState('recording');
  }, [stop]);

  const cancel = useCallback(() => {
    const r = rec.current;
    if (r) { r.mr.onstop = null; if (r.mr.state !== 'inactive') r.mr.stop(); }
    cleanup(); setState('idle');
  }, [cleanup]);

  return { state, seconds, level, start, stop, cancel };
}
