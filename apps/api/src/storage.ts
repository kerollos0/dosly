import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomToken } from '@dosly/shared';

/** One interface for media storage. Local disk now (served by Caddy at /media); an S3/R2 driver can replace it later. */
export interface Storage {
  save(bytes: Buffer, ext: string): Promise<string>; // returns a public URL
}

export function localStorage(dir: string, publicUrl: string): Storage {
  return {
    async save(bytes, ext) {
      const now = new Date();
      const sub = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      await mkdir(join(dir, sub), { recursive: true });
      const name = `${sub}/${randomToken(16)}.${ext}`;
      await writeFile(join(dir, name), bytes);
      return `${publicUrl.replace(/\/$/, '')}/media/${name}`;
    }
  };
}

/** Detects image type from the first bytes; the browser-provided mime type is not trusted. */
export function sniffImage(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
