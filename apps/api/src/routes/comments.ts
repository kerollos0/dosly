import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { decrypt, deleteComment, GraphError, PRIVATE_REPLY_MS, replyToComment, sendSocialMessage, setCommentHidden, socialTextProblem } from '@dosly/shared';
import { attachPlatformId } from '@dosly/core';
import type { AuthContext } from '../auth.js';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';

const listQuery = z.object({
  clientId: z.string().optional(),
  status: z.enum(['OPEN', 'DONE', 'ALL']).default('OPEN'),
  platform: z.enum(['FACEBOOK_PAGE', 'INSTAGRAM']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
});
const textBody = z.object({ text: z.string().trim().min(1).max(8000) }); // Facebook comments allow 8000 characters

/** Graph errors reach the user in Arabic with Meta's own message for support. */
const graphFailure = (e: unknown, what: string) => {
  if (e instanceof GraphError) return new HttpError(502, `${what}: ${e.message}`, 'graph_failed');
  return new HttpError(502, `${what}: تعذر الاتصال بفيسبوك`, 'graph_failed');
};

/**
 * Comments on the clients' Facebook and Instagram posts: one list of threads to answer, with
 * public reply, private reply (one message to the commenter's inbox), hide, delete and done.
 */
export const commentRoutes: FastifyPluginAsync = async app => {
  const { db, key, realtime } = app.deps;
  const f = app.deps.fetch;

  async function commentFor(auth: AuthContext, id: string) {
    const c = await db.socialComment.findFirst({ where: { id, agencyId: auth.agencyId }, include: { socialAccount: true } });
    if (!c) throw new HttpError(404, 'الكومنت مش موجود', 'not_found');
    await assertClientAccess(db, auth, c.clientId);
    return { ...c, token: decrypt(c.socialAccount.accessTokenEnc, key) };
  }
  const changed = (agencyId: string, c: { id: string; clientId: string }) => realtime.publish(agencyId, { type: 'comment.updated', commentId: c.id, clientId: c.clientId });

  app.get('/comments', async req => {
    const auth = requireAuth(req);
    const q = listQuery.parse(req.query);
    const visible = await visibleClientIds(db, auth);
    if (q.clientId && visible !== 'all' && !visible.includes(q.clientId)) throw new HttpError(403, 'العميل ده مش متعين لك', 'forbidden');
    const scope = { agencyId: auth.agencyId, ...(q.clientId ? { clientId: q.clientId } : visible === 'all' ? {} : { clientId: { in: visible } }), ...(q.platform ? { platform: q.platform } : {}) };
    const where = { ...scope, parentExternalId: null, fromPage: false, deletedAt: null, ...(q.status === 'ALL' ? {} : { status: q.status }) };
    const [tops, openCount] = await Promise.all([
      db.socialComment.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: { client: { select: { id: true, name: true } }, socialAccount: { select: { id: true, name: true, platform: true } } }
      }),
      db.socialComment.count({ where: { ...scope, parentExternalId: null, fromPage: false, deletedAt: null, status: 'OPEN' } })
    ]);
    const page = tops.slice(0, q.limit);
    const [replies, targets] = await Promise.all([
      page.length ? db.socialComment.findMany({
        where: { OR: page.map(t => ({ socialAccountId: t.socialAccountId, parentExternalId: t.externalId })) },
        orderBy: { createdAt: 'asc' }, include: { sentBy: { select: { id: true, name: true } } }
      }) : [],
      page.length ? db.postTarget.findMany({
        where: { OR: page.map(t => ({ socialAccountId: t.socialAccountId, externalPostId: t.postExternalId })) },
        select: { socialAccountId: true, externalPostId: true, post: { select: { id: true, caption: true, mediaUrls: true } } }
      }) : []
    ]);
    const now = Date.now();
    const items = page.map(t => {
      const post = targets.find(p => p.socialAccountId === t.socialAccountId && p.externalPostId === t.postExternalId)?.post;
      return {
        id: t.id, platform: t.platform, body: t.body, authorName: t.authorName, createdAt: t.createdAt, status: t.status, isHidden: t.isHidden,
        privateReplyAt: t.privateReplyAt, privateConversationId: t.privateConversationId, canPrivateReply: !t.privateReplyAt && now - t.createdAt.getTime() < PRIVATE_REPLY_MS,
        client: t.client, account: t.socialAccount,
        post: post ? { id: post.id, caption: post.caption.slice(0, 160), image: post.mediaUrls[0] ?? null } : null,
        replies: replies.filter(r => r.socialAccountId === t.socialAccountId && r.parentExternalId === t.externalId).map(r => ({
          id: r.id, body: r.deletedAt ? null : r.body, fromPage: r.fromPage, authorName: r.authorName, createdAt: r.createdAt, isHidden: r.isHidden, deleted: !!r.deletedAt, sentBy: r.sentBy
        }))
      };
    });
    return { items, openCount, nextCursor: tops.length > q.limit ? page.at(-1)!.id : null };
  });

  // Public reply, shown under the comment. On a reply in a thread, it goes to the thread's first comment (Meta nests one level).
  app.post<{ Params: { id: string } }>('/comments/:id/reply', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const c = await commentFor(auth, req.params.id);
    const { text } = textBody.parse(req.body);
    if (c.deletedAt) throw new HttpError(409, 'الكومنت ده اتمسح', 'deleted');
    if (c.platform === 'INSTAGRAM' && text.length > 2200) throw new HttpError(400, 'الرد أطول من 2200 حرف، وده أقصى طول لكومنت إنستجرام', 'too_long');
    if (c.platform === 'INSTAGRAM' && c.isHidden) throw new HttpError(409, 'إنستجرام مش بيسمح بالرد على كومنت مخفي. أظهره الأول.', 'hidden');
    const topId = c.parentExternalId ?? c.externalId;
    let externalId: string;
    try { externalId = await replyToComment({ platform: c.platform, token: c.token, commentId: topId, text }, f); }
    catch (e) { throw graphFailure(e, 'الرد ماتبعتش'); }
    const created = await db.socialComment.upsert({
      where: { socialAccountId_externalId: { socialAccountId: c.socialAccountId, externalId } },
      create: { agencyId: c.agencyId, clientId: c.clientId, socialAccountId: c.socialAccountId, platform: c.platform, externalId, postExternalId: c.postExternalId, parentExternalId: topId, authorId: c.socialAccount.externalId, body: text, fromPage: true, sentById: auth.userId, status: 'DONE' },
      update: { sentById: auth.userId }
    });
    await db.socialComment.updateMany({ where: { socialAccountId: c.socialAccountId, externalId: topId }, data: { status: 'DONE' } });
    await audit(db, auth, 'comment.reply', 'SocialComment', c.id, { reply: created.id });
    await changed(auth.agencyId, c);
    return reply.status(201).send({ id: created.id });
  });

  // Private reply: one message to the commenter's Messenger or Instagram inbox, within 7 days of the comment.
  app.post<{ Params: { id: string } }>('/comments/:id/private-reply', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const c = await commentFor(auth, req.params.id);
    const { text } = textBody.parse(req.body);
    if (c.fromPage) throw new HttpError(400, 'ده كومنت الصفحة نفسها', 'own_comment');
    const tooLong = socialTextProblem(c.platform === 'INSTAGRAM' ? 'INSTAGRAM' : 'MESSENGER', text);
    if (tooLong) throw new HttpError(400, tooLong, 'too_long');
    if (Date.now() - c.createdAt.getTime() >= PRIVATE_REPLY_MS) throw new HttpError(409, 'عدّى أكتر من 7 أيام على الكومنت، وميتا مش بتسمح برد خاص بعدها', 'too_old');
    // Claim the one allowed private reply first, so a double click cannot send two.
    const claimed = await db.socialComment.updateMany({ where: { id: c.id, privateReplyAt: null }, data: { privateReplyAt: new Date() } });
    if (!claimed.count) throw new HttpError(409, 'اتبعت رد خاص على الكومنت ده قبل كده. ميتا بتسمح برسالة واحدة بس لحد ما الشخص يرد', 'already_sent');
    let sent: { recipientId: string; messageId: string };
    try { sent = await sendSocialMessage({ token: c.token, recipient: { comment_id: c.externalId }, text }, f); }
    catch (e) {
      await db.socialComment.update({ where: { id: c.id }, data: { privateReplyAt: null } });
      throw graphFailure(e, 'الرسالة الخاصة ماتبعتتش');
    }
    // The reply opens (or continues) a direct conversation; it stays read-only until the person answers.
    // Meta documents recipient_id in the response for Instagram; without it there is no one to file it under.
    let conversationId: string | null = null;
    if (sent.recipientId) {
      const channel = c.platform === 'INSTAGRAM' ? 'INSTAGRAM' as const : 'MESSENGER' as const;
      const contact = await db.contact.upsert({
        where: { socialAccountId_externalId: { socialAccountId: c.socialAccountId, externalId: sent.recipientId } },
        create: { agencyId: c.agencyId, clientId: c.clientId, socialAccountId: c.socialAccountId, externalId: sent.recipientId, name: c.platform === 'INSTAGRAM' ? null : c.authorName, username: c.platform === 'INSTAGRAM' ? c.authorName : null },
        update: {}
      });
      const now = new Date();
      const conv = await db.conversation.upsert({
        where: { socialAccountId_contactId: { socialAccountId: c.socialAccountId, contactId: contact.id } },
        create: { agencyId: c.agencyId, clientId: c.clientId, channel, socialAccountId: c.socialAccountId, contactId: contact.id, lastMessageAt: now, lastPreview: text.slice(0, 140), assigneeId: auth.userId, status: 'PENDING' },
        update: { lastMessageAt: now, lastPreview: text.slice(0, 140) }
      });
      conversationId = conv.id;
      const draft = await db.message.create({ data: { agencyId: c.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: text, status: 'SENT', sentById: auth.userId, createdAt: now, payload: { commentId: c.id } } });
      const msg = await attachPlatformId(db, draft.id, sent.messageId);
      await realtime.publish(auth.agencyId, { type: 'message.new', conversationId: conv.id, clientId: c.clientId, messageId: msg.id, direction: 'OUT' });
      await app.deps.queues.demoAfterSend?.(msg.id);
    }
    await db.socialComment.update({ where: { id: c.id }, data: { privateConversationId: conversationId } });
    await db.socialComment.update({ where: { id: c.id }, data: { status: 'DONE' } });
    await audit(db, auth, 'comment.private_reply', 'SocialComment', c.id, { conversationId });
    await changed(auth.agencyId, c);
    return reply.status(201).send({ conversationId });
  });

  app.post<{ Params: { id: string } }>('/comments/:id/hide', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const c = await commentFor(auth, req.params.id);
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    if (c.fromPage) throw new HttpError(400, 'كومنتات الصفحة نفسها ماينفعش تتخفي', 'own_comment');
    try { await setCommentHidden({ platform: c.platform, token: c.token, commentId: c.externalId, hidden }, f); }
    catch (e) { throw graphFailure(e, hidden ? 'الكومنت مااتخفاش' : 'الكومنت ماظهرش'); }
    await db.socialComment.update({ where: { id: c.id }, data: { isHidden: hidden, ...(hidden && !c.parentExternalId ? { status: 'DONE' as const } : {}) } });
    await audit(db, auth, hidden ? 'comment.hide' : 'comment.unhide', 'SocialComment', c.id);
    await changed(auth.agencyId, c);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/comments/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const c = await commentFor(auth, req.params.id);
    if (c.deletedAt) return { ok: true };
    try { await deleteComment({ token: c.token, commentId: c.externalId }, f); }
    catch (e) { throw graphFailure(e, 'الكومنت مااتمسحش'); }
    await db.socialComment.update({ where: { id: c.id }, data: { deletedAt: new Date(), status: 'DONE' } });
    await audit(db, auth, 'comment.delete', 'SocialComment', c.id, { body: c.body.slice(0, 200) });
    await changed(auth.agencyId, c);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/comments/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const c = await commentFor(auth, req.params.id);
    const { status } = z.object({ status: z.enum(['OPEN', 'DONE']) }).parse(req.body);
    await db.socialComment.update({ where: { id: c.id }, data: { status } });
    await changed(auth.agencyId, c);
    return { ok: true };
  });
};
