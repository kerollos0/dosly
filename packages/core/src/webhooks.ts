import type { Db } from '@dosly/db';
import { errorCodeOf, isStopRequest, parseWebhook } from '@dosly/shared';
import type { Publisher } from './events.js';
import { previewText } from './media.js';
import { applyTemplateUpdates } from './templates.js';
import { applyConfirmReply } from './orders.js';
import { noteBroadcastInbound } from './broadcast.js';
import { autoReplyToMessage } from './autoreply.js';
import { noteInterest, syncStageFromOrders } from './crm.js';

const NO_AUTO_TYPES = new Set(['reaction', 'system', 'unsupported', 'interactive', 'button', 'order', 'request_welcome', 'ephemeral', 'errors']);
const STATUS_RANK = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4, RECEIVED: 0 } as const;
const MAP = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const;

/**
 * Applies one WhatsApp webhook payload: creates contacts, conversations and inbound messages,
 * and moves outbound message statuses forward. Safe to run twice on the same payload.
 */
export type WebhookHooks = {
  /** Called for each new inbound attachment; the worker downloads it from Meta. */
  onMedia?: (messageId: string) => Promise<void>;
  /** Queues an outbound message for the worker (the thank-you after an order confirmation). */
  onSend?: (messageId: string) => Promise<void>;
};

export async function processWhatsAppWebhook(db: Db, payload: unknown, pub: Publisher, hooks: WebhookHooks = {}): Promise<{ messages: number; statuses: number; templates: number; unknownNumbers: string[] }> {
  const { messages, statuses, templates } = parseWebhook(payload as Record<string, unknown>);
  const unknown = new Set<string>();
  let stored = 0;

  for (const m of messages) {
    const num = await db.whatsAppNumber.findUnique({ where: { phoneNumberId: m.phoneNumberId } });
    if (!num) { unknown.add(m.phoneNumberId); continue; }
    if (await db.message.findUnique({ where: { waMessageId: m.waMessageId } })) continue;

    const contact = await db.contact.upsert({
      where: { waNumberId_waId: { waNumberId: num.id, waId: m.waId } },
      create: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, waId: m.waId, name: m.contactName, ...(m.referral ? { adId: m.referral.sourceId.slice(0, 64), adReferredAt: m.timestamp, source: 'ad' } : {}) },
      update: {
        ...(m.contactName ? { name: m.contactName } : {}),
        // Click-to-WhatsApp: remember the latest ad the customer came from, so their orders count for it.
        ...(m.referral ? { adId: m.referral.sourceId.slice(0, 64), adReferredAt: m.timestamp, source: 'ad' } : {})
      }
    });
    const preview = previewText(m.type, m.body, m.media?.voice);
    const conv = await db.conversation.upsert({
      where: { waNumberId_contactId: { waNumberId: num.id, contactId: contact.id } },
      create: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, contactId: contact.id, lastMessageAt: m.timestamp, lastInboundAt: m.timestamp, unreadCount: 1, lastPreview: preview },
      update: { lastMessageAt: m.timestamp, lastInboundAt: m.timestamp, unreadCount: { increment: 1 }, lastPreview: preview, status: 'OPEN' }
    });
    const msg = await db.message.create({
      data: {
        agencyId: num.agencyId, conversationId: conv.id, direction: 'IN', type: m.type, body: m.body, waMessageId: m.waMessageId, status: 'RECEIVED', createdAt: m.timestamp,
        ...(m.media && { mediaId: m.media.id, mediaStatus: 'PENDING' as const, mediaMime: m.media.mime, mediaSha256: m.media.sha256, fileName: m.media.fileName, voice: !!m.media.voice })
      }
    });
    stored++;
    await pub.publish(num.agencyId, { type: 'message.new', conversationId: conv.id, clientId: num.clientId, messageId: msg.id, direction: 'IN' });
    if (m.media) await hooks.onMedia?.(msg.id);
    // Orders placed with this phone before the customer ever wrote are linked to the chat now.
    const linked = await db.storeOrder.updateMany({ where: { clientId: num.clientId, waId: m.waId, contactId: null }, data: { contactId: contact.id } });
    if (linked.count) await syncStageFromOrders(db, contact.id);
    await noteInterest(db, contact.id, m.body);
    const stopped = await noteBroadcastInbound(db, contact.id, m.body, m.timestamp);
    if (stopped) {
      // "إيقاف": they asked for no more offers. Saying so in the chat is allowed (they just wrote) and expected.
      const text = 'تمام، مش هنبعتلك رسايل عروض تاني. لو احتجت أي حاجة ابعتلنا هنا في أي وقت 🙏';
      const out = await db.message.create({ data: { agencyId: num.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: text, status: 'QUEUED', payload: { kind: 'text', optOut: true } } });
      await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date(), lastPreview: text.slice(0, 140) } });
      await pub.publish(num.agencyId, { type: 'message.new', conversationId: conv.id, clientId: num.clientId, messageId: out.id, direction: 'OUT' });
      await hooks.onSend?.(out.id);
    }
    if (m.buttonPayload || m.contextId) {
      await applyConfirmReply({ db, pub, onSend: hooks.onSend }, { agencyId: num.agencyId, clientId: num.clientId, conversationId: conv.id, contactId: contact.id, buttonPayload: m.buttonPayload, contextId: m.contextId, body: m.body, at: m.timestamp });
    }
    // No automatic reply on top of: a button press or a quoted answer to something we sent (an order, an offer),
    // a stop request, or things that aren't a message to answer (reactions, system notices).
    if (!stopped && !m.buttonPayload && !m.contextId && !isStopRequest(m.body) && !NO_AUTO_TYPES.has(m.type)) {
      await autoReplyToMessage(db, pub, hooks.onSend, { conversationId: conv.id, body: m.body, at: m.timestamp });
    }
  }

  let updated = 0;
  for (const s of statuses) {
    const msg = await db.message.findUnique({ where: { waMessageId: s.waMessageId } });
    if (!msg || msg.direction !== 'OUT') continue;
    const next = MAP[s.status];
    if (!next || STATUS_RANK[next] <= STATUS_RANK[msg.status]) continue; // webhooks arrive out of order
    await db.message.update({ where: { id: msg.id }, data: { status: next, error: s.error ?? null } });
    const broadcastId = (msg.payload as { broadcastId?: string } | null)?.broadcastId;
    if (broadcastId) {
      // Only a failure changes what the page must show now; delivered / read numbers are picked up by its polling.
      if (next === 'FAILED') {
        await db.broadcastRecipient.updateMany({ where: { messageId: msg.id }, data: { state: 'FAILED', error: s.error ?? null, errorCode: errorCodeOf(s.error) } });
        await pub.publish(msg.agencyId, { type: 'broadcast.updated', broadcastId });
      }
    }
    // 131050: the person stopped marketing messages from this business. Never offer them anything again.
    if (next === 'FAILED' && errorCodeOf(s.error) === 131050) {
      const conv = await db.conversation.findUnique({ where: { id: msg.conversationId }, select: { contactId: true } });
      if (conv) await db.contact.updateMany({ where: { id: conv.contactId, marketingOptOutAt: null }, data: { marketingOptOutAt: s.timestamp } });
    }
    updated++;
    await pub.publish(msg.agencyId, { type: 'message.status', conversationId: msg.conversationId, messageId: msg.id, status: next });
  }

  if (templates.length) await applyTemplateUpdates(db, templates, pub);
  return { messages: stored, statuses: updated, templates: templates.length, unknownNumbers: [...unknown] };
}
