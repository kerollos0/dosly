import type { FastifyPluginAsync } from 'fastify';
import { connectSocialSchema, connectWhatsAppSchema, encrypt, graph, GraphError, subscribePage } from '@dosly/shared';
import { assertClientAccess, audit, HttpError, requireAuth, requirePermission } from '../auth.js';

export const channelRoutes: FastifyPluginAsync = async app => {
  const { db, key, env } = app.deps;
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
    // One Page or Instagram account belongs to one agency: its webhooks (customer messages, comments) go to that agency only.
    const taken = await db.socialAccount.findFirst({ where: { platform: input.platform, externalId: input.externalId, agencyId: { not: auth.agencyId } } });
    if (taken) throw new HttpError(409, 'الصفحة دي متربطة بوكالة تانية على دوسلي. لازم تتشال من هناك الأول.', 'account_taken');
    // Any token can read a public Page's id, so the token itself must be the Page's (or the Page linked to the Instagram account).
    let owner: { id?: string; instagram_business_account?: { id?: string } };
    try {
      owner = await graph(`me?fields=id,instagram_business_account`, input.accessToken, {}, f);
    } catch (e) {
      throw new HttpError(400, `Meta رفضت البيانات: ${(e as GraphError).message}`, 'meta_rejected');
    }
    const ownId = input.platform === 'INSTAGRAM' ? owner.instagram_business_account?.id : owner.id;
    if (env.DEMO_MODE !== 'true' && ownId !== input.externalId) {
      throw new HttpError(400, input.platform === 'INSTAGRAM' ? 'التوكن ده مش بتاع الصفحة المربوط بيها حساب الإنستجرام ده' : 'التوكن ده مش Page token بتاع الصفحة دي', 'not_owner');
    }
    const where = { agencyId_platform_externalId: { agencyId: auth.agencyId, platform: input.platform, externalId: input.externalId } };
    const data = { clientId: input.clientId, name: input.name, accessTokenEnc: encrypt(input.accessToken, key), status: 'CONNECTED' as const };
    const acc = await db.socialAccount.upsert({ where, create: { ...data, agencyId: auth.agencyId, platform: input.platform, externalId: input.externalId }, update: data });
    let webhooks = true;
    {
      // Comments and messages only flow once the app is installed on the Page (for Instagram: the Page the
      // account is linked to; its Instagram fields are set in the App Dashboard). Publishing works either way.
      const pageId = acc.platform === 'FACEBOOK_PAGE' ? acc.externalId : owner.id;
      try { if (!pageId) throw new Error('No Page behind this token'); await subscribePage({ pageId, token: input.accessToken }, f); }
      catch (e) {
        req.log.warn({ err: (e as Error).message, accountId: acc.id }, 'Page webhook subscription failed');
        webhooks = false;
      }
    }
    await audit(db, auth, 'channel.social.connect', 'SocialAccount', acc.id, { platform: acc.platform, name: acc.name });
    return reply.status(201).send({ id: acc.id, platform: acc.platform, name: acc.name, webhooks });
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
