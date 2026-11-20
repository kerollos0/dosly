/**
 * Plans. Prices are placeholders until Kerollos sets them; limits are what the API enforces.
 * null means unlimited.
 */
export const PLAN_TIERS = ['TRIAL', 'STARTER', 'GROWTH', 'AGENCY'] as const;
export type PlanTierName = (typeof PLAN_TIERS)[number];

export const PLANS: Record<PlanTierName, { label: string; priceEgp: number; clients: number | null; members: number | null; portal: boolean }> = {
  TRIAL: { label: 'تجربة مجانية', priceEgp: 0, clients: 5, members: 5, portal: true },
  STARTER: { label: 'البداية', priceEgp: 499, clients: 5, members: 3, portal: false },
  GROWTH: { label: 'النمو', priceEgp: 999, clients: 15, members: 10, portal: true },
  AGENCY: { label: 'الوكالة', priceEgp: 1999, clients: null, members: null, portal: true }
};

export const TRIAL_DAYS = 14;
