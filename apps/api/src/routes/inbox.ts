import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { conversationUpdateSchema, decrypt, GraphError, quickReplySchema, replyWindow, sendMessageSchema, sendSocialMessage, sendWhatsAppText, socialTextProblem, WINDOW_CLOSED_AR } from '@dosly/shared';
import { attachPlatformId } from '@dosly/core';
import type { AuthContext } from '../auth.js';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission, visibleClientIds } from '../auth.js';
import { publicMessage } from './media.js';

const listQuery = z.object({
  clientId: z.string().optional(),
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
  mine: z.coerce.boolean().optional(),
  channel: z.enum(['WHATSAPP', 'MESSENGER', 'INSTAGRAM']).optional(),
  cursor: z.string().optional(), // id of the last conversation from the previous page
  limit: z.coerce.number().int().min(1).max(100).default(30)
});

export const inboxRoutes: FastifyPluginAsync = async app => {
  const { db, key, realtime } = app.deps;

  async function loadConversation(auth: AuthContext, id: string) {
    const conv = await db.conversation.findFirst({ where: { id, agencyId: auth.agencyId }, include: { waNumber: true, socialAccount: true, contact: true } });
    if (!conv) throw new HttpError(404, 'المحادثة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, conv.clientId);
    return conv;
  }

  app.get('/conversations', async req => {
    const auth = requireAuth(req);
    const q = listQuery.parse(req.query);
    const visible = await visibleClientIds(db, auth);
    if (q.clientId && visible !== 'all' && !visible.includes(q.clientId)) throw new HttpError(403, 'العميل ده مش متعين لك', 'forbidden');
    const items = await db.conversation.findMany({
      where: {
        agencyId: auth.agencyId,
        ...(q.clientId ? { clientId: q.clientId } : visible === 'all' ? {} : { clientId: { in: visible } }),
        ...(q.status ? { status: q.status } : {}),
        ...(q.mine ? { assigneeId: auth.userId } : {}),
        ...(q.channel ? { channel: q.channel } : {})
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { contact: { select: { name: true, waId: true, username: true, avatarUrl: true } }, client: { select: { id: true, name: true } }, assignee: { select: { id: true, name: true } } }
    });
    const hasMore = items.length > q.limit;
    const page = items.slice(0, q.limit).map(c => { const window = replyWindow(c.channel, c.lastInboundAt); return { ...c, window, windowOpen: window !== 'closed' }; });
    return { items: page, nextCursor: hasMore ? page.at(-1)!.id : null };
  });

  app.get<{ Params: { id: string } }>('/conversations/:id/messages', async req => {
    const auth = requireAuth(req);
    await loadConversation(auth, req.params.id);
    const q = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const items = await db.message.findMany({
      where: { conversationId: req.params.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.before ? { cursor: { id: q.before }, skip: 1 } : {}),
      include: { sentBy: { select: { id: true, name: true } } }
    });
    const hasMore = items.length > q.limit;
    const page = items.slice(0, q.limit);
    return { items: page.reverse().map(publicMessage), nextCursor: hasMore ? page[0]!.id : null };
  });

  // One message, for live updates (a download finishing, a status change) without reloading the thread.
  app.get<{ Params: { id: string } }>('/messages/:id', async req => {
    const auth = requireAuth(req);
    const msg = await db.message.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, include: { sentBy: { select: { id: true, name: true } }, conversation: { select: { clientId: true } } } });
    if (!msg) throw new HttpError(404, 'الرسالة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, msg.conversation.clientId);
    const { conversation: _c, ...rest } = msg;
    return publicMessage(rest);
  });

  // One conversation, e.g. to word a notification. Same visibility rules as the list.
  app.get<{ Params: { id: string } }>('/conversations/:id', async req => {
    const auth = requireAuth(req);
    const c = await loadConversation(auth, req.params.id);
    const [client, assignee] = await Promise.all([
      db.client.findUnique({ where: { id: c.clientId }, select: { id: true, name: true } }),
      c.assigneeId ? db.user.findUnique({ where: { id: c.assigneeId }, select: { id: true, name: true } }) : null
    ]);
    return { id: c.id, clientId: c.clientId, client, status: c.status, assigneeId: c.assigneeId, assignee, lastMessageAt: c.lastMessageAt, lastInboundAt: c.lastInboundAt, unreadCount: c.unreadCount, lastPreview: c.lastPreview, channel: c.channel, contact: { name: c.contact.name, waId: c.contact.waId, username: c.contact.username }, window: replyWindow(c.channel, c.lastInboundAt), windowOpen: replyWindow(c.channel, c.lastInboundAt) !== 'closed' };
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/read', async req => {
    const auth = requireAuth(req);
    await loadConversation(auth, req.params.id);
    await db.conversation.update({ where: { id: req.params.id }, data: { unreadCount: 0 } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/messages', async (req, reply) => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await loadConversation(auth, req.params.id);
    const { body } = sendMessageSchema.parse(req.body);
    const window = replyWindow(conv.channel, conv.lastInboundAt);
    if (window === 'closed') throw new HttpError(409, WINDOW_CLOSED_AR[conv.channel], 'window_closed');
    const tooLong = conv.channel === 'WHATSAPP' ? null : socialTextProblem(conv.channel, body);
    if (tooLong) throw new HttpError(400, tooLong, 'too_long');
    const msg = await db.message.create({ data: { agencyId: auth.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body, status: 'QUEUED', sentById: auth.userId } });
    try {
      let waMessageId: string;
      if (conv.waNumber && conv.contact.waId) {
        waMessageId = await sendWhatsAppText({ phoneNumberId: conv.waNumber.phoneNumberId, token: decrypt(conv.waNumber.accessTokenEnc, key), to: conv.contact.waId, body }, app.deps.fetch);
      } else if (conv.socialAccount && conv.contact.externalId) {
        // Past 24h, Messenger and Instagram allow a person's reply for 7 days with the HUMAN_AGENT tag.
        const r = await sendSocialMessage({ token: decrypt(conv.socialAccount.accessTokenEnc, key), recipient: { id: conv.contact.externalId }, text: body, tag: window === 'human_agent' ? 'HUMAN_AGENT' : undefined }, app.deps.fetch);
        waMessageId = r.messageId;
      } else throw new HttpError(409, 'القناة بتاعة المحادثة دي اتشالت', 'channel_gone');
      // The echo webhook may have stored this id first; attachPlatformId keeps one copy, ours.
      const sent = await attachPlatformId(db, msg.id, waMessageId, { status: 'SENT' });
      await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: sent.createdAt, lastPreview: body.slice(0, 140), unreadCount: 0, assigneeId: conv.assigneeId ?? auth.userId } });
      await realtime.publish(auth.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: sent.id, direction: 'OUT' });
      await app.deps.queues.demoAfterSend?.(sent.id);
      return reply.status(201).send(publicMessage(sent));
    } catch (e) {
      if (e instanceof HttpError) { await db.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error: e.message } }); throw e; }
      const error = e instanceof GraphError ? e.message : conv.channel === 'WHATSAPP' ? 'تعذر الاتصال بواتساب' : 'تعذر الاتصال بفيسبوك';
      await db.message.update({ where: { id: msg.id }, data: { status: 'FAILED', error } });
      throw new HttpError(502, `الرسالة متبعتتش: ${error}`, 'send_failed');
    }
  });

  app.patch<{ Params: { id: string } }>('/conversations/:id', async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await loadConversation(auth, req.params.id);
    const input = conversationUpdateSchema.parse(req.body);
    if (input.assigneeId) {
      const m = await db.membership.findUnique({ where: { agencyId_userId: { agencyId: auth.agencyId, userId: input.assigneeId } } });
      if (!m) throw new HttpError(400, 'العضو مش تابع للوكالة', 'bad_member');
    }
    const updated = await db.conversation.update({ where: { id: conv.id }, data: input });
    await audit(db, auth, 'conversation.update', 'Conversation', conv.id, input);
    await realtime.publish(auth.agencyId, { type: 'conversation.updated', conversationId: conv.id, clientId: conv.clientId });
    return updated;
  });

  app.get('/quick-replies', async req => {
    const auth = requireAuth(req);
    return db.quickReply.findMany({ where: { agencyId: auth.agencyId }, orderBy: { shortcut: 'asc' } });
  });

  app.post('/quick-replies', async (req, reply) => {
    const auth = requirePermission(req, 'clients:manage');
    const input = quickReplySchema.parse(req.body);
    const qr = await db.quickReply.upsert({ where: { agencyId_shortcut: { agencyId: auth.agencyId, shortcut: input.shortcut } }, create: { ...input, agencyId: auth.agencyId }, update: { body: input.body } });
    return reply.status(201).send(qr);
  });

  app.delete<{ Params: { id: string } }>('/quick-replies/:id', async req => {
    const auth = requirePermission(req, 'clients:manage');
    await db.quickReply.deleteMany({ where: { id: req.params.id, agencyId: auth.agencyId } });
    return { ok: true };
  });
};
