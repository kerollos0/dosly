import { describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { can, decrypt, encrypt, hashPassword, isWindowOpen, parseWebhook, verifyMetaSignature, verifyPassword, sendWhatsAppText } from '../src/index.js';

describe('crypto', () => {
  it('round-trips tokens and rejects tampering', () => {
    const key = randomBytes(32);
    const c = encrypt('EAAG-secret', key);
    expect(c).not.toContain('EAAG');
    expect(decrypt(c, key)).toBe('EAAG-secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
  });
});

describe('roles', () => {
  it('moderators reply but cannot manage clients', () => {
    expect(can('MODERATOR', 'inbox:reply')).toBe(true);
    expect(can('MODERATOR', 'clients:manage')).toBe(false);
    expect(can('WRITER', 'inbox:reply')).toBe(false);
  });
});

describe('whatsapp', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account' });
  it('verifies Meta signatures', () => {
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig, 'app-secret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 'app-secret')).toBe(false);
  });
  it('parses inbound messages and statuses', () => {
    const p = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '123' },
        contacts: [{ wa_id: '201000000000', profile: { name: 'منى' } }],
        messages: [{ from: '201000000000', id: 'wamid.A', timestamp: '1763600000', type: 'text', text: { body: 'السعر كام؟' } }],
        statuses: [{ id: 'wamid.B', status: 'read', timestamp: '1763600001' }]
      } }] }]
    });
    expect(p.messages[0]).toMatchObject({ phoneNumberId: '123', waId: '201000000000', contactName: 'منى', body: 'السعر كام؟' });
    expect(p.statuses[0]).toMatchObject({ waMessageId: 'wamid.B', status: 'read' });
  });
  it('enforces the 24h service window', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(isWindowOpen(new Date('2026-11-20T00:00:00Z'), now)).toBe(true);
    expect(isWindowOpen(new Date('2026-11-19T11:00:00Z'), now)).toBe(false);
    expect(isWindowOpen(null, now)).toBe(false);
  });
  it('sends text messages through the Graph API', async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] })); }) as any;
    const id = await sendWhatsAppText({ phoneNumberId: '123', token: 't', to: '2010', body: 'أهلا' }, fake);
    expect(id).toBe('wamid.X');
    expect(seen.url).toMatch(/\/123\/messages$/);
    expect(JSON.parse(seen.init.body).text.body).toBe('أهلا');
  });
});
