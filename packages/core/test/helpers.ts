import { createDb } from '@dosly/db';
import { encrypt } from '@dosly/shared';
import { randomBytes } from 'node:crypto';

export const db = createDb();
export const key = randomBytes(32);

export async function reset() {
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`);
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(',')} CASCADE`);
}

export async function fixture() {
  const agency = await db.agency.create({ data: { name: 'وكالة تجربة', slug: `a-${randomBytes(4).toString('hex')}` } });
  const user = await db.user.create({ data: { email: `u${randomBytes(4).toString('hex')}@x.test`, name: 'Owner', passwordHash: 'x' } });
  const client = await db.client.create({ data: { agencyId: agency.id, name: 'مطعم الريس' } });
  const num = await db.whatsAppNumber.create({ data: { agencyId: agency.id, clientId: client.id, phoneNumberId: '1445980835268017', wabaId: '1', displayPhone: '+1 555 149 7547', accessTokenEnc: encrypt('token', key) } });
  return { agency, user, client, num };
}
