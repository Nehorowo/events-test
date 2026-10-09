// Plan limits shared by the API (enforcement) and the web app (display).

export type Plan = 'free' | 'pro';

export interface PlanLimits {
  maxStaff: number;
  /** Online bookings per calendar month; null = unlimited. */
  monthlyBookings: number | null;
  badge: boolean;
  branding: boolean;
  push: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { maxStaff: 1, monthlyBookings: 40, badge: true, branding: false, push: false },
  pro: { maxStaff: 5, monthlyBookings: null, badge: false, branding: true, push: true },
};

export const PRICES = { proMonthly: 9, proYearly: 90, foundingMonthly: 5, currency: 'EUR' } as const;

/** Share of the free booking allowance at which the dashboard warns. */
export const USAGE_WARNING_RATIO = 0.8;

export const RESERVED_SLUGS = [
  'api', 'app', 'assets', 'admin', 'login', 'logout', 'signup', 'onboarding', 'invite',
  'm', 'privacy', 'terms', 'pricing', 'help', 'support', 'static', 'sw', 'manifest',
  'icons', 'www', 'slotwise', 'billing', 'settings',
];
