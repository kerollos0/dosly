import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, makeApp, owner, reset } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

type App = Awaited<ReturnType<typeof makeApp>>['app'];

async function setup(approval = true) {
  // The Page token answers /me with its own Page id.
  const { app, calls } = await makeApp((url, init) => url.includes('/me?') ? { id: new Headers(init?.headers).get('authorization')?.endsWith('99999') ? '999' : '111' } : { id: 'ok' });
  const own = await owner(app);
  const client = (await own('POST', '/api/clients', { name: 'كافيه نسمة' })).json();
  const page = (await own('POST', '/api/channels/social', { clientId: client.id, platform: 'FACEBOOK_PAGE', externalId: '111', name: 'Page', accessToken: 'EAAG-page-token-12345' })).json();
  await own('PUT', `/api/clients/${client.id}/portal/settings`, { requiresClientApproval: approval });
  const invite = (await own('POST', `/api/clients/${client.id}/portal/users`, { name: 'طارق حلمي', email: 'Tarek@Cafe.eg' })).json();
  return { app, calls, own, client, page, link: invite.link.url as string };
}

async function consume(app: App, link: string) {
  const token = link.split('#')[1]!;
  const res = await app.inject({ method: 'POST', url: '/api/portal/auth/consume', payload: { token } });
  const cookie = res.cookies.find(c => c.name === 'dosly_portal')?.value;
  const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, cookies: { dosly_portal: cookie ?? '' } });
  return { res, as };
}

const tomorrow = () => new Date(Date.now() + 86400_000).toISOString();

describe('client portal', () => {
  it('signs in once with the link, and portal and agency sessions never cross', async () => {
    const { app, own, link } = await setup();
    expect(link).toMatch(/\/portal\/login#/); // the token rides in the fragment, so it never reaches server logs
    const { res, as } = await consume(app, link);
    expect(res.statusCode).toBe(200);
    expect((await as('GET', '/api/portal/me')).json()).toMatchObject({ user: { name: 'طارق حلمي' }, client: { name: 'كافيه نسمة' }, agency: { name: 'وكالة النيل' } });
    expect((await as('GET', '/api/clients')).statusCode).toBe(401); // a portal cookie is not an agency session
    expect((await own('GET', '/api/portal/me')).statusCode).toBe(401); // and the other way round
    const again = await consume(app, link);
    expect(again.res.statusCode).toBe(401);
  });

  it('holds scheduled posts until the client approves', async () => {
    const { app, own, client, page, link } = await setup();
    const post = (await own('POST', '/api/posts', { clientId: client.id, caption: 'خصم الويك إند', socialAccountIds: [page.id], scheduledAt: tomorrow() })).json();
    expect(post.clientReview).toBe('PENDING');
    expect((await own('POST', `/api/posts/${post.id}/publish-now`)).statusCode).toBe(409);

    const { as } = await consume(app, link);
    const from = new Date(Date.now() - 86400_000).toISOString(), to = new Date(Date.now() + 5 * 86400_000).toISOString();
    const list = (await as('GET', `/api/portal/posts?from=${from}&to=${to}`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('createdById');
    expect((await as('POST', `/api/portal/posts/${post.id}/approve`)).json().clientReview).toBe('APPROVED');
    expect((await own('POST', `/api/posts/${post.id}/publish-now`)).statusCode).toBe(200);
  });

  it('sends a post back for review after the agency edits what the client asked to change', async () => {
    const { app, own, client, page, link } = await setup();
    const post = (await own('POST', '/api/posts', { clientId: client.id, caption: 'مواعيدنا', socialAccountIds: [page.id], scheduledAt: tomorrow() })).json();
    const { as } = await consume(app, link);
    expect((await as('POST', `/api/portal/posts/${post.id}/request-changes`, { note: 'كبّروا الأرقام' })).statusCode).toBe(200);
    const audit = (await own('GET', '/api/audit')).json();
    expect(JSON.stringify(audit)).toContain('post.client_changes');
    const edited = (await own('PATCH', `/api/posts/${post.id}`, { caption: 'مواعيدنا الجديدة بالأرقام الكبيرة' })).json();
    expect(edited.clientReview).toBe('PENDING');
  });

  it('hides drafts and other clients\' posts from the portal', async () => {
    const { app, own, client, page, link } = await setup();
    const other = (await own('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
    const otherPage = (await own('POST', '/api/channels/social', { clientId: other.id, platform: 'FACEBOOK_PAGE', externalId: '999', name: 'P2', accessToken: 'EAAG-page-token-99999' })).json();
    const foreign = (await own('POST', '/api/posts', { clientId: other.id, caption: 'x', socialAccountIds: [otherPage.id], scheduledAt: tomorrow() })).json();
    await own('POST', '/api/posts', { clientId: client.id, caption: 'draft', socialAccountIds: [page.id] });
    const { as } = await consume(app, link);
    const from = new Date(Date.now() - 86400_000).toISOString(), to = new Date(Date.now() + 5 * 86400_000).toISOString();
    expect((await as('GET', `/api/portal/posts?from=${from}&to=${to}`)).json()).toHaveLength(0);
    expect((await as('POST', `/api/portal/posts/${foreign.id}/approve`)).statusCode).toBe(404);
  });

  it('reports posts, conversations and response time for the month', async () => {
    const { app, own, client, link } = await setup(false);
    const num = await db.whatsAppNumber.create({ data: { agencyId: client.agencyId, clientId: client.id, phoneNumberId: 'pn1', wabaId: 'w', displayPhone: '+20', accessTokenEnc: 'x' } });
    const contact = await db.contact.create({ data: { agencyId: client.agencyId, clientId: client.id, waNumberId: num.id, waId: '2010' } });
    const conv = await db.conversation.create({ data: { agencyId: client.agencyId, clientId: client.id, waNumberId: num.id, contactId: contact.id } });
    const t = (min: number) => new Date(Date.now() - 60 * 60_000 + min * 60_000);
    await db.message.createMany({ data: [
      { agencyId: client.agencyId, conversationId: conv.id, direction: 'IN', type: 'text', body: 'سعر؟', status: 'RECEIVED', createdAt: t(0) },
      { agencyId: client.agencyId, conversationId: conv.id, direction: 'IN', type: 'text', body: 'لو سمحت', status: 'RECEIVED', createdAt: t(1) },
      { agencyId: client.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: '100', status: 'READ', createdAt: t(4) },
      { agencyId: client.agencyId, conversationId: conv.id, direction: 'IN', type: 'text', body: 'تمام', status: 'RECEIVED', createdAt: t(10) },
      { agencyId: client.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: '🙏', status: 'READ', createdAt: t(12) }
    ] });
    const { as } = await consume(app, link);
    const r = (await as('GET', '/api/portal/report')).json();
    expect(r.inbox).toMatchObject({ newConversations: 1, inbound: 3, outbound: 2, customerTurns: 2, answered: 2, medianFirstResponseSec: 180 });
    expect((await own('GET', `/api/clients/${client.id}/report`)).json().inbox.inbound).toBe(3);
  });
});
