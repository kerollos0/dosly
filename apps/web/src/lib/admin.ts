export const PLAN_LABEL: Record<string, string> = { TRIAL: 'تجربة', STARTER: 'البداية', GROWTH: 'النمو', AGENCY: 'الوكالة' };
export const PLAN_PRICE: Record<string, number> = { TRIAL: 0, STARTER: 499, GROWTH: 999, AGENCY: 1999 }; // mirrors @dosly/shared PLANS
export const planPill = (plan: string) => (plan === 'TRIAL' ? 'warn' : plan === 'AGENCY' ? 'sun' : 'info') as 'warn' | 'sun' | 'info';
