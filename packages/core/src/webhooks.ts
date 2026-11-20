import type { Db } from '@dosly/db';
import { parseWebhook } from '@dosly/shared';
import type { Publisher } from './events.js';
import { previewText } from './media.js';
import { applyTemplateUpdates } from './templates.js';
import { applyConfirmReply } from './orders.js';

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
      create: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, waId: m.waId, name: m.contactName, ...(m.referral ? { adId: m.referral.sourceId.slice(0, 64), adReferredAt: m.timestamp } : {}) },
      update: {
        ...(m.contactName ? { name: m.contactName } : {}),
        // Click-to-WhatsApp: remember the latest ad the customer came from, so their orders count for it.
        ...(m.referral ? { adId: m.referral.sourceId.slice(0, 64), adReferredAt: m.timestamp } : {})
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
    await db.storeOrder.updateMany({ where: { clientId: num.clientId, waId: m.waId, contactId: null }, data: { contactId: contact.id } });
    if (m.buttonPayload || m.contextId) {
      await applyConfirmReply({ db, pub, onSend: hooks.onSend }, { agencyId: num.agencyId, clientId: num.clientId, conversationId: conv.id, contactId: contact.id, buttonPayload: m.buttonPayload, contextId: m.contextId, body: m.body, at: m.timestamp });
    }
  }

  let updated = 0;
  for (const s of statuses) {
    const msg = await db.message.findUnique({ where: { waMessageId: s.waMessageId } });
    if (!msg || msg.direction !== 'OUT') continue;
    const next = MAP[s.status];
    if (!next || STATUS_RANK[next] <= STATUS_RANK[msg.status]) continue; // webhooks arrive out of order
    await db.message.update({ where: { id: msg.id }, data: { status: next, error: s.error ?? null } });
    updated++;
    await pub.publish(msg.agencyId, { type: 'message.status', conversationId: msg.conversationId, messageId: msg.id, status: next });
  }

  if (templates.length) await applyTemplateUpdates(db, templates, pub);
  return { messages: stored, statuses: updated, templates: templates.length, unknownNumbers: [...unknown] };
}
