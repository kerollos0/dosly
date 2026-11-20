import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '@dosly/shared';
import { overduePosts, processWhatsAppWebhook, publishPost, type RealtimeEvent } from '../src/index.js';
import { db, fixture, key, reset } from './helpers.js';

const events: RealtimeEvent[] = [];
const pub = { publish: (_a: string, e: RealtimeEvent) => { events.push(e); } };

const inbound = (id: string, body: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1445980835268017' },
    contacts: [{ wa_id: '201116123614', profile: { name: 'كيرلس' } }],
    messages: [{ from: '201116123614', id, timestamp: '1763600000', type: 'text', text: { body } }]
  } }] }]
});

beforeEach(async () => { await reset(); events.length = 0; });
afterAll(() => db.$disconnect());

describe('processWhatsAppWebhook', () => {
  it('creates a conversation once and ignores duplicate deliveries', async () => {
    const { num } = await fixture();
    expect((await processWhatsAppWebhook(db, inbound('wamid.1', 'عايز أعرف السعر'), pub)).messages).toBe(1);
    expect((await processWhatsAppWebhook(db, inbound('wamid.1', 'عايز أعرف السعر'), pub)).messages).toBe(0);
    await processWhatsAppWebhook(db, inbound('wamid.2', 'لسه مستني'), pub);
    const convs = await db.conversation.findMany({ include: { contact: true } });
    expect(convs).toHaveLength(1);
    expect(convs[0]!.unreadCount).toBe(2);
    expect(convs[0]!.lastPreview).toBe('لسه مستني');
    expect(convs[0]!.contact.name).toBe('كيرلس');
    expect(convs[0]!.waNumberId).toBe(num.id);
    expect(events.filter(e => e.type === 'message.new')).toHaveLength(2);
  });

  it('reports numbers that belong to no agency', async () => {
    const payload = inbound('wamid.9', 'hi');
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = '999';
    expect((await processWhatsAppWebhook(db, payload, pub)).unknownNumbers).toEqual(['999']);
  });

  it('only moves outbound statuses forward', async () => {
    await fixture();
    await processWhatsAppWebhook(db, inbound('wamid.1', 'hi'), pub);
    const conv = await db.conversation.findFirstOrThrow();
    await db.message.create({ data: { agencyId: conv.agencyId, conversationId: conv.id, direction: 'OUT', type: 'text', body: 'أهلا', waMessageId: 'wamid.out', status: 'SENT' } });
    const status = (s: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1445980835268017' }, statuses: [{ id: 'wamid.out', status: s, timestamp: '1763600100' }] } }] }] });
    await processWhatsAppWebhook(db, status('read'), pub);
    await processWhatsAppWebhook(db, status('delivered'), pub); // late, must not downgrade
    expect((await db.message.findUniqueOrThrow({ where: { waMessageId: 'wamid.out' } })).status).toBe('READ');
  });
});

describe('publishPost', () => {
  async function scheduledPost() {
    const { agency, user, client } = await fixture();
    const fb = await db.socialAccount.create({ data: { agencyId: agency.id, clientId: client.id, platform: 'FACEBOOK_PAGE', externalId: '111', name: 'Page', accessTokenEnc: encrypt('page-token', key) } });
    const ig = await db.socialAccount.create({ data: { agencyId: agency.id, clientId: client.id, platform: 'INSTAGRAM', externalId: '222', name: 'IG', accessTokenEnc: encrypt('ig-token', key) } });
    return db.post.create({ data: { agencyId: agency.id, clientId: client.id, createdById: user.id, caption: 'عرض الجمعة', mediaUrls: ['https://cdn.test/a.jpg'], scheduledAt: new Date(), status: 'SCHEDULED', targets: { create: [{ socialAccountId: fb.id }, { socialAccountId: ig.id }] } } });
  }

  it('publishes to every target with decrypted tokens', async () => {
    const post = await scheduledPost();
    const calls: string[] = [];
    const status = await publishPost(db, post.id, key, pub, {
      facebook: async o => { calls.push(`fb:${o.token}`); return 'fb_1'; },
      instagram: async o => { calls.push(`ig:${o.token}`); return 'ig_1'; }
    });
    expect(status).toBe('PUBLISHED');
    expect(calls.sort()).toEqual(['fb:page-token', 'ig:ig-token']);
  });

  it('holds a post the client has not approved, and the sweep skips it', async () => {
    const post = await scheduledPost();
    await db.post.update({ where: { id: post.id }, data: { clientReview: 'PENDING', scheduledAt: new Date(Date.now() - 60_000) } });
    const never = { facebook: async () => { throw new Error('must not publish'); }, instagram: async () => { throw new Error('must not publish'); } };
    expect(await publishPost(db, post.id, key, pub, never)).toBeNull();
    expect(await overduePosts(db)).toEqual([]);
    await db.post.update({ where: { id: post.id }, data: { clientReview: 'APPROVED' } });
    expect(await overduePosts(db)).toEqual([{ id: post.id }]);
  });

  it('marks partial failures and retries only the failed target', async () => {
    const post = await scheduledPost();
    let fbCalls = 0;
    const flaky = { facebook: async () => { fbCalls++; return 'fb_1'; }, instagram: async () => { throw new Error('Media expired'); } };
    expect(await publishPost(db, post.id, key, pub, flaky)).toBe('PARTIAL');
    expect(await publishPost(db, post.id, key, pub, { ...flaky, instagram: async () => 'ig_1' })).toBe('PUBLISHED');
    expect(fbCalls).toBe(1);
  });

  it('does nothing for a post that is not scheduled', async () => {
    const post = await scheduledPost();
    await db.post.update({ where: { id: post.id }, data: { status: 'DRAFT' } });
    expect(await publishPost(db, post.id, key, pub)).toBeNull();
  });
});
