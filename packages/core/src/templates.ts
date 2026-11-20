import type { Db, Prisma } from '@dosly/db';
import { decrypt, listTemplates, type TemplateStatusUpdate } from '@dosly/shared';
import type { Publisher } from './events.js';

/** Copies a number's templates from its WhatsApp Business Account. Templates removed on Meta are removed here. */
export async function syncTemplates(db: Db, key: Buffer, waNumberId: string, pub: Publisher, fetchImpl?: typeof fetch) {
  const num = await db.whatsAppNumber.findUniqueOrThrow({ where: { id: waNumberId } });
  const list = await listTemplates({ wabaId: num.wabaId, token: decrypt(num.accessTokenEnc, key) }, fetchImpl);
  const now = new Date();
  await db.$transaction(async tx => {
    for (const t of list) {
      const data = { metaId: String(t.id), category: t.category, status: t.status, parameterFormat: (t.parameter_format ?? 'POSITIONAL').toUpperCase(), components: t.components as unknown as Prisma.InputJsonValue, syncedAt: now };
      await tx.waTemplate.upsert({
        where: { waNumberId_name_language: { waNumberId, name: t.name, language: t.language } },
        create: { agencyId: num.agencyId, waNumberId, name: t.name, language: t.language, ...data },
        update: data
      });
    }
    await tx.waTemplate.deleteMany({ where: { waNumberId, syncedAt: { lt: now } } });
    await tx.whatsAppNumber.update({ where: { id: waNumberId }, data: { templatesSyncedAt: now } });
  });
  await pub.publish(num.agencyId, { type: 'templates.updated', waNumberId });
  return list.length;
}

/** Meta's template webhook events that change whether a template can be sent. */
const STATUS_OF: Record<string, string> = {
  APPROVED: 'APPROVED', REINSTATED: 'APPROVED', UNARCHIVED: 'APPROVED', PENDING: 'PENDING', IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED', PAUSED: 'PAUSED', DISABLED: 'DISABLED', LOCKED: 'LOCKED', ARCHIVED: 'ARCHIVED', LIMIT_EXCEEDED: 'LIMIT_EXCEEDED'
};

/** Applies message_template_status_update webhooks. FLAGGED only warns about quality, so the status stays. */
export async function applyTemplateUpdates(db: Db, updates: TemplateStatusUpdate[], pub: Publisher) {
  for (const u of updates) {
    const rows = await db.waTemplate.findMany({ where: { metaId: u.metaId }, select: { id: true, agencyId: true, waNumberId: true } });
    if (!rows.length) continue;
    if (u.event === 'DELETED' || u.event === 'PENDING_DELETION') await db.waTemplate.deleteMany({ where: { metaId: u.metaId } });
    else {
      const status = STATUS_OF[u.event];
      await db.waTemplate.updateMany({ where: { metaId: u.metaId }, data: { ...(status ? { status } : {}), reason: u.reason && u.reason !== 'NONE' ? u.reason : null } });
    }
    for (const r of rows) await pub.publish(r.agencyId, { type: 'templates.updated', waNumberId: r.waNumberId });
  }
}
