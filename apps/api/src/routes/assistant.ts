import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AI_KNOWLEDGE_MAX, Anthropic, aiDraft, AiNotFound, AiNotReady, aiTry, pickEngine } from '@dosly/core';
import { assertClientAccess, audit, HttpError, requirePermission } from '../auth.js';

const CHANNELS = ['WHATSAPP', 'MESSENGER', 'INSTAGRAM'] as const;
const settings = z.object({
  clientId: z.string().min(1),
  mode: z.enum(['OFF', 'SUGGEST', 'AUTO'], 'اختار المساعد يشتغل إزاي'),
  channels: z.array(z.enum(CHANNELS, 'القناة مش معروفة')).max(3, 'اختار من القنوات المتاحة بس').default([]),
  knowledge: z.string().trim().max(AI_KNOWLEDGE_MAX, `المعلومات طويلة أوي، خليها أقل من ${AI_KNOWLEDGE_MAX.toLocaleString('ar-EG')} حرف`)
}).refine(s => s.mode === 'OFF' || s.knowledge.length >= 30, { message: 'اكتب معلومات كفاية عن النشاط (المنتجات، الأسعار، التوصيل) عشان المساعد يعرف يرد', path: ['knowledge'] })
  .refine(s => s.mode !== 'AUTO' || s.channels.length > 0, { message: 'اختار قناة واحدة على الأقل يرد عليها لوحده', path: ['channels'] });
const tryBody = z.object({
  clientId: z.string().min(1),
  knowledge: z.string().trim().min(1, 'اكتب معلومات عن النشاط الأول').max(AI_KNOWLEDGE_MAX, 'المعلومات طويلة أوي، قصّرها شوية'),
  question: z.string().trim().min(1, 'اكتب سؤال زي ما الزبون هيكتبه').max(500, 'السؤال طويل، قصّره شوية')
});

/** Turns an Anthropic API failure into a sentence the team can act on. */
function aiError(e: unknown): never {
  if (e instanceof AiNotFound) throw new HttpError(404, e.message, 'not_found');
  if (e instanceof AiNotReady) throw new HttpError(409, e.message, 'ai_not_ready');
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'المساعد عليه ضغط دلوقتي، جرّب كمان دقيقة', 'ai_busy');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'المساعد واقف عندنا، كلّم دعم دوسلي', 'ai_key');
  if (e instanceof Anthropic.BadRequestError) throw new HttpError(400, 'المساعد مقدرش يقرا الرسالة دي. اكتب الرد انت.', 'ai_bad_request');
  if (e instanceof Anthropic.APIError) throw new HttpError(502, 'المساعد مش متاح دلوقتي، جرّب تاني بعد شوية', 'ai_down');
  throw e;
}

/**
 * The client's AI assistant: what it knows about the business, whether it only drafts replies or answers on its own,
 * a test box, and drafts in the inbox.
 */
export const assistantRoutes: FastifyPluginAsync = async app => {
  const { db } = app.deps;
  const engine = app.deps.ai ?? pickEngine(app.deps.env);

  app.get('/assistant', async req => {
    const auth = requirePermission(req, 'automations:manage');
    const { clientId } = z.object({ clientId: z.string().min(1) }).parse(req.query);
    await assertClientAccess(db, auth, clientId);
    const a = await db.aiAssistant.findUnique({ where: { clientId } });
    return {
      engine: engine.name,
      assistant: a && { mode: a.mode, channels: a.channels, knowledge: a.knowledge, suggested: a.suggested, autoSent: a.autoSent, handoffs: a.handoffs, lastError: a.lastError, updatedAt: a.updatedAt }
    };
  });

  app.put('/assistant', async req => {
    const auth = requirePermission(req, 'automations:manage');
    const s = settings.parse(req.body);
    await assertClientAccess(db, auth, s.clientId);
    const data = { mode: s.mode, channels: [...new Set(s.channels)], knowledge: s.knowledge, updatedById: auth.userId };
    const before = await db.aiAssistant.findUnique({ where: { clientId: s.clientId }, select: { mode: true } });
    await db.aiAssistant.upsert({ where: { clientId: s.clientId }, create: { agencyId: auth.agencyId, clientId: s.clientId, ...data }, update: data });
    if (before?.mode !== s.mode) await audit(db, auth, 'assistant.mode', 'Client', s.clientId, { from: before?.mode ?? null, to: s.mode });
    return { ok: true };
  });

  // Each try is a real model call when a key is set, so it is limited.
  app.post('/assistant/try', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'automations:manage');
    const b = tryBody.parse(req.body);
    await assertClientAccess(db, auth, b.clientId);
    const client = await db.client.findUniqueOrThrow({ where: { id: b.clientId }, select: { name: true } });
    try { return await aiTry(engine, client.name, b.knowledge, b.question); } catch (e) { aiError(e); }
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/ai-draft', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const auth = requirePermission(req, 'inbox:reply');
    const conv = await db.conversation.findFirst({ where: { id: req.params.id, agencyId: auth.agencyId }, select: { id: true, clientId: true } });
    if (!conv) throw new HttpError(404, 'المحادثة مش موجودة', 'not_found');
    await assertClientAccess(db, auth, conv.clientId);
    try { return await aiDraft(db, engine, conv.id); } catch (e) { aiError(e); }
  });
};
