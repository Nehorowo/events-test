import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppointment } from '../src/booking.js';
import { many, pool, tx, withTenant } from '../src/db.js';
import { createFixture, daysFromNow, resetDb, type Fixture } from './helpers.js';

async function slots(f: Fixture, date: string, staffId: string | null = null, tenantId = f.tenantId) {
  return many<{ staff_id: string; starts_at: Date; local_time: string }>(
    pool,
    'select * from available_slots($1, $2, $3, $4::date, $4::date)',
    [tenantId, f.serviceId, staffId, date],
  );
}

async function localToUtc(tenantId: string, date: string, time: string): Promise<Date> {
  const { rows } = await pool.query('select tenant_local_to_utc($1, $2::date, $3::time) as ts', [tenantId, date, time]);
  return rows[0].ts;
}

beforeAll(resetDb);
afterAll(() => pool.end());

describe('available_slots', () => {
  it('offers slots only inside working hours, on the configured step', async () => {
    const f = await createFixture();
    const day = daysFromNow(3);
    const s = await slots(f, day, f.staffId);
    const times = s.map((x) => x.local_time);
    expect(times[0]).toBe('09:00');
    expect(times.at(-1)).toBe('16:00'); // 60-min service must end by 17:00
    expect(times).toHaveLength(29); // 09:00..16:00 every 15 min
  });

  it('hides time off and days off', async () => {
    const f = await createFixture();
    const day = daysFromNow(4);
    await pool.query(
      `insert into time_off (tenant_id, staff_id, starts_at, ends_at, kind) values ($1, $2, $3, $4, 'block')`,
      [f.tenantId, f.staffId, await localToUtc(f.tenantId, day, '12:00'), await localToUtc(f.tenantId, day, '13:00')],
    );
    const times = (await slots(f, day, f.staffId)).map((x) => x.local_time);
    // A 60-minute service starting 11:15–12:45 would overlap the block.
    expect(times).toContain('11:00');
    expect(times).not.toContain('11:15');
    expect(times).not.toContain('12:45');
    expect(times).toContain('13:00');

    const off = daysFromNow(5);
    await pool.query(
      `insert into time_off (tenant_id, staff_id, starts_at, ends_at, kind) values ($1, $2, $3, $4, 'day_off')`,
      [f.tenantId, f.staffId, await localToUtc(f.tenantId, off, '00:00'), await localToUtc(f.tenantId, daysFromNow(6), '00:00')],
    );
    expect(await slots(f, off, f.staffId)).toHaveLength(0);
    expect((await slots(f, off, f.staff2Id)).length).toBeGreaterThan(0);
  });

  it('respects existing appointments plus the service buffer', async () => {
    const f = await createFixture({ bufferMin: 15 });
    const day = daysFromNow(7);
    await tx((db) => withTenantlessBook(db, f, day, '10:00'));
    const times = (await slots(f, day, f.staffId)).map((x) => x.local_time);
    // Booked 10:00–11:00 + 15 min buffer → next free start 11:15. A 09:00 slot
    // is gone too: its own buffer (10:00–10:15) would run into the booking.
    expect(times).not.toContain('09:00');
    expect(times).not.toContain('09:15');
    expect(times).not.toContain('11:00');
    expect(times).toContain('11:15');
  });

  it('never returns past times', async () => {
    const f = await createFixture({ timezone: 'UTC' });
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    for (const s of await slots(f, today)) expect(s.starts_at.getTime()).toBeGreaterThanOrEqual(now - 1000);
  });

  it('is DST-safe: skips non-existent local times and keeps wall-clock labels', async () => {
    const f = await createFixture({ timezone: 'Europe/Nicosia' });
    // Next spring-forward in the EU: last Sunday of March 2027, 03:00 → 04:00 local.
    const springDay = '2027-03-28';
    await pool.query(`update working_hours set start_time = '01:00', end_time = '06:00' where staff_id = $1`, [f.staffId]);
    const s = await slots(f, springDay, f.staffId);
    const times = s.map((x) => x.local_time);
    expect(times).toContain('02:00');
    expect(times).not.toContain('03:00');
    expect(times).not.toContain('03:30');
    expect(times).toContain('04:00');
    // Every label must match the instant's wall-clock time in the tenant timezone.
    for (const x of s) {
      const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Nicosia', hour: '2-digit', minute: '2-digit' }).format(x.starts_at);
      expect(wall).toBe(x.local_time);
    }
    expect(new Set(s.map((x) => x.starts_at.getTime())).size).toBe(s.length);

    // Fall-back day (2026-10-25, 04:00 → 03:00): 09:00 is still 09:00 local.
    const fall = await slots(f, '2026-10-25', f.staff2Id);
    expect(fall[0]!.local_time).toBe('09:00');
    expect(fall[0]!.starts_at.toISOString()).toBe('2026-10-25T07:00:00.000Z'); // UTC+2 after the change
  });
});

async function withTenantlessBook(db: Parameters<Parameters<typeof tx>[0]>[0], f: Fixture, day: string, time: string) {
  const startsAt = await localToUtc(f.tenantId, day, time);
  return createAppointment(db, {
    tenantId: f.tenantId,
    serviceId: f.serviceId,
    staffId: f.staffId,
    startsAt,
    client: { name: 'Seed', email: `seed-${day}-${time}@example.com` },
    source: 'manual',
    ignoreHours: true,
  });
}

describe('double-booking protection', () => {
  it('lets exactly one of many concurrent bookings for the same slot succeed', async () => {
    const f = await createFixture();
    const startsAt = await localToUtc(f.tenantId, daysFromNow(8), '10:00');
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        tx((db) =>
          createAppointment(db, {
            tenantId: f.tenantId,
            serviceId: f.serviceId,
            staffId: f.staffId,
            startsAt,
            client: { name: `Client ${i}`, email: `c${i}@example.com` },
            source: 'online',
          }),
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await pool.query(`select count(*)::int as n from appointments where tenant_id = $1`, [f.tenantId]);
    expect(rows[0].n).toBe(1);
  });

  it('enforces non-overlap in the database even when app checks are bypassed', async () => {
    const f = await createFixture();
    const day = daysFromNow(9);
    await tx((db) => withTenantlessBook(db, f, day, '10:00'));
    await expect(tx((db) => withTenantlessBook(db, f, day, '10:30'))).rejects.toMatchObject({ code: 'slot_taken' });
  });

  it('"any staff" assigns the next free person', async () => {
    const f = await createFixture();
    const startsAt = await localToUtc(f.tenantId, daysFromNow(10), '10:00');
    const book = (i: number) =>
      tx((db) =>
        createAppointment(db, {
          tenantId: f.tenantId, serviceId: f.serviceId, staffId: null, startsAt,
          client: { name: `Any ${i}`, email: `any${i}@example.com` }, source: 'online',
        }),
      );
    const a = await book(1);
    const b = await book(2);
    expect(new Set([a.staffId, b.staffId])).toEqual(new Set([f.staffId, f.staff2Id]));
    await expect(book(3)).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});

describe('plan limits', () => {
  it('stops online bookings at 40 per month on Free, and offers only one staff member', async () => {
    const f = await createFixture({ plan: 'free' });
    const client = await pool.query(`insert into clients (tenant_id, name) values ($1, 'Bulk') returning id`, [f.tenantId]);
    // 40 online bookings this month, each in its own hour far in the future.
    for (let i = 0; i < 40; i++) {
      const s = new Date(Date.UTC(2027, 5, 1 + i, 8));
      await pool.query(
        `insert into appointments (tenant_id, staff_id, service_id, client_id, service_name, starts_at, ends_at, blocked_until, source)
         values ($1, $2, $3, $4, 'Haircut', $5, $6, $6, 'online')`,
        [f.tenantId, f.staffId, f.serviceId, client.rows[0].id, s, new Date(s.getTime() + 3_600_000)],
      );
    }
    const startsAt = await localToUtc(f.tenantId, daysFromNow(2), '10:00');
    await expect(
      tx((db) =>
        createAppointment(db, {
          tenantId: f.tenantId, serviceId: f.serviceId, staffId: null, startsAt,
          client: { name: 'Over', email: 'over@example.com' }, source: 'online',
        }),
      ),
    ).rejects.toMatchObject({ code: 'booking_limit_reached' });

    // Manual bookings by the business are never blocked by the online quota.
    await tx((db) => withTenantlessBook(db, f, daysFromNow(2), '12:00'));

    // Free plan exposes only the first staff member.
    await expect(
      tx((db) =>
        createAppointment(db, {
          tenantId: f.tenantId, serviceId: f.serviceId, staffId: f.staff2Id, startsAt,
          client: { name: 'Second', email: 'second@example.com' }, source: 'manual',
        }),
      ),
    ).rejects.toMatchObject({ code: 'slot_unavailable' });
  });
});

describe('row-level security', () => {
  it('confines a tenant-scoped transaction to that tenant', async () => {
    const a = await createFixture();
    const b = await createFixture();
    await tx((db) => withTenantlessBook(db, b, daysFromNow(3), '10:00'));
    const seen = await withTenant(a.tenantId, (db) => many(db, 'select tenant_id from appointments'));
    expect(seen.every((r) => r.tenant_id === a.tenantId)).toBe(true);
    const staff = await withTenant(a.tenantId, (db) => many(db, 'select id from staff'));
    expect(staff.map((s) => s.id).sort()).toEqual([a.staffId, a.staff2Id].sort());
    await expect(
      withTenant(a.tenantId, (db) =>
        db.query(`insert into services (tenant_id, name, duration_min) values ($1, 'x', 30)`, [b.tenantId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
