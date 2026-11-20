import { describe, expect, it } from 'vitest';
import { asciiName, demoCommentPayload, demoSocialMessagePayload, parseSocialWebhook, replyWindow, socialMessageType, socialWindow } from '../src/index.js';

describe('Page and Instagram webhooks', () => {
  it('reads Facebook feed comments: top-level parent is the post, replies keep their parent', () => {
    const top = parseSocialWebhook(demoCommentPayload({ platform: 'FACEBOOK_PAGE', accountId: 'P1', postId: 'P1_9', commentId: 'C1', fromId: 'U1', fromName: 'مريم', text: 'بكام؟' }));
    expect(top.comments).toEqual([expect.objectContaining({ platform: 'FACEBOOK_PAGE', accountId: 'P1', verb: 'add', commentId: 'C1', postId: 'P1_9', parentId: undefined, fromName: 'مريم', text: 'بكام؟' })]);
    const reply = parseSocialWebhook(demoCommentPayload({ platform: 'FACEBOOK_PAGE', accountId: 'P1', postId: 'P1_9', commentId: 'C2', fromId: 'U1', fromName: 'مريم', text: 'شكرًا', parentId: 'C1' }));
    expect(reply.comments[0]!.parentId).toBe('C1');
    const hide = parseSocialWebhook({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'feed', value: { item: 'comment', verb: 'hide', comment_id: 'C1', post_id: 'P1_9' } }] }] });
    expect(hide.comments[0]!.verb).toBe('hide');
    // Reactions and other feed items are ignored.
    expect(parseSocialWebhook({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'feed', value: { item: 'reaction', verb: 'add' } }] }] }).comments).toEqual([]);
  });

  it('reads Instagram comments with their media and username', () => {
    const p = parseSocialWebhook(demoCommentPayload({ platform: 'INSTAGRAM', accountId: 'IG1', postId: 'M1', commentId: 'IC1', fromId: 'IGU', fromName: 'nour.style', text: 'السعر؟', parentId: 'IC0' }));
    expect(p.comments[0]).toMatchObject({ platform: 'INSTAGRAM', postId: 'M1', commentId: 'IC1', parentId: 'IC0', fromName: 'nour.style', text: 'السعر؟' });
  });

  it('reads direct messages, attachments, echoes and receipts', () => {
    const dm = parseSocialWebhook(demoSocialMessagePayload({ platform: 'FACEBOOK_PAGE', accountId: 'P1', customerId: 'PSID1', text: 'أهلاً', media: 'photo' }));
    expect(dm.messages[0]).toMatchObject({ platform: 'FACEBOOK_PAGE', accountId: 'P1', customerId: 'PSID1', echo: false, text: 'أهلاً' });
    expect(dm.messages[0]!.attachments[0]!.type).toBe('image');
    const echo = parseSocialWebhook({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'IG1' }, recipient: { id: 'IGSID' }, timestamp: 1_700_000_000_000, message: { mid: 'm1', text: 'رد', is_echo: true } }] }] });
    expect(echo.messages[0]).toMatchObject({ echo: true, customerId: 'IGSID', timestamp: new Date(1_700_000_000_000) });
    const read = parseSocialWebhook({ object: 'page', entry: [{ id: 'P1', messaging: [{ sender: { id: 'PSID1' }, recipient: { id: 'P1' }, timestamp: 1, read: { watermark: 1_700_000_000_000 } }] }] });
    expect(read.reads[0]).toMatchObject({ kind: 'read', customerId: 'PSID1', watermark: new Date(1_700_000_000_000) });
    expect(parseSocialWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual({ messages: [], reads: [], comments: [] });
  });

  it('maps attachment types to inbox message types', () => {
    expect(socialMessageType({ type: 'image', url: 'u' })).toBe('image');
    expect(socialMessageType({ type: 'image', url: 'u', stickerId: '369239263222822' })).toBe('sticker');
    expect(socialMessageType({ type: 'file', url: 'u' })).toBe('document');
    expect(socialMessageType({ type: 'ig_reel', url: 'u' })).toBe('share');
    expect(socialMessageType({ type: 'fallback' })).toBe('share');
  });
});

describe('reply windows', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
  it('gives Messenger and Instagram 24h, then 7 days with the human agent tag; WhatsApp only 24h', () => {
    expect(socialWindow(ago(2), now)).toBe('open');
    expect(socialWindow(ago(30), now)).toBe('human_agent');
    expect(socialWindow(ago(24 * 8), now)).toBe('closed');
    expect(socialWindow(null, now)).toBe('closed');
    expect(replyWindow('WHATSAPP', ago(30), now)).toBe('closed');
    expect(replyWindow('INSTAGRAM', ago(30), now)).toBe('human_agent');
  });
  it('makes ASCII file names, which the Send API requires', () => {
    expect(asciiName('قائمة الأسعار.pdf')).toBe('file.pdf');
    expect(asciiName('menu 2026 (final).PDF')).toBe('menu-2026-final.PDF');
  });
});
