import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Private media: customer photos, voice notes and documents. Unlike post images these are never
 * served by the web server directly; the API streams them after checking who is asking.
 * Local disk today; an S3/R2 driver can implement the same interface later.
 */
export interface MediaStore {
  /** Moves (or copies) a local file, or writes a buffer, under `key`. Returns the stored size. */
  put(key: string, src: string | Buffer): Promise<number>;
  stat(key: string): Promise<{ size: number } | null>;
  read(key: string, range?: { start: number; end: number }): Readable;
  /** A path on local disk, for tools like ffmpeg and sharp. */
  localPath(key: string): string;
  remove(key: string): Promise<void>;
  /** Removes every file under a folder-like prefix, e.g. `wa/<agencyId>`. */
  removePrefix(prefix: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,250}$/;

export function localMediaStore(root: string): MediaStore {
  const base = resolve(root);
  const full = (key: string) => {
    if (!KEY.test(key) || key.includes('..')) throw new Error(`Bad media key: ${key}`);
    const p = resolve(base, key);
    if (!p.startsWith(base + sep)) throw new Error(`Media key escapes the store: ${key}`);
    return p;
  };
  return {
    async put(key, src) {
      const dest = full(key);
      await mkdir(dirname(dest), { recursive: true });
      if (Buffer.isBuffer(src)) { await writeFile(dest, src); return src.length; }
      // rename is atomic on one filesystem; temp files may live on another one, so fall back to copy.
      await rename(src, dest).catch(async () => { await copyFile(src, dest); await rm(src, { force: true }); });
      return (await stat(dest)).size;
    },
    async stat(key) {
      try { return { size: (await stat(full(key))).size }; } catch { return null; }
    },
    read(key, range) {
      return createReadStream(full(key), range);
    },
    localPath: full,
    async remove(key) { await rm(full(key), { force: true }); },
    async removePrefix(prefix) { await rm(full(prefix), { recursive: true, force: true }); }
  };
}

/** wa/<agency>/<yyyy>/<mm>/<message>.<ext>: grouped by agency so one agency's files can be removed together. */
export function mediaKey(agencyId: string, messageId: string, ext: string, suffix = '') {
  const d = new Date();
  return join('wa', agencyId, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), `${messageId}${suffix}.${ext}`).split(sep).join('/');
}
