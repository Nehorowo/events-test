import { one, type Db } from './db.js';
import { conflict, isOverlapError, notFound, planLimit } from './lib/errors.js';
import { queueAppointmentEvent, type Actor } from './lib/notify.js';
import { bookableStaffIds, monthlyOnlineBookings, tenantPlan } from './lib/plans.js';

export interface ClientInput {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface CreateAppointmentInput {
  tenantId: string;
  serviceId: string;
  /** null = any available staff member (online only). */
  staffId: string | null;
  startsAt: Date;
  client: ClientInput;
  notes?: string | null;
  source: 'online' | 'manual';
  /** Staff may book outside working hours (e.g. a favour taken by phone). */
  ignoreHours?: boolean;
}

export interface AppointmentRef {
  id: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Serialises booking writes per tenant. The exclusion constraint already makes
 * double booking impossible; the lock additionally keeps the monthly plan
 * counter and the time-off check consistent under concurrent requests.
 */
async function lockTenant(db: Db, tenantId: string): Promise<void> {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1::text, 42))', [tenantId]);
}

/** Staff free at exactly `startsAt`, least busy that day first. */
async function freeStaffAt(
  db: Db,
  tenantId: string,
  serviceId: string,
  staffId: string | null,
  startsAt: Date,
  allowedStaff: string[],
  ignoreAppointment: string | null = null,
): Promise<string[]> {
  const { rows } = await db.query(
    `select s.staff_id
       from available_slots($1, $2, $3, ($4::timestamptz - interval '1 day')::date,
                            ($4::timestamptz + interval '1 day')::date, $5, $6) s
      where s.starts_at = $4
      order by (select count(*) from appointments a
                 where a.staff_id = s.staff_id and a.status <> 'cancelled'
                   and a.starts_at between $4::timestamptz - interval '12 hours'
                                       and $4::timestamptz + interval '12 hours'),
               s.staff_id`,
    [tenantId, serviceId, staffId, startsAt.toISOString(), ignoreAppointment, allowedStaff],
  );
  return rows.map((r) => r.staff_id as string);
}

async function upsertClient(db: Db, tenantId: string, c: ClientInput): Promise<string> {
  const email = c.email?.trim() || null;
  const phone = c.phone?.trim() || null;
  const name = c.name.trim();
  if (email) {
    const row = await one<{ id: string }>(
      db,
      `insert into clients (tenant_id, name, email, phone) values ($1, $2, $3, $4)
       on conflict (tenant_id, email) where email is not null
       do update set name = excluded.name, phone = coalesce(excluded.phone, clients.phone)
       returning id`,
      [tenantId, name, email, phone],
    );
    return row!.id;
  }
  if (phone) {
    const existing = await one<{ id: string }>(
      db,
      `select id from clients where tenant_id = $1 and phone = $2 order by created_at limit 1`,
      [tenantId, phone],
    );
    if (existing) return existing.id;
  }
  const row = await one<{ id: string }>(
    db,
    `insert into clients (tenant_id, name, email, phone) values ($1, $2, null, $3) returning id`,
    [tenantId, name, phone],
  );
  return row!.id;
}

export async function createAppointment(db: Db, input: CreateAppointmentInput): Promise<AppointmentRef> {
  const { tenantId, source } = input;
  await lockTenant(db, tenantId);

  const service = await one<{ id: string; name: string; duration_min: number; buffer_min: number; price_cents: number; currency: string; active: boolean }>(
    db,
    'select * from services where id = $1 and tenant_id = $2',
    [input.serviceId, tenantId],
  );
  if (!service || (source === 'online' && !service.active)) throw notFound('service_not_found');

  const { limits } = await tenantPlan(db, tenantId);
  if (source === 'online' && limits.monthlyBookings !== null) {
    const used = await monthlyOnlineBookings(db, tenantId);
    if (used >= limits.monthlyBookings) throw planLimit('booking_limit_reached');
  }

  let staffId: string;
  if (input.ignoreHours && input.staffId) {
    const staff = await one(db, 'select id from staff where id = $1 and tenant_id = $2', [input.staffId, tenantId]);
    if (!staff) throw notFound('staff_not_found');
    staffId = input.staffId;
  } else {
    const allowed = await bookableStaffIds(db, tenantId, limits.maxStaff);
    const free = await freeStaffAt(db, tenantId, service.id, input.staffId, input.startsAt, allowed);
    if (!free[0]) throw conflict('slot_unavailable');
    staffId = free[0];
  }

  const clientId = await upsertClient(db, tenantId, input.client);
  const endsAt = new Date(input.startsAt.getTime() + service.duration_min * 60_000);
  const blockedUntil = new Date(endsAt.getTime() + service.buffer_min * 60_000);

  let id: string;
  try {
    await db.query('savepoint book');
    const row = await one<{ id: string }>(
      db,
      `insert into appointments (tenant_id, staff_id, service_id, client_id, service_name, price_cents,
                                 currency, starts_at, ends_at, blocked_until, source, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id`,
      [tenantId, staffId, service.id, clientId, service.name, service.price_cents, service.currency,
       input.startsAt, endsAt, blockedUntil, source, input.notes ?? null],
    );
    id = row!.id;
  } catch (err) {
    if (isOverlapError(err)) {
      await db.query('rollback to savepoint book');
      throw conflict('slot_taken');
    }
    throw err;
  }

  await queueAppointmentEvent(db, id, 'booked', source === 'online' ? 'client' : 'business');
  return { id, staffId, startsAt: input.startsAt, endsAt };
}

export interface RescheduleInput {
  tenantId: string;
  appointmentId: string;
  startsAt: Date;
  /** Keep the current staff member when omitted. */
  staffId?: string | null;
  actor: Actor;
  ignoreHours?: boolean;
}

export async function rescheduleAppointment(db: Db, input: RescheduleInput): Promise<AppointmentRef> {
  await lockTenant(db, input.tenantId);
  const appt = await one<{ id: string; staff_id: string; service_id: string | null; starts_at: Date; ends_at: Date; blocked_until: Date; status: string }>(
    db,
    'select * from appointments where id = $1 and tenant_id = $2 for update',
    [input.appointmentId, input.tenantId],
  );
  if (!appt) throw notFound('appointment_not_found');
  if (appt.status !== 'confirmed') throw conflict('appointment_not_active');

  const durationMs = appt.ends_at.getTime() - appt.starts_at.getTime();
  const bufferMs = appt.blocked_until.getTime() - appt.ends_at.getTime();
  const wantedStaff = input.staffId === undefined ? appt.staff_id : input.staffId;

  let staffId: string;
  if (input.ignoreHours || !appt.service_id) {
    staffId = wantedStaff ?? appt.staff_id;
    const staff = await one(db, 'select id from staff where id = $1 and tenant_id = $2', [staffId, input.tenantId]);
    if (!staff) throw notFound('staff_not_found');
  } else {
    const { limits } = await tenantPlan(db, input.tenantId);
    const allowed = await bookableStaffIds(db, input.tenantId, limits.maxStaff);
    const free = await freeStaffAt(db, input.tenantId, appt.service_id, wantedStaff, input.startsAt, allowed, appt.id);
    if (!free[0]) throw conflict('slot_unavailable');
    staffId = free[0];
  }

  const endsAt = new Date(input.startsAt.getTime() + durationMs);
  try {
    await db.query('savepoint resched');
    await db.query(
      `update appointments
          set starts_at = $2, ends_at = $3, blocked_until = $4, staff_id = $5, reminder_sent_at = null
        where id = $1`,
      [appt.id, input.startsAt, endsAt, new Date(endsAt.getTime() + bufferMs), staffId],
    );
  } catch (err) {
    if (isOverlapError(err)) {
      await db.query('rollback to savepoint resched');
      throw conflict('slot_taken');
    }
    throw err;
  }

  await queueAppointmentEvent(db, appt.id, 'rescheduled', input.actor, {
    previousStart: appt.starts_at.toISOString(),
  });
  return { id: appt.id, staffId, startsAt: input.startsAt, endsAt };
}

export async function cancelAppointment(
  db: Db,
  tenantId: string,
  appointmentId: string,
  actor: Actor,
): Promise<void> {
  const res = await db.query(
    `update appointments
        set status = 'cancelled', cancelled_at = now(), cancelled_by = $3
      where id = $1 and tenant_id = $2 and status = 'confirmed'`,
    [appointmentId, tenantId, actor],
  );
  if (res.rowCount === 0) throw conflict('appointment_not_active');
  await queueAppointmentEvent(db, appointmentId, 'cancelled', actor);
}
