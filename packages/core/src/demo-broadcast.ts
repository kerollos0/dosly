import type { Prisma } from '@dosly/db';
import { DEMO_TEMPLATES, fillName } from '@dosly/shared';
import { messageFor } from './broadcast.js';

/**
 * Demo broadcasts: a weekend offer the café sent last week (with deliveries, reads, replies, a few
 * failures and one person who asked to stop), and one the perfume shop scheduled for tomorrow evening.
 */
type Input = { agencyId: string; ownerId: string; clients: { id: string; kind: string; waNumberId: string }[]; now: Date; tag: string };

const OFFER = DEMO_TEMPLATES.find(t => t.name === 'weekend_offer')!;
const snapshot = { parameterFormat: OFFER.parameter_format ?? 'POSITIONAL', components: OFFER.components } as unknown as Prisma.InputJsonValue;
const REPLIES = ['عايز أعرف أكتر', 'بكام الكومبو؟', 'متاح يوم الجمعة الصبح؟', 'تمام هنعدي عليكم', 'ينفع حجز لـ 6 أفراد؟'];

export async function seedDemoBroadcasts(tx: Prisma.TransactionClient, o: Input) {
  const cafe = o.clients.find(c => c.kind === 'cafe');
  if (cafe) {
    const sentAt = new Date(o.now.getTime() - 6 * 86400_000 - 3 * 3600_000);
    const values = { 'body.1': '[الاسم]', 'body.2': 'كومبو فطار لشخصين بـ 220 جنيه بدل 300', 'body.3': 'الجمعة الساعة 2 الضهر' };
    // Everyone who wrote to the café before the offer went out.
    const people = await tx.contact.findMany({
      where: { clientId: cafe.id, waNumberId: cafe.waNumberId, conversations: { some: { lastInboundAt: { lt: sentAt } } } },
      select: { id: true, name: true, conversations: { select: { id: true }, take: 1 } }, take: 80
    });
    const b = await tx.broadcast.create({ data: {
      agencyId: o.agencyId, clientId: cafe.id, waNumberId: cafe.waNumberId, name: 'عرض فطار الويك إند', templateName: OFFER.name, language: OFFER.language, category: OFFER.category,
      template: snapshot, values, audience: { kind: 'all' }, status: 'DONE', scheduledAt: sentAt, startedAt: sentAt, finishedAt: new Date(sentAt.getTime() + 90_000),
      total: people.length, createdById: o.ownerId, createdAt: new Date(sentAt.getTime() - 3600_000)
    } });
    // A few who replied then ordered cakes online: the "orders from the store" number.
    const store = await tx.storeConnection.findFirst({ where: { clientId: cafe.id }, select: { id: true } });
    const CAKES = [{ name: 'تشيز كيك توت', qty: 1, priceMinor: 42000 }, { name: 'بوكس كرواسون ميكس (6)', qty: 2, priceMinor: 18500 }, { name: 'تورتة شوكولاتة صغيرة', qty: 1, priceMinor: 55000 }];
    let ordered = 0;
    for (const [i, p] of people.entries()) {
      const conv = p.conversations[0];
      if (!conv) continue;
      const m = messageFor({ templateName: OFFER.name, language: OFFER.language, template: snapshot as Prisma.JsonValue, values }, p.name)!;
      const at = new Date(sentAt.getTime() + i * 900);
      const fail = i % 23 === 7 ? { code: 131049, text: '131049: This message was not delivered to maintain healthy ecosystem engagement.' } : i % 31 === 11 ? { code: 131026, text: '131026: Message undeliverable' } : null;
      const status = fail ? 'FAILED' as const : i % 4 === 3 ? 'DELIVERED' as const : 'READ' as const;
      const msg = await tx.message.create({ data: {
        agencyId: o.agencyId, conversationId: conv.id, direction: 'OUT', type: 'template', body: m.rendered.body, status, error: fail?.text ?? null, sentById: o.ownerId,
        waMessageId: `wamid.DEMOBC.${o.tag}.${i}`, createdAt: at,
        payload: { kind: 'template', broadcastId: b.id, template: m.built, rendered: { footer: m.rendered.footer, buttons: m.rendered.buttons } } as Prisma.InputJsonValue
      } });
      const replies = !fail && i % 6 === 1;
      const stop = !fail && i === 4;
      const repliedAt = replies || stop ? new Date(at.getTime() + (20 + i) * 60_000) : null;
      if (repliedAt) {
        const body = stop ? 'إيقاف العروض' : REPLIES[i % REPLIES.length]!;
        await tx.message.create({ data: { agencyId: o.agencyId, conversationId: conv.id, direction: 'IN', type: 'text', body, status: 'RECEIVED', waMessageId: `wamid.DEMOBCIN.${o.tag}.${i}`, createdAt: repliedAt } });
        if (stop) {
          await tx.contact.update({ where: { id: p.id }, data: { marketingOptOutAt: repliedAt } });
          await tx.message.create({ data: { agencyId: o.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: 'تمام، مش هنبعتلك رسايل عروض تاني. لو احتجت أي حاجة ابعتلنا هنا في أي وقت 🙏', status: 'READ', waMessageId: `wamid.DEMOBCSTOP.${o.tag}.${i}`, createdAt: new Date(repliedAt.getTime() + 2000) } });
        } else {
          await tx.message.create({ data: { agencyId: o.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: `أهلًا يا ${fillName('[الاسم]', p.name)}، العرض شغال لحد الجمعة. تحب نحجزلك؟`, status: 'READ', sentById: o.ownerId, waMessageId: `wamid.DEMOBCOUT.${o.tag}.${i}`, createdAt: new Date(repliedAt.getTime() + 6 * 60_000) } });
          if (store && ordered < 3 && i % 12 === 1) {
            const item = CAKES[ordered]!;
            ordered++;
            await tx.storeOrder.create({ data: {
              agencyId: o.agencyId, clientId: cafe.id, storeId: store.id, externalId: `demo-bc-${o.tag}-${i}`, number: `#${1180 + ordered}`, status: 'DELIVERED', currency: 'EGP',
              totalMinor: BigInt(item.qty * item.priceMinor + 3000), shippingMinor: 3000n, customerName: p.name, contactId: p.id, items: [item], confirm: 'NONE',
              placedAt: new Date(repliedAt.getTime() + (2 + ordered) * 3600_000)
            } });
          }
        }
      }
      await tx.broadcastRecipient.create({ data: {
        broadcastId: b.id, contactId: p.id, messageId: msg.id, state: fail ? 'FAILED' : 'SENT', error: fail?.text ?? null, errorCode: fail?.code ?? null,
        attempts: 1, sentAt: at, repliedAt: stop ? null : repliedAt
      } });
    }
  }

  const perfume = o.clients.find(c => c.kind === 'perfume');
  if (perfume) {
    // Tomorrow 7 pm Cairo (UTC+2). The demo ends before then, so it stays "scheduled".
    const d = new Date(o.now.getTime() + 86400_000);
    const at = new Date(`${d.toISOString().slice(0, 10)}T17:00:00Z`);
    const people = await tx.contact.count({ where: { clientId: perfume.id, waNumberId: perfume.waNumberId, conversations: { some: { lastInboundAt: { not: null } } } } });
    await tx.broadcast.create({ data: {
      agencyId: o.agencyId, clientId: perfume.id, waNumberId: perfume.waNumberId, name: 'خصم الجمعة البيضا', templateName: OFFER.name, language: OFFER.language, category: OFFER.category,
      template: snapshot, values: { 'body.1': '[الاسم]', 'body.2': 'خصم 25% على كل البرفانات + شحن مجاني', 'body.3': 'آخر الشهر' }, audience: { kind: 'all' },
      status: 'SCHEDULED', scheduledAt: at, total: people, createdById: o.ownerId, createdAt: new Date(o.now.getTime() - 2 * 3600_000)
    } });
  }
}
