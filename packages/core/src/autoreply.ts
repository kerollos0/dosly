import type { Db, Prisma } from '@dosly/db';
import { Prisma as P } from '@dosly/db';
import {
  AUTO_GAP_MS, AWAY_GAP_MS, HUMAN_PAUSE_MS, PRIVATE_REPLY_MS, decrypt, fillName, GraphError, isOpen, isPermanentSocialError, matchKeyword, replyToComment, sendSocialMessage, type WorkHours
} from '@dosly/shared';
import type { Publisher } from './events.js';
import { attachPlatformId } from './social.js';

type Rule = Prisma.AutoRuleGetPayload<object>;

/** A message older than this is a late or replayed webhook: answering it now would look broken. */
const STALE_MS = 5 * 60_000;
/** Without a person stepping in, at most this many automatic replies per chat a day (another bot on the other side). */
const DAILY_CAP = 3;
/** The same keyword reply goes to the same chat at most once in this time. */
const SAME_RULE_MS = 6 * 3600_000;

type OutRow = { sentById: string | null; type: string; payload: Prisma.JsonValue; waMessageId: string | null };
/**
 * Written by a person: from Dosly (has an author), or from Meta Business Suite / the phone app (an echo with
 * no payload of ours). Offers, order messages, opt-out notes and automatic replies are not a person talking.
 */
function byPerson(m: OutRow) {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  if (m.type === 'template' || p.broadcastId || p.autoRuleId || p.orderId || p.optOut || p.commentId && !m.sentById) return false;
  return !!m.sentById || (!!m.waMessageId && !p.kind);
}

/**
 * After a customer's message: the client's automatic reply, if one fits. Keywords first ("بكام" → the price),
 * then "we're closed" outside working hours, then the welcome on someone's very first message.
 * Never while a person from the team is talking to the customer, and at most once every 2 minutes per chat.
 * Returns the queued message id.
 */
export async function autoReplyToMessage(db: Db, pub: Publisher, onSend: ((messageId: string) => Promise<void>) | undefined, o: { conversationId: string; body?: string | null; at: Date; now?: Date }): Promise<string | null> {
  if (!onSend) return null;
  const now = o.now ?? new Date();
  if (now.getTime() - o.at.getTime() > STALE_MS) return null;
  const conv = await db.conversation.findUnique({ where: { id: o.conversationId }, include: { contact: true } });
  if (!conv) return null;
  if (conv.autoReplyAt && now.getTime() - conv.autoReplyAt.getTime() < AUTO_GAP_MS) return null;
  const rules = await db.autoRule.findMany({ where: { clientId: conv.clientId, enabled: true, kind: { in: ['KEYWORD', 'AWAY', 'WELCOME'] }, channels: { has: conv.channel } }, orderBy: { createdAt: 'asc' } });
  if (!rules.length) return null;
  const recent = await db.message.findMany({ where: { conversationId: conv.id, direction: 'OUT', createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) } }, orderBy: { createdAt: 'desc' }, take: 50, select: { sentById: true, type: true, payload: true, waMessageId: true, createdAt: true } });
  const lastPerson = recent.find(byPerson);
  if (lastPerson && now.getTime() - lastPerson.createdAt.getTime() < HUMAN_PAUSE_MS) return null;
  const autos = recent.filter(m => !!(m.payload as { autoRuleId?: string } | null)?.autoRuleId && (!lastPerson || m.createdAt > lastPerson.createdAt));
  if (autos.length >= DAILY_CAP) return null;
  const firedHere = (r: Rule) => autos.some(m => (m.payload as { autoRuleId?: string }).autoRuleId === r.id && now.getTime() - m.createdAt.getTime() < SAME_RULE_MS);

  let rule: Rule | undefined = rules.find(r => r.kind === 'KEYWORD' && !firedHere(r) && matchKeyword(o.body, r.keywords));
  let away = false;
  if (!rule) {
    const a = rules.find(r => r.kind === 'AWAY' && r.hours && !isOpen(r.hours as WorkHours, now));
    if (a && (!conv.awayAt || now.getTime() - conv.awayAt.getTime() >= AWAY_GAP_MS)) { rule = a; away = true; }
  }
  if (!rule) {
    const w = rules.find(r => r.kind === 'WELCOME');
    // First contact: nothing in the chat before this message (an offer or a private reply we sent counts as contact).
    if (w && !(await db.message.findFirst({ where: { conversationId: conv.id, createdAt: { lt: o.at } }, select: { id: true } }))) rule = w;
  }
  if (!rule?.reply) return null;

  // Claim the chat's slot first, so two messages arriving together get one reply.
  const claimed = await db.conversation.updateMany({
    where: { id: conv.id, OR: [{ autoReplyAt: null }, { autoReplyAt: { lt: new Date(now.getTime() - AUTO_GAP_MS) } }] },
    data: { autoReplyAt: now, ...(away ? { awayAt: now } : {}) }
  });
  if (!claimed.count) return null;
  const body = fillName(rule.reply, conv.contact.name ?? conv.contact.username);
  const msg = await db.message.create({ data: { agencyId: conv.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body, status: 'QUEUED', payload: { kind: 'text', autoRuleId: rule.id } } });
  await db.autoRule.update({ where: { id: rule.id }, data: { fired: { increment: 1 }, lastFiredAt: now } });
  await pub.publish(conv.agencyId, { type: 'message.new', conversationId: conv.id, clientId: conv.clientId, messageId: msg.id, direction: 'OUT' });
  await onSend(msg.id);
  return msg.id;
}

type CommentDeps = { db: Db; pub: Publisher; key: Buffer; fetch?: typeof fetch; afterSend?: (messageId: string) => Promise<void> };
type CommentRow = Prisma.SocialCommentGetPayload<{ include: { socialAccount: true } }>;

/**
 * The one private message Meta allows per comment (within 7 days). It opens, or continues, the person's
 * chat in the inbox. Claims the comment first, so a double click or a rule and a person never send two.
 */
export async function sendPrivateReply(deps: CommentDeps, c: CommentRow, text: string, userId: string | null): Promise<{ conversationId: string | null } | 'already_sent'> {
  const { db, pub } = deps;
  const claimed = await db.socialComment.updateMany({ where: { id: c.id, privateReplyAt: null }, data: { privateReplyAt: new Date() } });
  if (!claimed.count) return 'already_sent';
  let sent: { recipientId: string; messageId: string };
  try { sent = await sendSocialMessage({ token: decrypt(c.socialAccount.accessTokenEnc, deps.key), recipient: { comment_id: c.externalId }, text }, deps.fetch); }
  catch (e) { await db.socialComment.update({ where: { id: c.id }, data: { privateReplyAt: null } }); throw e; }
  // Meta documents recipient_id in the response for Instagram; without it there is no one to file it under.
  let conversationId: string | null = null;
  if (sent.recipientId) {
    const channel = c.platform === 'INSTAGRAM' ? 'INSTAGRAM' as const : 'MESSENGER' as const;
    const contact = await db.contact.upsert({
      where: { socialAccountId_externalId: { socialAccountId: c.socialAccountId, externalId: sent.recipientId } },
      create: { agencyId: c.agencyId, clientId: c.clientId, socialAccountId: c.socialAccountId, externalId: sent.recipientId, name: c.platform === 'INSTAGRAM' ? null : c.authorName, username: c.platform === 'INSTAGRAM' ? c.authorName : null, source: 'comment', sourceRef: c.postExternalId, ...(matchKeyword(c.body, ['بكام', 'السعر', 'سعر', 'الاسعار', 'متاح', 'price']) ? { stage: 'INTERESTED' as const, stageAt: new Date() } : {}) },
      update: {}
    });
    const now = new Date();
    // It stays read-only until the person answers (Meta allows nothing more before that).
    const conv = await db.conversation.upsert({
      where: { socialAccountId_contactId: { socialAccountId: c.socialAccountId, contactId: contact.id } },
      create: { agencyId: c.agencyId, clientId: c.clientId, channel, socialAccountId: c.socialAccountId, contactId: contact.id, lastMessageAt: now, lastPreview: text.slice(0, 140), assigneeId: userId, status: userId ? 'PENDING' : 'CLOSED' },
      update: { lastMessageAt: now, lastPreview: text.slice(0, 140) }
    });
    conversationId = conv.id;
    const draft = await db.message.create({ data: { agencyId: c.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: text, status: 'SENT', sentById: userId, createdAt: now, payload: { commentId: c.id, ...(userId ? {} : { autoRuleId: c.autoRuleId }) } } });
    const msg = await attachPlatformId(db, draft.id, sent.messageId);
    await pub.publish(c.agencyId, { type: 'message.new', conversationId: conv.id, clientId: c.clientId, messageId: msg.id, direction: 'OUT' });
    await deps.afterSend?.(msg.id);
  }
  await db.socialComment.update({ where: { id: c.id }, data: { privateConversationId: conversationId, status: 'DONE' } });
  return { conversationId };
}

/** Rules for one post come before rules for every post; rules with words before catch-alls. */
const specificity = (r: Rule) => (r.postExternalId ? 0 : 2) + (r.keywords.length ? 0 : 1);

/**
 * A new comment on a client's post: the first comment rule that fits answers it under the post (one of its
 * replies, at random, so the page does not repeat itself word for word) and/or in a private message.
 * Each person gets it once per post, however many times they comment.
 */
export async function runCommentRules(deps: CommentDeps, commentId: string, now = new Date()): Promise<{ ruleId: string; publicReply: boolean; privateReply: boolean; error?: string } | null> {
  const { db, pub } = deps;
  const c = await db.socialComment.findUnique({ where: { id: commentId }, include: { socialAccount: true } });
  if (!c || c.fromPage || c.deletedAt || c.autoRuleId || c.socialAccount.status !== 'CONNECTED') return null;
  if (now.getTime() - c.createdAt.getTime() >= PRIVATE_REPLY_MS) return null;
  const rules = (await db.autoRule.findMany({ where: { clientId: c.clientId, kind: 'COMMENT', enabled: true, platforms: { has: c.platform } }, orderBy: { createdAt: 'asc' } }))
    .filter(r => (!r.postExternalId || r.postExternalId === c.postExternalId) && (!r.keywords.length || matchKeyword(c.body, r.keywords)))
    .sort((a, b) => specificity(a) - specificity(b));
  const rule = rules[0];
  if (!rule) return null;
  const topId = c.parentExternalId ?? c.externalId;
  // A person from the team is answering in this thread right now: leave it to them.
  const person = await db.socialComment.findFirst({ where: { socialAccountId: c.socialAccountId, parentExternalId: topId, fromPage: true, sentById: { not: null }, createdAt: { gt: new Date(now.getTime() - HUMAN_PAUSE_MS) } }, select: { id: true } });
  if (person) return null;
  // Once per person per post, claimed by inserting a row: two comments at the same moment get one reply.
  const author = c.authorId ?? `comment:${c.id}`;
  const claimKey = { socialAccountId: c.socialAccountId, postExternalId: c.postExternalId, authorId: author };
  try { await db.autoCommentClaim.create({ data: { ...claimKey, commentId: c.id } }); }
  catch (e) { if (e instanceof P.PrismaClientKnownRequestError && e.code === 'P2002') return null; throw e; }
  const claimed = await db.socialComment.updateMany({ where: { id: c.id, autoRuleId: null }, data: { autoRuleId: rule.id } });
  if (!claimed.count) { await db.autoCommentClaim.deleteMany({ where: { ...claimKey, commentId: c.id } }); return null; }
  c.autoRuleId = rule.id;

  const errors: string[] = [];
  let publicReply = false, privateReply = false, retry = false;
  const failed = (what: string, e: unknown) => {
    errors.push(`${what}: ${e instanceof GraphError ? e.message : 'تعذر الاتصال بفيسبوك'}`);
    if (!isPermanentSocialError(e)) retry = true;
  };
  const name = c.authorName;
  if (rule.publicReplies.length && !(c.platform === 'INSTAGRAM' && c.isHidden)) {
    const text = fillName(rule.publicReplies[Math.floor(Math.random() * rule.publicReplies.length)]!, name);
    try {
      const externalId = await replyToComment({ platform: c.platform, token: decrypt(c.socialAccount.accessTokenEnc, deps.key), commentId: topId, text }, deps.fetch);
      await db.socialComment.upsert({
        where: { socialAccountId_externalId: { socialAccountId: c.socialAccountId, externalId } },
        create: { agencyId: c.agencyId, clientId: c.clientId, socialAccountId: c.socialAccountId, platform: c.platform, externalId, postExternalId: c.postExternalId, parentExternalId: topId, authorId: c.socialAccount.externalId, body: text, fromPage: true, status: 'DONE', autoRuleId: rule.id },
        update: { autoRuleId: rule.id }
      });
      publicReply = true;
    } catch (e) { failed('الرد تحت الكومنت', e); }
  }
  if (rule.reply && !c.privateReplyAt) {
    try { privateReply = (await sendPrivateReply(deps, c, fillName(rule.reply, name), null)) !== 'already_sent'; }
    catch (e) { failed('الرسالة في الخاص', e); }
  }
  const sent = publicReply || privateReply;
  // Answered: the thread leaves the "to answer" list.
  if (sent) await db.socialComment.updateMany({ where: { socialAccountId: c.socialAccountId, externalId: { in: [c.externalId, topId] } }, data: { status: 'DONE' } });
  else {
    // Nothing went out: free the comment and the person, so a retry (or their next comment) can still be answered.
    await db.socialComment.update({ where: { id: c.id }, data: { autoRuleId: null } });
    await db.autoCommentClaim.deleteMany({ where: { ...claimKey, commentId: c.id } });
  }
  const error = errors.join(' · ').slice(0, 500) || undefined;
  await db.autoRule.update({ where: { id: rule.id }, data: { ...(publicReply || privateReply ? { fired: { increment: 1 }, lastFiredAt: now } : {}), lastError: error ?? null } });
  await pub.publish(c.agencyId, { type: 'comment.updated', commentId: c.id, clientId: c.clientId });
  // A passing problem (network, Meta busy) with nothing sent: throw, so the job runs again later.
  if (!sent && retry) throw new Error(error ?? 'comment rule failed');
  return { ruleId: rule.id, publicReply, privateReply, error };
}
