import type { Db, LeadStage, Prisma } from '@dosly/db';
import { matchKeyword } from '@dosly/shared';

/**
 * A light sales pipeline per customer: new → interested → ordered → won (or lost).
 * People move it by hand from the chat; a price question and the store's orders move it forward on their own,
 * never backwards (someone a moderator marked "won" stays won).
 */
export const STAGE_RANK: Record<LeadStage, number> = { NEW: 0, INTERESTED: 1, ORDERED: 2, WON: 3, LOST: -1 };

/** Questions that mean "I'm interested" in Egyptian chats. */
const INTEREST_WORDS = ['بكام', 'السعر', 'الاسعار', 'سعر', 'كام سعر', 'متاح', 'متوفر', 'عايز اطلب', 'عايزه اطلب', 'ازاي اطلب', 'الحجز', 'احجز', 'price', 'how much'];

async function moveUp(db: Db, contactId: string, to: LeadStage, from: LeadStage[]) {
  await db.contact.updateMany({ where: { id: contactId, stage: { in: from } }, data: { stage: to, stageAt: new Date() } });
}

/** A customer's message: asking about price or availability makes a new person "interested". */
export async function noteInterest(db: Db, contactId: string, body: string | null | undefined) {
  if (body && matchKeyword(body, INTEREST_WORDS)) await moveUp(db, contactId, 'INTERESTED', ['NEW']);
}

/**
 * After an order is linked to a customer or changes: ordered, or won once delivered. If every order they made was
 * cancelled, returned or failed, someone still at "ordered" goes back to "interested" (they did not buy after all).
 * "Won" never moves back.
 */
export async function syncStageFromOrders(db: Db, contactId: string | null | undefined) {
  if (!contactId) return;
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { stageAt: true } });
  if (!contact) return;
  // Live: not cancelled, returned or failed, and the customer (or a moderator) did not say no to it.
  const live = { contactId, status: { notIn: ['CANCELLED', 'RETURNED', 'FAILED'] }, confirm: { not: 'DECLINED' } } satisfies Prisma.StoreOrderWhereInput;
  const newest = await db.storeOrder.findFirst({ where: live, orderBy: { placedAt: 'desc' }, select: { placedAt: true } });
  if (!newest) {
    if (await db.storeOrder.findFirst({ where: { contactId }, select: { id: true } })) await moveUp(db, contactId, 'INTERESTED', ['ORDERED']);
    return;
  }
  // Someone marked "not interested" by hand comes back only with an order placed after that, not an update to an old one.
  const lostToo: LeadStage[] = !contact.stageAt || newest.placedAt > contact.stageAt ? ['LOST'] : [];
  if (await db.storeOrder.findFirst({ where: { ...live, status: 'DELIVERED' }, select: { id: true } })) await moveUp(db, contactId, 'WON', ['NEW', 'INTERESTED', 'ORDERED', ...lostToo]);
  else await moveUp(db, contactId, 'ORDERED', ['NEW', 'INTERESTED', ...lostToo]);
}
