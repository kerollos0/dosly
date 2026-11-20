import { graph } from './whatsapp.js';

/**
 * WhatsApp message templates: the only messages allowed after the 24-hour customer service window.
 * Shapes follow Meta's template guides (templates/overview, templates/components, template-management).
 */
export type TemplateButton = { type: string; text: string; url?: string; phone_number?: string };
export type TemplateComponent = { type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS'; format?: string; text?: string; buttons?: TemplateButton[] };
export type MetaTemplate = { id: string; name: string; language: string; status: string; category: string; parameter_format?: string; components: TemplateComponent[] };
export type TemplateLike = { name: string; language: string; parameterFormat: string; components: unknown };

export const TEMPLATE_FIELDS = 'id,name,language,status,category,parameter_format,components';

/** Lists every template of a WhatsApp Business Account, following cursor paging. */
export async function listTemplates(o: { wabaId: string; token: string; maxPages?: number }, fetchImpl?: typeof fetch): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  let path: string | null = `${o.wabaId}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100`;
  for (let page = 0; path && page < (o.maxPages ?? 50); page++) {
    const res: { data?: MetaTemplate[]; paging?: { next?: string; cursors?: { after?: string } } } = await graph(path, o.token, {}, fetchImpl);
    out.push(...(res.data ?? []));
    const after: string | undefined = res.paging?.next ? res.paging.cursors?.after : undefined;
    path = after ? `${o.wabaId}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100&after=${encodeURIComponent(after)}` : null;
  }
  return out;
}

const comps = (t: TemplateLike) => (Array.isArray(t.components) ? t.components : []) as TemplateComponent[];
const named = (t: TemplateLike) => t.parameterFormat.toUpperCase() === 'NAMED';

/** The variables in one piece of template text, in send order: {{1}}, {{2}} or {{first_name}}. */
export function placeholders(text: string | undefined, isNamed: boolean): string[] {
  if (!text) return [];
  const re = isNamed ? /\{\{\s*([a-z0-9_]+)\s*\}\}/g : /\{\{\s*(\d+)\s*\}\}/g;
  const seen: string[] = [];
  for (const m of text.matchAll(re)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return isNamed ? seen : seen.sort((a, b) => Number(a) - Number(b));
}

export type TemplateField = { id: string; part: 'header' | 'body' | 'button'; key: string; buttonIndex?: number; example?: string };
export type TemplateShape = { fields: TemplateField[]; headerMedia: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null; headerText?: string; body: string; footer?: string; buttons: TemplateButton[] };

/** What the person has to fill in before sending: text variables, plus a file when the header is media. */
export function templateShape(t: TemplateLike): TemplateShape {
  const isNamed = named(t);
  const c = comps(t);
  const header = c.find(x => x.type === 'HEADER');
  const body = c.find(x => x.type === 'BODY');
  const buttons = c.find(x => x.type === 'BUTTONS')?.buttons ?? [];
  const fields: TemplateField[] = [];
  if (header?.format === 'TEXT') for (const k of placeholders(header.text, isNamed)) fields.push({ id: `header.${k}`, part: 'header', key: k });
  for (const k of placeholders(body?.text, isNamed)) fields.push({ id: `body.${k}`, part: 'body', key: k });
  buttons.forEach((b, i) => {
    if (b.type === 'URL') for (const k of placeholders(b.url, isNamed)) fields.push({ id: `button.${i}.${k}`, part: 'button', key: k, buttonIndex: i });
  });
  const hm = header?.format && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format) ? (header.format as 'IMAGE' | 'VIDEO' | 'DOCUMENT') : null;
  return { fields, headerMedia: hm, headerText: header?.format === 'TEXT' ? header.text : undefined, body: body?.text ?? '', footer: c.find(x => x.type === 'FOOTER')?.text, buttons };
}

/** Meta rejects variable text with new lines, tabs or more than 4 spaces in a row (error 132018). */
export function paramProblem(v: string | undefined): string | null {
  if (!v || !v.trim()) return 'empty';
  if (/[\n\t]/.test(v)) return 'newline';
  if (/ {5,}/.test(v)) return 'spaces';
  if (v.length > 1024) return 'too_long';
  return null;
}

const fill = (text: string, values: Record<string, string>, prefix: string) =>
  text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (all, k: string) => values[`${prefix}.${k}`] ?? all);

/** The message as the customer will read it, for the inbox history. */
export function renderTemplate(t: TemplateLike, values: Record<string, string>) {
  const s = templateShape(t);
  return {
    header: s.headerText ? fill(s.headerText, values, 'header') : undefined,
    body: fill(s.body, values, 'body'),
    footer: s.footer,
    buttons: s.buttons.map(b => b.text)
  };
}

/** The `template` message object for POST /{phone-number-id}/messages. */
export function buildTemplateMessage(t: TemplateLike, values: Record<string, string>, headerMedia?: { id: string; fileName?: string }) {
  const isNamed = named(t);
  const s = templateShape(t);
  const param = (f: TemplateField) => ({ type: 'text', text: values[f.id] ?? '', ...(isNamed ? { parameter_name: f.key } : {}) });
  const components: Record<string, unknown>[] = [];
  if (s.headerMedia) {
    const kind = s.headerMedia.toLowerCase();
    if (!headerMedia) throw new Error('header_media_required');
    components.push({ type: 'header', parameters: [{ type: kind, [kind]: { id: headerMedia.id, ...(kind === 'document' && headerMedia.fileName ? { filename: headerMedia.fileName } : {}) } }] });
  }
  const headerFields = s.fields.filter(f => f.part === 'header');
  if (headerFields.length) components.push({ type: 'header', parameters: headerFields.map(param) });
  const bodyFields = s.fields.filter(f => f.part === 'body');
  if (bodyFields.length) components.push({ type: 'body', parameters: bodyFields.map(param) });
  const byButton = new Map<number, TemplateField[]>();
  for (const f of s.fields.filter(f => f.part === 'button')) byButton.set(f.buttonIndex!, [...(byButton.get(f.buttonIndex!) ?? []), f]);
  // URL variables are appended to the button's URL, so they are percent-encoded.
  for (const [i, fs] of byButton) components.push({ type: 'button', sub_type: 'url', index: String(i), parameters: fs.map(f => ({ ...param(f), text: encodeURIComponent(values[f.id] ?? '') })) });
  return { type: 'template', template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) } };
}

export const TEMPLATE_CATEGORY_AR: Record<string, string> = { MARKETING: 'تسويقية', UTILITY: 'خدمية', AUTHENTICATION: 'كود تأكيد' };
