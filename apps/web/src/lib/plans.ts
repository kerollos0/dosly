/** Plans as shown to people. Mirrors PLANS in @dosly/shared (the API enforces the limits). Prices are placeholders. */
export const PLAN_LABEL: Record<string, string> = { TRIAL: 'تجربة', STARTER: 'البداية', GROWTH: 'النمو', AGENCY: 'الوكالة' };
export const PLAN_PRICE: Record<string, number> = { TRIAL: 0, STARTER: 499, GROWTH: 999, AGENCY: 1999 };
export const planPill = (plan: string) => (plan === 'TRIAL' ? 'warn' : plan === 'AGENCY' ? 'sun' : 'info') as 'warn' | 'sun' | 'info';

export const PUBLIC_PLANS = [
  { id: 'STARTER', for: 'لو لسه بادئ أو شغال لوحدك', features: ['لحد 5 عملاء', '3 أعضاء في الفريق', 'إنبوكس واتساب مشترك', 'جدولة فيسبوك وإنستجرام'] },
  { id: 'GROWTH', for: 'لوكالة عندها فريق وعملاء بيزيدوا', featured: true, features: ['لحد 15 عميل', '10 أعضاء في الفريق', 'بوابة العميل: موافقات وتقرير شهري', 'كل حاجة في البداية'] },
  { id: 'AGENCY', for: 'لوكالة كبيرة', features: ['عملاء من غير حد', 'فريق من غير حد', 'بوابة العميل', 'أولوية في الدعم'] }
] as const;
