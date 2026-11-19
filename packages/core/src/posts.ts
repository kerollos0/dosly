import type { Db } from '@dosly/db';
import { decrypt, publishFacebookPost, publishInstagramPost } from '@dosly/shared';
import type { Publisher } from './events.js';

export type Publishers = {
  facebook: typeof publishFacebookPost;
  instagram: typeof publishInstagramPost;
};

const defaultPublishers: Publishers = { facebook: publishFacebookPost, instagram: publishInstagramPost };

/**
 * Publishes every pending target of a post. Targets that already succeeded are skipped,
 * so a retry never double-posts. Returns the post's final status.
 */
export async function publishPost(db: Db, postId: string, key: Buffer, pub: Publisher, publishers: Publishers = defaultPublishers) {
  const claimed = await db.post.updateMany({ where: { id: postId, status: { in: ['SCHEDULED', 'FAILED', 'PARTIAL'] } }, data: { status: 'PUBLISHING' } });
  if (claimed.count === 0) return null; // already publishing, published, or unscheduled

  const post = await db.post.findUniqueOrThrow({ where: { id: postId }, include: { targets: { include: { socialAccount: true } } } });
  for (const t of post.targets) {
    if (t.status === 'PUBLISHED') continue;
    const acc = t.socialAccount;
    try {
      const token = decrypt(acc.accessTokenEnc, key);
      const image = post.mediaUrls[0];
      let externalId: string;
      if (acc.platform === 'FACEBOOK_PAGE') {
        externalId = await publishers.facebook({ pageId: acc.externalId, token, caption: post.caption, imageUrl: image });
      } else {
        if (!image) throw new Error('Instagram posts need an image');
        externalId = await publishers.instagram({ igUserId: acc.externalId, token, caption: post.caption, imageUrl: image });
      }
      await db.postTarget.update({ where: { id: t.id }, data: { status: 'PUBLISHED', externalPostId: externalId, publishedAt: new Date(), error: null, attempts: { increment: 1 } } });
    } catch (err) {
      await db.postTarget.update({ where: { id: t.id }, data: { status: 'FAILED', error: String((err as Error).message).slice(0, 500), attempts: { increment: 1 } } });
    }
  }

  const targets = await db.postTarget.findMany({ where: { postId } });
  const ok = targets.filter(t => t.status === 'PUBLISHED').length;
  const status = ok === targets.length ? 'PUBLISHED' : ok === 0 ? 'FAILED' : 'PARTIAL';
  await db.post.update({ where: { id: postId }, data: { status } });
  await db.auditLog.create({ data: { agencyId: post.agencyId, action: `post.${status.toLowerCase()}`, entity: 'Post', entityId: postId, meta: { ok, total: targets.length } } });
  await pub.publish(post.agencyId, { type: 'post.updated', postId, status });
  return status;
}

/** Posts whose time has passed but are still waiting, e.g. after Redis lost its delayed jobs. */
export function overduePosts(db: Db, now = new Date()): Promise<{ id: string }[]> {
  return db.post.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, select: { id: true }, take: 100 });
}
