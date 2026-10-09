import { PLAN_LIMITS, type Plan, type PlanLimits } from '../../../shared/plans.js';
import { one, type Queryable } from '../db.js';

export interface SubscriptionRow {
  plan: 'free' | 'pro' | 'founding';
  status: string;
  billing_interval: string | null;
  current_period_end: Date | null;
  founding_until: Date | null;
  stripe_customer_id: string | null;
}

const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function effectivePlan(sub: Pick<SubscriptionRow, 'plan' | 'status'> | undefined): Plan {
  if (!sub) return 'free';
  if (sub.plan === 'founding') return 'pro';
  if (sub.plan === 'pro' && PAID_STATUSES.has(sub.status)) return 'pro';
  return 'free';
}

export interface TenantPlan {
  plan: Plan;
  rawPlan: SubscriptionRow['plan'];
  limits: PlanLimits;
  subscription: SubscriptionRow | undefined;
}

export async function tenantPlan(db: Queryable, tenantId: string): Promise<TenantPlan> {
  const sub = await one<SubscriptionRow>(db, 'select * from subscriptions where tenant_id = $1', [tenantId]);
  const plan = effectivePlan(sub);
  return { plan, rawPlan: sub?.plan ?? 'free', limits: PLAN_LIMITS[plan], subscription: sub };
}

/** Online bookings created this calendar month in the tenant's timezone. */
export async function monthlyOnlineBookings(db: Queryable, tenantId: string): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `select count(*)::int as n
       from appointments a join tenants t on t.id = a.tenant_id
      where a.tenant_id = $1 and a.source = 'online' and a.status <> 'cancelled'
        and a.created_at >= date_trunc('month', now() at time zone t.timezone) at time zone t.timezone`,
    [tenantId],
  );
  return row?.n ?? 0;
}

/**
 * Staff that may take bookings under the current plan. On Free only the first
 * active staff member is bookable, so a downgrade cannot keep extra seats live.
 */
export async function bookableStaffIds(db: Queryable, tenantId: string, maxStaff: number): Promise<string[]> {
  const { rows } = await db.query(
    `select id from staff where tenant_id = $1 and active order by sort, created_at limit $2`,
    [tenantId, maxStaff],
  );
  return rows.map((r) => r.id as string);
}
