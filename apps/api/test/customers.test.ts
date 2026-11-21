import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processSocialWebhook, processWhatsAppWebhook, syncStageFromOrders, type Publisher } from '@dosly/core';
import { parseSocialWebhook } from '@dosly/shared';
import { db, key, makeApp, owner, reset, session } from './helpers.js';

beforeEach(reset);
afterAll(() => db.$disconnect());

const pub: Publisher = { publish() {} };
const PHONE = '1445980835268077', PAGE = '1000001', IG = '1784000001';

function graph() {
  return (url: string): unknown => {
    const u = new URL(url);
    if (u.pathname.endsWith('/me') && u.searchParams.get('fields')?.includes('instagram_business_account')) return { id: PAGE, instagram_business_account: { id: IG } };
    if (u.searchParams.get('fields')?.includes('first_name')) return { first_name: 'سارة', last_name: 'عادل' };
    return { success: true, display_phone_number: '+20 10 0000 0000', verified_name: 'Test' };
  };
}

async function setup() {
  const { app, fetch } = await makeApp(graph());
  const as = await owner(app);
  const client = (await as('POST', '/api/clients', { name: 'لمسة للعطور' })).json();
  await as('POST', '/api/channels/whatsapp', { clientId: client.id, phoneNumberId: PHONE, wabaId: '1', accessToken: 'EAAG-test-token-123456789' });
  await as('POST', '/api/channels/social', { clientId: client.id, platform: 'FACEBOOK_PAGE', externalId: PAGE, name: 'لمسة', accessToken: 'EAAG-page-token-123456789' });
  const agencyId = (await db.client.findUniqueOrThrow({ where: { id: client.id } })).agencyId;
  const acc = await db.adAccount.create({ data: { agencyId, clientId: client.id, externalId: '777', name: 'Lamsa', currency: 'EGP', timezoneName: 'Africa/Cairo', accessTokenEnc: 'x' } });
  const camp = await db.adCampaign.create({ data: { adAccountId: acc.id, externalId: '1202', name: 'رسايل | عود ملكي', status: 'ACTIVE', effectiveStatus: 'ACTIVE' } });
  await db.adAd.create({ data: { adAccountId: acc.id, externalId: '120299', campaignId: camp.id } });
  const store = await db.storeConnection.create({ data: { agencyId, clientId: client.id, kind: 'EASYORDERS', name: 'متجر', hookId: 'h-crm', secretEnc: 'x' } });
  return { app, as, client, agencyId, camp, store, hooks: { key, fetch } };
}

const wa = (from: string, body: string, referral?: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: PHONE }, contacts: [{ wa_id: from, profile: { name: 'مريم حسن' } }],
  messages: [{ from, id: `wamid.in.${Math.random()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body }, ...(referral && { referral: { source_id: referral, source_type: 'ad', source_url: 'https://fb.me/x' } }) }]
} }] }] });
const order = (s: Awaited<ReturnType<typeof setup>>, o: { waId: string; contactId?: string; status?: 'PENDING' | 'DELIVERED' | 'CANCELLED'; minor: number }) => db.storeOrder.create({ data: {
  agencyId: s.agencyId, clientId: s.client.id, storeId: s.store.id, externalId: `o${Math.random()}`, number: '#1', currency: 'EGP', totalMinor: BigInt(o.minor), waId: o.waId, contactId: o.contactId ?? null, status: o.status ?? 'PENDING', items: [], placedAt: new Date()
} });

describe('customers (light CRM)', () => {
  it('knows who came from which ad, who asked the price, and who bought', async () => {
    const s = await setup();
    // An ad brings Mariam; she asks the price.
    await processWhatsAppWebhook(db, wa('201000000001', 'السلام عليكم', '120299'), pub);
    let mariam = await db.contact.findFirstOrThrow({ where: { waId: '201000000001' } });
    expect(mariam).toMatchObject({ source: 'ad', adId: '120299', stage: 'NEW' });
    await processWhatsAppWebhook(db, wa('201000000001', 'بكام العود ده؟'), pub);
    expect((await db.contact.findUniqueOrThrow({ where: { id: mariam.id } })).stage).toBe('INTERESTED');
    // She orders on the store; then it is delivered.
    const o = await order(s, { waId: '201000000001', contactId: mariam.id, minor: 45000 });
    await syncStageFromOrders(db, mariam.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: mariam.id } })).stage).toBe('ORDERED');
    await db.storeOrder.update({ where: { id: o.id }, data: { status: 'DELIVERED' } });
    await syncStageFromOrders(db, mariam.id);
    mariam = await db.contact.findUniqueOrThrow({ where: { id: mariam.id } });
    expect(mariam.stage).toBe('WON');

    // Ahmed ordered before writing: his first message links the order and makes him "ordered".
    await order(s, { waId: '201000000002', minor: 30000 });
    await processWhatsAppWebhook(db, wa('201000000002', 'الأوردر وصل إمتى؟'), pub);
    expect((await db.contact.findFirstOrThrow({ where: { waId: '201000000002' } })).stage).toBe('ORDERED');
    // Nour just says hi.
    await processWhatsAppWebhook(db, wa('201000000003', 'هاي'), pub);

    const sum = (await s.as('GET', `/api/customers/summary?clientId=${s.client.id}`)).json();
    expect(sum.stages).toMatchObject({ WON: 1, ORDERED: 1, NEW: 1 });
    expect(sum.sources[0]).toMatchObject({ kind: 'campaign', label: 'رسايل | عود ملكي', people: 1, ordered: 1, buyers: 1, sales: [{ currency: 'EGP', minor: 45000 }] });
    expect(sum.sources.find((x: any) => x.kind === 'direct')).toMatchObject({ people: 2, ordered: 1, buyers: 0 });

    const fromAd = (await s.as('GET', `/api/customers?source=campaign:${s.camp.id}`)).json();
    expect(fromAd.items).toHaveLength(1);
    expect(fromAd.items[0]).toMatchObject({ name: 'مريم حسن', stage: 'WON', ad: { campaign: { name: 'رسايل | عود ملكي' } }, orders: [{ count: 1, minor: 45000 }] });
    expect(fromAd.items[0].conversation.channel).toBe('WHATSAPP');
    expect((await s.as('GET', '/api/customers?q=00003')).json().items).toHaveLength(1);
  });

  it('a delivered order never moves back, and a cancelled one changes nothing', async () => {
    const s = await setup();
    await processWhatsAppWebhook(db, wa('201000000009', 'أهلا'), pub);
    const c = await db.contact.findFirstOrThrow({ where: { waId: '201000000009' } });
    await order(s, { waId: c.waId!, contactId: c.id, status: 'CANCELLED', minor: 100 });
    await syncStageFromOrders(db, c.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe('NEW');
    expect((await s.as('PATCH', `/api/customers/${c.id}`, { stage: 'WON' })).statusCode).toBe(200);
    await order(s, { waId: c.waId!, contactId: c.id, minor: 100 });
    await syncStageFromOrders(db, c.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe('WON');
  });

  it('a cancelled order takes "ordered" back, a manual "not interested" survives old order updates, and only people who wrote count', async () => {
    const s = await setup();
    await processWhatsAppWebhook(db, wa('201000000011', 'عايز اطلب'), pub);
    const c = await db.contact.findFirstOrThrow({ where: { waId: '201000000011' } });
    const o = await order(s, { waId: c.waId!, contactId: c.id, minor: 500 });
    await syncStageFromOrders(db, c.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe('ORDERED');
    await db.storeOrder.update({ where: { id: o.id }, data: { confirm: 'DECLINED' } });
    await syncStageFromOrders(db, c.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe('INTERESTED');

    // Delivered, then a moderator says "not interested": a repeated webhook for that old order changes nothing.
    await db.storeOrder.update({ where: { id: o.id }, data: { confirm: 'CONFIRMED', status: 'DELIVERED' } });
    await syncStageFromOrders(db, c.id);
    expect((await s.as('PATCH', `/api/customers/${c.id}`, { stage: 'LOST' })).statusCode).toBe(200);
    await syncStageFromOrders(db, c.id);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).stage).toBe('LOST');

    // Someone who only got a confirmation template (never wrote) is not counted.
    const conv = await db.conversation.findFirstOrThrow({ where: { contactId: c.id } });
    const silent = await db.contact.create({ data: { agencyId: s.agencyId, clientId: s.client.id, waNumberId: conv.waNumberId, waId: '201000000012' } });
    await db.conversation.create({ data: { agencyId: s.agencyId, clientId: s.client.id, waNumberId: conv.waNumberId, contactId: silent.id, status: 'PENDING', lastMessageAt: new Date() } });
    const list = (await s.as('GET', '/api/customers')).json();
    expect(list.items.map((x: any) => x.id)).toEqual([c.id]);
    const sum = (await s.as('GET', '/api/customers/summary?q=00011')).json();
    expect(sum.stages).toEqual({ LOST: 1 });
  });

  it('reads Messenger ad referrals, and lets the team set stage, tags and a note', async () => {
    const s = await setup();
    const payload = { object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [
      { sender: { id: 'PSID1' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'm_ref1', text: 'متاح؟', referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '555', ads_context_data: { ad_title: 'عود ملكي بخصم 20%' } } } },
      { sender: { id: 'PSID2' }, recipient: { id: PAGE }, timestamp: Date.now(), referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120299' } },
      { sender: { id: 'PSID3' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'm_ref3', text: 'hi', referral: { source: 'SHORTLINK', ref: 'bio' } } }
    ] }] };
    expect(parseSocialWebhook(payload).referrals).toHaveLength(1);
    await processSocialWebhook(db, payload, pub, s.hooks);
    const p1 = await db.contact.findFirstOrThrow({ where: { externalId: 'PSID1' } });
    expect(p1).toMatchObject({ source: 'ad', adId: '555', adTitle: 'عود ملكي بخصم 20%', stage: 'INTERESTED' });
    expect(await db.contact.findFirstOrThrow({ where: { externalId: 'PSID2' } })).toMatchObject({ source: 'ad', adId: '120299' });
    expect(await db.contact.findFirstOrThrow({ where: { externalId: 'PSID3' } })).toMatchObject({ source: 'direct', adId: null });
    const sum = (await s.as('GET', '/api/customers/summary')).json();
    expect(sum.sources.find((x: any) => x.kind === 'ad')).toMatchObject({ label: 'عود ملكي بخصم 20%', people: 1 });

    expect((await s.as('PATCH', `/api/customers/${p1.id}`, { stage: 'LOST', tags: ['جملة', 'جملة', 'VIP'], note: 'عايز يجي يشوفه في المحل' })).statusCode).toBe(200);
    const one = (await s.as('GET', `/api/customers/${p1.id}`)).json();
    expect(one).toMatchObject({ stage: 'LOST', tags: ['جملة', 'VIP'], note: 'عايز يجي يشوفه في المحل' });
    expect(one.clientTags).toEqual(expect.arrayContaining(['جملة', 'VIP']));
    expect((await s.as('GET', '/api/customers?tag=VIP')).json().items).toHaveLength(1);
    expect((await s.as('GET', '/api/customers?stage=LOST')).json().items).toHaveLength(1);

    // A writer cannot change customers; another agency cannot see them.
    const link = (await s.as('POST', '/api/team/invites', { email: 'w@test.eg', role: 'WRITER' })).json().link as string;
    const acc = await s.app.inject({ method: 'POST', url: '/api/invites/accept', payload: { token: link.split('/').pop(), name: 'هبة', password: 'writer-pass-123' } });
    const writer = session(s.app, acc.cookies.find(c => c.name === 'dosly_session')!.value);
    expect((await writer('PATCH', `/api/customers/${p1.id}`, { stage: 'WON' })).statusCode).toBe(403);
    const wsum = (await writer('GET', '/api/customers/summary')).json();
    expect(wsum.sources.every((x: any) => !x.sales.length && (x.kind !== 'campaign' || x.label === null) && (x.kind !== 'ad' || x.label === null))).toBe(true);
    const other = await owner(s.app, 'وكالة تانية');
    expect((await other('GET', `/api/customers/${p1.id}`)).statusCode).toBe(404);
    expect((await other('GET', '/api/customers')).json().items).toHaveLength(0);
  });
});
