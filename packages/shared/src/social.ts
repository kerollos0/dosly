import { graph } from './whatsapp.js';

type F = typeof fetch | undefined;

/** Publishes to a Facebook Page feed. One image uses /photos; text or link posts use /feed. */
export async function publishFacebookPost(o: { pageId: string; token: string; caption: string; imageUrl?: string }, f?: F): Promise<string> {
  if (o.imageUrl) {
    const r = await graph<{ post_id?: string; id: string }>(`${o.pageId}/photos`, o.token, { body: { url: o.imageUrl, caption: o.caption } }, f);
    return r.post_id ?? r.id;
  }
  const r = await graph<{ id: string }>(`${o.pageId}/feed`, o.token, { body: { message: o.caption } }, f);
  return r.id;
}

/** Instagram needs a public image URL: create a media container, wait until it is ready, then publish it. */
export async function publishInstagramPost(o: { igUserId: string; token: string; caption: string; imageUrl: string; pollMs?: number }, f?: F): Promise<string> {
  const c = await graph<{ id: string }>(`${o.igUserId}/media`, o.token, { body: { image_url: o.imageUrl, caption: o.caption } }, f);
  for (let i = 0; i < 10; i++) {
    const s = await graph<{ status_code: string }>(`${c.id}?fields=status_code`, o.token, {}, f);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram media ${s.status_code}`);
    await new Promise(r => setTimeout(r, o.pollMs ?? 3000));
  }
  const p = await graph<{ id: string }>(`${o.igUserId}/media_publish`, o.token, { body: { creation_id: c.id } }, f);
  return p.id;
}
