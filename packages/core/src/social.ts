import { Prisma, type Db } from '@dosly/db';
import { decrypt, getSocialProfile, parseSocialWebhook, socialMessageType, type SocialInbound } from '@dosly/shared';
import type { Publisher } from './events.js';
import type { MediaStore } from './media-store.js';
import { previewText } from './media.js';
import { processWhatsAppWebhook, type WebhookHooks } from './webhooks.js';
import { autoReplyToMessage } from './autoreply.js';
import { noteInterest } from './crm.js';

export type SocialHooks = WebhookHooks & {
  /** With the encryption key, new Messenger/Instagram customers get their name and picture from the Graph API. */
  key?: Buffer;
  fetch?: typeof fetch;
  /** Our Meta app id: echoes of what Dosly itself sent are skipped (they are already stored). */
  appId?: string;
  /** To delete an attachment the customer unsent. */
  store?: MediaStore;
  /** A customer's new comment: the worker checks the client's comment rules (public reply, private message). */
  onComment?: (commentId: string) => Promise<void>;
};

type Account = Prisma.SocialAccountGetPayload<object>;
const MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/**
 * Finds the connected Page or Instagram account a webhook is for. Connecting refuses an account another
 * agency holds, so there is one; if old data ever has two, nothing is routed rather than guessing.
 */
async function accountFor(db: Db, platform: Account['platform'], externalId: string) {
  const found = await db.socialAccount.findMany({ where: { platform, externalId, client: { archivedAt: null } }, take: 2 });
  return found.length === 1 ? found[0]! : null;
}

/**
 * Stores the platform id Meta returned for a message we sent. If its echo webhook got there first and
 * created a row of its own, that row is dropped and ours keeps the id, so the message shows once.
 */
export async function attachPlatformId(db: Db, messageId: string, mid: string, data: Prisma.MessageUpdateInput = {}) {
  const update = () => db.message.update({ where: { id: messageId }, data: { ...data, waMessageId: mid } });
  try { return await update(); }
  catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    const echo = await db.message.findUnique({ where: { waMessageId: mid } });
    if (!echo || echo.id === messageId || echo.direction !== 'OUT' || echo.sentById) throw e;
    await db.message.delete({ where: { id: echo.id } });
    return update();
  }
}

/** Click-to-Messenger / Instagram: the latest ad a customer came from (like WhatsApp's referral). */
async function noteAdReferral(db: Db, contactId: string, r: { adId: string; title?: string }, at: Date) {
  await db.contact.update({ where: { id: contactId }, data: { adId: r.adId, adReferredAt: at, adTitle: r.title ?? null, source: 'ad' } });
}

/** The status a comment thread should have: open when the newest word in it is the customer's. */
async function threadStatus(db: Db, accountId: string, rootExternalId: string) {
  const root = await db.socialComment.findUnique({ where: { socialAccountId_externalId: { socialAccountId: accountId, externalId: rootExternalId } } });
  if (!root || root.isHidden || root.deletedAt) return;
  const last = await db.socialComment.findFirst({ where: { socialAccountId: accountId, parentExternalId: rootExternalId, deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const status = (last ?? root).fromPage ? 'DONE' as const : 'OPEN' as const;
  if (root.status !== status) await db.socialComment.update({ where: { id: root.id }, data: { status } });
}

async function contactFor(db: Db, acc: Account, customerId: string, hooks: SocialHooks) {
  const existing = await db.contact.findUnique({ where: { socialAccountId_externalId: { socialAccountId: acc.id, externalId: customerId } } });
  if (existing) return existing;
  let profile: { name?: string; username?: string; avatarUrl?: string } = {};
  if (hooks.key) {
    // Optional: Meta may refuse the profile (privacy settings, missing permission); the contact still works.
    try { profile = await getSocialProfile({ platform: acc.platform, token: decrypt(acc.accessTokenEnc, hooks.key), userId: customerId }, hooks.fetch); } catch { /* unnamed */ }
  }
  return db.contact.upsert({
    where: { socialAccountId_externalId: { socialAccountId: acc.id, externalId: customerId } },
    create: { agencyId: acc.agencyId, clientId: acc.clientId, socialAccountId: acc.id, externalId: customerId, name: profile.name, username: profile.username, avatarUrl: profile.avatarUrl },
    update: {}
  });
}

/** One stored message per attachment (Instagram can send several photos at once); the text goes on the first. */
function partsOf(m: SocialInbound) {
  if (!m.attachments.length) return [{ mid: m.mid, type: 'text', body: m.text, url: undefined as string | undefined }];
  return m.attachments.map((a, i) => {
    const type = socialMessageType(a);
    const media = MEDIA.has(type) && !!a.url;
    return {
      mid: i === 0 ? m.mid : `${m.mid}#${i}`,
      type: media ? type : type === 'sticker' ? 'sticker' : 'share',
      body: (i === 0 ? m.text : undefined) ?? (media ? undefined : [a.title, a.url].filter(Boolean).join('\n') || undefined),
      url: media ? a.url : undefined
    };
  });
}

/**
 * Applies one Facebook Page or Instagram webhook: direct messages (and echoes of what the business
 * sent from other tools), read receipts, and comments. Safe to run twice on the same payload.
 */
export async function processSocialWebhook(db: Db, payload: unknown, pub: Publisher, hooks: SocialHooks = {}) {
  const { messages, reads, comments, referrals } = parseSocialWebhook(payload as Record<string, unknown>);
  const unknown = new Set<string>();
  let stored = 0, commentsStored = 0;

  for (const m of messages) {
    const acc = await accountFor(db, m.platform, m.accountId);
    if (!acc) { unknown.add(m.accountId); continue; }
    if (m.deleted) {
      // The customer unsent the message: keep the row, drop what it said.
      // The customer unsent the message: keep the rows (every attachment of it), drop what they held.
      const gone = await db.message.findMany({ where: { OR: [{ waMessageId: m.mid }, { waMessageId: { startsWith: `${m.mid}#` } }], conversation: { socialAccountId: acc.id } } });
      for (const g of gone) {
        await db.message.update({ where: { id: g.id }, data: { body: 'العميل مسح الرسالة دي', type: 'text', mediaStatus: null, payload: Prisma.DbNull, mediaKey: null, previewKey: null, mediaMime: null, mediaSize: null, fileName: null } });
        for (const k of [g.mediaKey, g.previewKey]) if (k) await hooks.store?.remove(k).catch(() => {});
        await pub.publish(acc.agencyId, { type: 'message.updated', conversationId: g.conversationId, messageId: g.id });
      }
      continue;
    }
    if (m.echo && hooks.appId && m.appId === hooks.appId) continue; // sent from Dosly: already stored with its id
    const parts = partsOf(m);
    const known = new Set((await db.message.findMany({ where: { waMessageId: { in: parts.map(p => p.mid) } }, select: { waMessageId: true } })).map(x => x.waMessageId));
    const fresh = parts.filter(p => !known.has(p.mid)); // a retry finishes what an interrupted run started
    if (!fresh.length) continue;
    const channel = acc.platform === 'INSTAGRAM' ? 'INSTAGRAM' as const : 'MESSENGER' as const;
    const contact = await contactFor(db, acc, m.customerId, hooks);
    if (m.referral) await noteAdReferral(db, contact.id, m.referral, m.timestamp);
    if (!m.echo) await noteInterest(db, contact.id, m.text);
    const preview = previewText(parts[0]!.type, parts[0]!.body);
    const created = await db.$transaction(async tx => {
      const conv = await tx.conversation.upsert({
        where: { socialAccountId_contactId: { socialAccountId: acc.id, contactId: contact.id } },
        create: { agencyId: acc.agencyId, clientId: acc.clientId, channel, socialAccountId: acc.id, contactId: contact.id, lastMessageAt: m.timestamp, lastPreview: preview, ...(m.echo ? {} : { lastInboundAt: m.timestamp, unreadCount: fresh.length }) },
        update: { lastMessageAt: m.timestamp, lastPreview: preview, ...(m.echo ? {} : { lastInboundAt: m.timestamp, unreadCount: { increment: fresh.length }, status: 'OPEN' as const }) }
      });
      const rows = [];
      for (const p of fresh) {
        rows.push({ conv, url: p.url, msg: await tx.message.create({
          data: {
            agencyId: acc.agencyId, conversationId: conv.id, direction: m.echo ? 'OUT' : 'IN', type: p.type, body: p.body, waMessageId: p.mid,
            status: m.echo ? 'SENT' : 'RECEIVED', createdAt: m.timestamp,
            ...(p.url && { mediaStatus: 'PENDING' as const, payload: { sourceUrl: p.url } })
          }
        }) });
      }
      return rows;
    }).catch(e => {
      // Our own send stored this id a moment ago: the echo has nothing to add.
      if (m.echo && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return [];
      throw e;
    });
    for (const { conv, msg, url } of created) {
      stored++;
      await pub.publish(acc.agencyId, { type: 'message.new', conversationId: conv.id, clientId: acc.clientId, messageId: msg.id, direction: m.echo ? 'OUT' : 'IN' });
      if (url) await hooks.onMedia?.(msg.id);
    }
    // Not when another app owns the thread, for button presses, or for story mentions and shared posts.
    const answerable = !m.echo && !m.standby && !m.postback && !(m.attachments.length && !m.text && m.attachments.every(a => !['image', 'audio', 'video', 'file'].includes(a.type)));
    if (answerable && created.length) {
      const auto = await autoReplyToMessage(db, pub, hooks.onSend, { conversationId: created[0]!.conv.id, body: m.text, at: m.timestamp });
      if (!auto) await hooks.onAiReply?.(created[0]!.conv.id);
    }
  }

  // Back through an ad without writing yet: remember the ad, so their next order counts for it.
  for (const r of referrals) {
    const acc = await accountFor(db, r.platform, r.accountId);
    if (!acc) continue;
    const contact = await contactFor(db, acc, r.customerId, hooks);
    await noteAdReferral(db, contact.id, r, r.timestamp);
  }

  for (const r of reads) {
    const acc = await accountFor(db, r.platform, r.accountId);
    if (!acc) continue;
    const contact = await db.contact.findUnique({ where: { socialAccountId_externalId: { socialAccountId: acc.id, externalId: r.customerId } } });
    if (!contact) continue;
    const conv = await db.conversation.findUnique({ where: { socialAccountId_contactId: { socialAccountId: acc.id, contactId: contact.id } } });
    if (!conv) continue;
    const next = r.kind === 'read' ? 'READ' as const : 'DELIVERED' as const;
    // A read or delivery covers every earlier message: Messenger sends a watermark, Instagram the last mid seen.
    let upTo = r.watermark ?? new Date();
    if (r.mid) { const seen = await db.message.findUnique({ where: { waMessageId: r.mid } }); if (seen?.conversationId === conv.id) upTo = seen.createdAt; }
    const targets = await db.message.findMany({ where: { conversationId: conv.id, direction: 'OUT', status: { in: next === 'READ' ? ['SENT', 'DELIVERED'] : ['SENT'] }, createdAt: { lte: upTo } }, select: { id: true }, take: 200 });
    if (!targets.length) continue;
    await db.message.updateMany({ where: { id: { in: targets.map(t => t.id) } }, data: { status: next } });
    for (const t of targets) await pub.publish(acc.agencyId, { type: 'message.status', conversationId: conv.id, messageId: t.id, status: next });
  }

  for (const c of comments) {
    const acc = await accountFor(db, c.platform, c.accountId);
    if (!acc) { unknown.add(c.accountId); continue; }
    const where = { socialAccountId_externalId: { socialAccountId: acc.id, externalId: c.commentId } };
    const existing = await db.socialComment.findUnique({ where });
    if (c.verb === 'add') {
      if (existing) continue;
      const fromPage = !!c.fromId && c.fromId === acc.externalId;
      // A reply whose thread we never saw (an older post) is shown as a thread of its own, and so is a
      // customer's reply under the Page's own comment (a pinned "prices in DM" comment, say).
      const parent = c.parentId ? await db.socialComment.findUnique({ where: { socialAccountId_externalId: { socialAccountId: acc.id, externalId: c.parentId } } }) : null;
      const parentId = parent && !(parent.fromPage && !fromPage) ? parent.externalId : undefined;
      const created = await db.socialComment.create({
        data: {
          agencyId: acc.agencyId, clientId: acc.clientId, socialAccountId: acc.id, platform: acc.platform, externalId: c.commentId, postExternalId: c.postId,
          parentExternalId: parentId ?? null, authorId: c.fromId, authorName: c.fromName, body: c.text ?? '', fromPage, status: fromPage || parentId ? 'DONE' : 'OPEN', createdAt: c.createdAt
        }
      });
      commentsStored++;
      // The newest word in the thread decides: a customer's reopens it, the business's closes it. Webhooks
      // can arrive out of order, so this looks at the thread rather than at this one comment.
      if (parentId) await threadStatus(db, acc.id, parentId);
      await pub.publish(acc.agencyId, { type: 'comment.new', commentId: created.id, clientId: acc.clientId, fromPage });
      if (!fromPage) await hooks.onComment?.(created.id);
      continue;
    }
    if (!existing) continue;
    const data = c.verb === 'edited' ? { body: c.text ?? existing.body } : c.verb === 'remove' ? { deletedAt: new Date() } : { isHidden: c.verb === 'hide' };
    await db.socialComment.update({ where, data });
    if (c.verb === 'remove' && existing.parentExternalId) await threadStatus(db, acc.id, existing.parentExternalId);
    await pub.publish(acc.agencyId, { type: 'comment.updated', commentId: existing.id, clientId: acc.clientId });
  }

  return { messages: stored, comments: commentsStored, unknownAccounts: [...unknown] };
}

/** Routes any Meta webhook (WhatsApp, Page, Instagram) to its processor. */
export async function processMetaWebhook(db: Db, payload: unknown, pub: Publisher, hooks: SocialHooks = {}): Promise<{ unknown: string[] }> {
  const object = (payload as { object?: string } | null)?.object;
  if (object === 'page' || object === 'instagram') return { unknown: (await processSocialWebhook(db, payload, pub, hooks)).unknownAccounts };
  return { unknown: (await processWhatsAppWebhook(db, payload, pub, hooks)).unknownNumbers };
}
