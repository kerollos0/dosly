export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message ?? 'حصلت مشكلة. جرّب تاني.', data.error ?? 'error');
  return data as T;
}

export const fetcher = (path: string) => api(path);

export type Role = 'OWNER' | 'MANAGER' | 'MODERATOR' | 'WRITER';
export type Me = {
  user: { id: string; name: string; email: string }; role: Role; demo?: boolean; support?: boolean;
  agency: { id: string; name: string; plan: string; trialEndsAt: string | null; paidUntil: string | null; status: string; suspendedReason: string | null };
  readOnly: 'support' | 'suspended' | 'trial_ended' | 'unpaid' | null;
};
export type Client = {
  id: string; name: string; notes: string | null; assigneeIds: string[]; unreadConversations: number;
  waNumbers: { id: string; displayPhone: string; status: string }[];
  socialAccounts: { id: string; platform: 'FACEBOOK_PAGE' | 'INSTAGRAM'; name: string; status: string }[];
};
export type Conversation = {
  id: string; clientId: string; status: 'OPEN' | 'PENDING' | 'CLOSED'; unreadCount: number; lastMessageAt: string; lastPreview: string | null;
  windowOpen: boolean; contact: { name: string | null; waId: string }; client: { id: string; name: string }; assignee: { id: string; name: string } | null;
};
export type Message = {
  id: string; direction: 'IN' | 'OUT'; type: string; body: string | null; status: string; error: string | null; createdAt: string; sentBy: { id: string; name: string } | null;
  hasMedia: boolean; hasPreview: boolean; mediaStatus: 'PENDING' | 'READY' | 'FAILED' | null; mediaMime: string | null; mediaSize: number | null;
  fileName: string | null; mediaWidth: number | null; mediaHeight: number | null; durationSec: number | null; voice: boolean;
  template?: { name?: string; header?: string; footer?: string; buttons: string[]; headerKind?: 'image' | 'video' | 'document' };
};
export type TemplateField = { id: string; part: 'header' | 'body' | 'button'; key: string; buttonIndex?: number };
export type Template = {
  id: string; name: string; language: string; category: string; status: string; reason: string | null;
  shape: { fields: TemplateField[]; headerMedia: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null; headerText?: string; body: string; footer?: string; buttons: { type: string; text: string; url?: string }[] };
};
export type ClientReview = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED';
export const REVIEW_LABEL: Record<ClientReview, string> = { NOT_REQUIRED: '', PENDING: 'مستني موافقة العميل', APPROVED: 'العميل وافق', CHANGES_REQUESTED: 'العميل طلب تعديل' };
export type Post = {
  id: string; clientId: string; caption: string; mediaUrls: string[]; scheduledAt: string | null; status: string; createdAt: string;
  clientReview: ClientReview; clientNote: string | null;
  client: { name: string }; createdBy: { name: string };
  targets: { id: string; status: string; error: string | null; socialAccount: { platform: string; name: string } }[];
};
export type Member = { id: string; name: string; email: string; role: Role };

export const can = {
  manage: (r?: Role) => r === 'OWNER' || r === 'MANAGER',
  reply: (r?: Role) => r === 'OWNER' || r === 'MANAGER' || r === 'MODERATOR',
  write: (r?: Role) => r === 'OWNER' || r === 'MANAGER' || r === 'WRITER'
};

export const ROLE_LABEL: Record<Role, string> = { OWNER: 'صاحب الوكالة', MANAGER: 'مدير', MODERATOR: 'مودريتور', WRITER: 'كاتب محتوى' };
