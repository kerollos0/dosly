import type { Db } from '@dosly/db';
import { parseWebhook } from '@dosly/shared';
import type { Publisher } from './events.js';

const STATUS_RANK = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4, RECEIVED: 0 } as const;
const MAP = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const;

/**
 * Applies one WhatsApp webhook payload: creates contacts, conversations and inbound messages,
 * and moves outbound message statuses forward. Safe to run twice on the same payload.
 */
export async function processWhatsAppWebhook(db: Db, payload: unknown, pub: Publisher): Promise<{ messages: number; statuses: number; unknownNumbers: string[] }> {
  const { messages, statuses } = parseWebhook(payload as Record<string, unknown>);
  const unknown = new Set<string>();
  let stored = 0;

  for (const m of messages) {
    const num = await db.whatsAppNumber.findUnique({ where: { phoneNumberId: m.phoneNumberId } });
    if (!num) { unknown.add(m.phoneNumberId); continue; }
    if (await db.message.findUnique({ where: { waMessageId: m.waMessageId } })) continue;

    const contact = await db.contact.upsert({
      where: { waNumberId_waId: { waNumberId: num.id, waId: m.waId } },
      create: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, waId: m.waId, name: m.contactName },
      update: m.contactName ? { name: m.contactName } : {}
    });
    const preview = (m.body ?? `[${m.type}]`).slice(0, 140);
    const conv = await db.conversation.upsert({
      where: { waNumberId_contactId: { waNumberId: num.id, contactId: contact.id } },
      create: { agencyId: num.agencyId, clientId: num.clientId, waNumberId: num.id, contactId: contact.id, lastMessageAt: m.timestamp, lastInboundAt: m.timestamp, unreadCount: 1, lastPreview: preview },
      update: { lastMessageAt: m.timestamp, lastInboundAt: m.timestamp, unreadCount: { increment: 1 }, lastPreview: preview, status: 'OPEN' }
    });
    const msg = await db.message.create({
      data: { agencyId: num.agencyId, conversationId: conv.id, direction: 'IN', type: m.type, body: m.body, mediaId: m.mediaId, waMessageId: m.waMessageId, status: 'RECEIVED', createdAt: m.timestamp }
    });
    stored++;
    await pub.publish(num.agencyId, { type: 'message.new', conversationId: conv.id, clientId: num.clientId, messageId: msg.id });
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

  return { messages: stored, statuses: updated, unknownNumbers: [...unknown] };
}
