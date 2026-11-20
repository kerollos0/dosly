import { describe, expect, it } from 'vitest';
import { buildTemplateMessage, DEMO_TEMPLATES, paramProblem, parseWebhook, placeholders, renderTemplate, templateShape } from '../src/index.js';

const tpl = (name: string) => {
  const t = DEMO_TEMPLATES.find(x => x.name === name)!;
  return { name: t.name, language: t.language, parameterFormat: t.parameter_format!, components: t.components };
};

describe('webhook media and template events', () => {
  it('reads media objects, voice notes, documents and locations', () => {
    const p = parseWebhook({ object: 'whatsapp_business_account', entry: [{ id: 'waba1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1' },
      messages: [
        { from: '20', id: 'a', timestamp: '1', type: 'audio', audio: { id: 'm1', mime_type: 'audio/ogg; codecs=opus', sha256: 'x', voice: true } },
        { from: '20', id: 'b', timestamp: '1', type: 'document', document: { id: 'm2', mime_type: 'application/pdf', filename: 'r.pdf', caption: 'الفاتورة' } },
        { from: '20', id: 'c', timestamp: '1', type: 'sticker', sticker: { id: 'm3', mime_type: 'image/webp', animated: true } },
        { from: '20', id: 'd', timestamp: '1', type: 'location', location: { latitude: 30.04, longitude: 31.23, name: 'المحل' } }
      ]
    } }] }] });
    expect(p.messages[0]!.media).toEqual({ id: 'm1', mime: 'audio/ogg; codecs=opus', sha256: 'x', fileName: undefined, voice: true, animated: false });
    expect(p.messages[1]).toMatchObject({ body: 'الفاتورة', media: { id: 'm2', fileName: 'r.pdf' } });
    expect(p.messages[2]!.media).toMatchObject({ animated: true });
    expect(p.messages[3]!.body).toContain('maps.google.com/?q=30.04,31.23');
    expect(p.messages[3]!.media).toBeUndefined();
  });

  it('reads template status updates', () => {
    const p = parseWebhook({ object: 'whatsapp_business_account', entry: [{ id: 'waba1', changes: [{ field: 'message_template_status_update', value: {
      event: 'REJECTED', message_template_id: 123, message_template_name: 'offer', message_template_language: 'ar', reason: 'PROMOTIONAL'
    } }] }] });
    expect(p.templates).toEqual([{ wabaId: 'waba1', metaId: '123', name: 'offer', language: 'ar', event: 'REJECTED', reason: 'PROMOTIONAL', category: undefined }]);
  });
});

describe('templates', () => {
  it('finds positional and named variables in send order', () => {
    expect(placeholders('{{2}} ثم {{1}} ثم {{2}}', false)).toEqual(['1', '2']);
    expect(placeholders('أهلاً {{first_name}} خصم {{discount}}', true)).toEqual(['first_name', 'discount']);
  });

  it('builds a positional template with a text header and a URL button', () => {
    const t = tpl('appointment_reminder');
    const values = { 'body.1': 'ريم', 'body.2': 'السبت', 'body.3': '5 مساءً', 'button.0.1': 'A 12' };
    expect(templateShape(t).fields.map(f => f.id)).toEqual(['body.1', 'body.2', 'body.3', 'button.0.1']);
    expect(buildTemplateMessage(t, values)).toEqual({ type: 'template', template: { name: 'appointment_reminder', language: { code: 'ar' }, components: [
      { type: 'body', parameters: [{ type: 'text', text: 'ريم' }, { type: 'text', text: 'السبت' }, { type: 'text', text: '5 مساءً' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'A%2012' }] }
    ] } });
    expect(renderTemplate(t, values)).toMatchObject({ header: 'تذكير بميعادك', body: expect.stringContaining('بميعادك يوم السبت الساعة 5 مساءً'), buttons: ['تفاصيل الحجز'] });
  });

  it('builds a named template with an image header', () => {
    const t = tpl('monthly_offer');
    const msg = buildTemplateMessage(t, { 'body.customer_name': 'منى', 'body.discount': '20%', 'body.end_date': 'الجمعة' }, { id: 'MEDIA1' });
    expect(msg.template.components).toEqual([
      { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA1' } }] },
      { type: 'body', parameters: [
        { type: 'text', text: 'منى', parameter_name: 'customer_name' },
        { type: 'text', text: '20%', parameter_name: 'discount' },
        { type: 'text', text: 'الجمعة', parameter_name: 'end_date' }
      ] }
    ]);
    expect(() => buildTemplateMessage(t, {})).toThrow('header_media_required');
  });

  it('rejects variable text WhatsApp refuses', () => {
    expect(paramProblem('سطر\nتاني')).toBe('newline');
    expect(paramProblem('a     b')).toBe('spaces');
    expect(paramProblem('  ')).toBe('empty');
    expect(paramProblem('تمام')).toBeNull();
  });
});
