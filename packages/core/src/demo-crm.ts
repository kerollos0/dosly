import type { Prisma } from '@dosly/db';
import { demoAdId } from '@dosly/shared';

/**
 * Demo customers in the pipeline: about a third of WhatsApp chats came from the client's ads, people who
 * asked the price are "interested", store orders make them "ordered" / "bought", a few are "not interested",
 * and some have tags and a note, as a team would leave them after a few weeks.
 */
const TAGS = ['جملة', 'VIP', 'مستني المقاس', 'عايز يرجّع', 'زبون قديم'];
const NOTES = ['بيحب العروض، كلّمه أول ما ينزل جديد', 'عنوانه في مدينة نصر، الشحن عليه 50', 'طلب يتكلّم بعد الساعة 6'];

export async function seedDemoCrm(tx: Prisma.TransactionClient, o: { agencyId: string; now: Date }) {
  const accounts = await tx.adAccount.findMany({ where: { agencyId: o.agencyId }, select: { clientId: true, externalId: true } });
  for (const a of accounts) {
    const people = await tx.contact.findMany({ where: { clientId: a.clientId, waNumberId: { not: null }, adId: null }, select: { id: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    for (const [i, p] of people.entries()) {
      if (i % 3 !== 1) continue;
      await tx.contact.update({ where: { id: p.id }, data: { adId: demoAdId(a.externalId, i % 2 ? '1' : '2', 1), adReferredAt: p.createdAt } });
    }
  }
  const A = o.agencyId;
  await tx.$executeRaw`UPDATE "Contact" SET source = 'ad' WHERE "agencyId" = ${A} AND "adId" IS NOT NULL`;
  await tx.$executeRaw`UPDATE "Contact" c SET stage = 'INTERESTED', "stageAt" = m."createdAt" FROM "Message" m JOIN "Conversation" v ON v.id = m."conversationId"
    WHERE v."contactId" = c.id AND c."agencyId" = ${A} AND m.direction = 'IN' AND m.body ~ '(بكام|السعر|سعر|متاح|كام)'`;
  await tx.$executeRaw`UPDATE "Contact" c SET stage = 'ORDERED', "stageAt" = o."placedAt" FROM "StoreOrder" o
    WHERE o."contactId" = c.id AND c."agencyId" = ${A} AND o.status NOT IN ('CANCELLED', 'RETURNED', 'FAILED')`;
  await tx.$executeRaw`UPDATE "Contact" c SET stage = 'WON' FROM "StoreOrder" o WHERE o."contactId" = c.id AND c."agencyId" = ${A} AND o.status = 'DELIVERED'`;
  // Without a store, some chats still ended in a sale the team marked by hand.
  const rest = await tx.contact.findMany({ where: { agencyId: A, stage: { in: ['NEW', 'INTERESTED'] } }, select: { id: true, stage: true }, orderBy: { createdAt: 'asc' } });
  for (const [i, c] of rest.entries()) {
    const stage = c.stage === 'INTERESTED' && i % 3 === 0 ? 'WON' : i % 7 === 3 ? 'LOST' : null;
    const tags = i % 4 === 0 ? [TAGS[i % TAGS.length]!] : i % 9 === 2 ? [TAGS[i % TAGS.length]!, TAGS[(i + 1) % TAGS.length]!] : [];
    const note = i % 11 === 5 ? NOTES[i % NOTES.length]! : null;
    if (stage || tags.length || note) await tx.contact.update({ where: { id: c.id }, data: { ...(stage && { stage, stageAt: new Date(o.now.getTime() - (i % 5 + 1) * 86400_000) }), tags, note } });
  }
}
