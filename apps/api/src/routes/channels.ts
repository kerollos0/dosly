import type { FastifyPluginAsync } from 'fastify';
import { connectSocialSchema, connectWhatsAppSchema, encrypt, graph, GraphError } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission } from '../auth.js';

export const channelRoutes: FastifyPluginAsync = async app => {
  const { db, key } = app.deps;
  const f = app.deps.fetch;

  app.get('/channels', async req => {
    const auth = requireAuth(req);
    const [whatsapp, social] = await Promise.all([
      db.whatsAppNumber.findMany({ where: { agencyId: auth.agencyId }, select: { id: true, clientId: true, displayPhone: true, verifiedName: true, status: true, phoneNumberId: true } }),
      db.socialAccount.findMany({ where: { agencyId: auth.agencyId }, select: { id: true, clientId: true, platform: true, name: true, externalId: true, status: true } })
    ]);
    return { whatsapp, social };
  });

  // The token is checked against Meta before it is stored, then kept encrypted and never returned.
  app.post('/channels/whatsapp', async (req, reply) => {
    const auth = requirePermission(req, 'channels:manage');
    const input = connectWhatsAppSchema.parse(req.body);
    await assertClientAccess(db, auth, input.clientId);
    const taken = await db.whatsAppNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId } });
    if (taken && taken.agencyId !== auth.agencyId) throw new HttpError(409, 'الرقم ده متربط بحساب تاني', 'number_taken');
    let info: { display_phone_number: string; verified_name?: string };
    try {
      info = await graph(`${input.phoneNumberId}?fields=display_phone_number,verified_name`, input.accessToken, {}, f);
    } catch (e) {
      throw new HttpError(400, `Meta رفضت البيانات: ${(e as GraphError).message}`, 'meta_rejected');
    }
    const data = { agencyId: auth.agencyId, clientId: input.clientId, wabaId: input.wabaId, displayPhone: info.display_phone_number, verifiedName: info.verified_name, accessTokenEnc: encrypt(input.accessToken, key), status: 'CONNECTED' as const };
    const num = await db.whatsAppNumber.upsert({ where: { phoneNumberId: input.phoneNumberId }, create: { ...data, phoneNumberId: input.phoneNumberId }, update: data });
    await audit(db, auth, 'channel.whatsapp.connect', 'WhatsAppNumber', num.id, { displayPhone: num.displayPhone });
    return reply.status(201).send({ id: num.id, displayPhone: num.displayPhone, verifiedName: num.verifiedName });
  });

  app.post('/channels/social', async (req, reply) => {
    const auth = requirePermission(req, 'channels:manage');
    const input = connectSocialSchema.parse(req.body);
    await assertClientAccess(db, auth, input.clientId);
    try {
      await graph(`${input.externalId}?fields=id`, input.accessToken, {}, f);
    } catch (e) {
      throw new HttpError(400, `Meta رفضت البيانات: ${(e as GraphError).message}`, 'meta_rejected');
    }
    const where = { agencyId_platform_externalId: { agencyId: auth.agencyId, platform: input.platform, externalId: input.externalId } };
    const data = { clientId: input.clientId, name: input.name, accessTokenEnc: encrypt(input.accessToken, key), status: 'CONNECTED' as const };
    const acc = await db.socialAccount.upsert({ where, create: { ...data, agencyId: auth.agencyId, platform: input.platform, externalId: input.externalId }, update: data });
    await audit(db, auth, 'channel.social.connect', 'SocialAccount', acc.id, { platform: acc.platform, name: acc.name });
    return reply.status(201).send({ id: acc.id, platform: acc.platform, name: acc.name });
  });

  app.delete<{ Params: { kind: string; id: string } }>('/channels/:kind/:id', async req => {
    const auth = requirePermission(req, 'channels:manage');
    const where = { id: req.params.id, agencyId: auth.agencyId };
    const res = req.params.kind === 'whatsapp' ? await db.whatsAppNumber.deleteMany({ where }) : req.params.kind === 'social' ? await db.socialAccount.deleteMany({ where }) : { count: 0 };
    if (!res.count) throw new HttpError(404, 'القناة مش موجودة', 'not_found');
    await audit(db, auth, `channel.${req.params.kind}.disconnect`, 'Channel', req.params.id);
    return { ok: true };
  });
};
