import { migrate, one, pool } from '../src/db.js';

/** Fresh schema for each test file. Refuses to touch a non-test database. */
export async function resetDb(): Promise<void> {
  const db = await one<{ name: string }>(pool, 'select current_database() as name');
  if (!db?.name.endsWith('_test')) throw new Error(`refusing to reset non-test database ${db?.name}`);
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(() => {});
}

export interface Fixture {
  tenantId: string;
  staffId: string;
  staff2Id: string;
  serviceId: string;
}

let counter = 0;

/** A business with two staff working 09:00–17:00 every day and a 60-min service. */
export async function createFixture(opts: { timezone?: string; plan?: 'free' | 'pro'; bufferMin?: number } = {}): Promise<Fixture> {
  counter++;
  const t = await one<{ id: string }>(
    pool,
    `insert into tenants (slug, name, timezone, published, max_days_ahead, min_notice_min)
     values ($1, $2, $3, true, 365, 0) returning id`,
    [`biz-${counter}-${Date.now() % 100000}`, `Biz ${counter}`, opts.timezone ?? 'Europe/Nicosia'],
  );
  const tenantId = t!.id;
  await pool.query(`insert into subscriptions (tenant_id, plan) values ($1, $2)`, [tenantId, opts.plan ?? 'pro']);
  const s1 = await one<{ id: string }>(pool, `insert into staff (tenant_id, name, sort) values ($1, 'Anna', 0) returning id`, [tenantId]);
  const s2 = await one<{ id: string }>(pool, `insert into staff (tenant_id, name, sort) values ($1, 'Maria', 1) returning id`, [tenantId]);
  for (const sid of [s1!.id, s2!.id]) {
    for (let d = 0; d < 7; d++) {
      await pool.query(
        `insert into working_hours (tenant_id, staff_id, weekday, start_time, end_time) values ($1, $2, $3, '09:00', '17:00')`,
        [tenantId, sid, d],
      );
    }
  }
  const svc = await one<{ id: string }>(
    pool,
    `insert into services (tenant_id, name, duration_min, price_cents, buffer_min) values ($1, 'Haircut', 60, 3000, $2) returning id`,
    [tenantId, opts.bufferMin ?? 0],
  );
  return { tenantId, staffId: s1!.id, staff2Id: s2!.id, serviceId: svc!.id };
}

/** A date N days from today as YYYY-MM-DD. */
export function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}
