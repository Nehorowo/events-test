import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelAppointment, createAppointment, rescheduleAppointment } from '../booking.js';
import { manyCamel, one, withTenant, type Db } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isManager, MANAGERS, parse, requireMember, zDate, zEmail, zPhone, zTime, zUuid } from '../http.js';
import { assertStaffScope, tenantIdParam } from './tenant.js';

const APPOINTMENT_SELECT = `
  select a.id, a.staff_id, a.service_id, a.client_id, a.service_name, a.price_cents, a.currency,
         a.starts_at, a.ends_at, a.blocked_until, a.status, a.source, a.notes, a.created_at,
         a.cancelled_at, a.cancelled_by,
         c.name as client_name, c.email as client_email, c.phone as client_phone,
         s.name as staff_name,
         to_char(a.starts_at at time zone t.timezone, 'YYYY-MM-DD"T"HH24:MI') as local_start,
         to_char(a.ends_at at time zone t.timezone, 'YYYY-MM-DD"T"HH24:MI') as local_end
    from appointments a
    join clients c on c.id = a.client_id
    join staff s on s.id = a.staff_id
    join tenants t on t.id = a.tenant_id`;

async function localToUtc(db: Db, tenantId: string, date: string, time: string): Promise<Date> {
  const row = await one<{ ts: Date }>(db, 'select tenant_local_to_utc($1, $2::date, $3::time) as ts', [tenantId, date, time]);
  return row!.ts;
}

export async function appointmentRoutes(app: FastifyInstance) {
  app.get('/api/t/:tid/appointments', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const q = parse(
      z.object({ from: zDate, to: zDate, staffId: zUuid.optional(), includeCancelled: z.coerce.boolean().optional() }),
      req.query,
    );
    // Staff see only their own calendar unless they are an admin.
    const staffId = isManager(m) ? q.staffId ?? null : m.staffId;
    if (!isManager(m) && !staffId) return [];
    return withTenant(tid, (db) =>
      manyCamel(
        db,
        `${APPOINTMENT_SELECT}
          where a.starts_at < tenant_local_to_utc($1, $3::date + 1, '00:00')
            and a.ends_at > tenant_local_to_utc($1, $2::date, '00:00')
            and ($4::uuid is null or a.staff_id = $4)
            and ($5 or a.status <> 'cancelled')
          order by a.starts_at`,
        [tid, q.from, q.to, staffId, q.includeCancelled ?? false],
      ),
    );
  });

  app.get('/api/t/:tid/clients/:id/appointments', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(tid, (db) =>
      manyCamel(db, `${APPOINTMENT_SELECT} where a.client_id = $1 order by a.starts_at desc limit 200`, [id]),
    );
  });

  /** A booking taken by phone or in person. */
  app.post('/api/t/:tid/appointments', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const b = parse(
      z.object({
        serviceId: zUuid,
        staffId: zUuid,
        date: zDate,
        time: zTime,
        client: z.object({
          id: zUuid.optional(),
          name: z.string().trim().min(1).max(80),
          email: zEmail.nullable().optional().or(z.literal('').transform(() => null)),
          phone: zPhone.nullable().optional(),
        }),
        notes: z.string().max(1000).nullable().optional(),
      }),
      req.body,
    );
    assertStaffScope(m, b.staffId);
    return withTenant(tid, async (db) => {
      const startsAt = await localToUtc(db, tid, b.date, b.time);
      return createAppointment(db, {
        tenantId: tid,
        serviceId: b.serviceId,
        staffId: b.staffId,
        startsAt,
        client: b.client,
        notes: b.notes,
        source: 'manual',
        ignoreHours: true,
      });
    });
  });

  app.patch('/api/t/:tid/appointments/:id', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z.object({
        date: zDate.optional(),
        time: zTime.optional(),
        staffId: zUuid.optional(),
        status: z.enum(['confirmed', 'completed', 'no_show']).optional(),
        notes: z.string().max(1000).nullable().optional(),
      }),
      req.body,
    );
    return withTenant(tid, async (db) => {
      const appt = await one<{ staff_id: string; status: string }>(db, 'select staff_id, status from appointments where id = $1', [id]);
      if (!appt) throw notFound();
      assertStaffScope(m, appt.staff_id);
      if (b.staffId) assertStaffScope(m, b.staffId);

      if (b.date || b.time || b.staffId) {
        if (!b.date || !b.time) throw badRequest('date_and_time_required');
        await rescheduleAppointment(db, {
          tenantId: tid,
          appointmentId: id,
          startsAt: await localToUtc(db, tid, b.date, b.time),
          staffId: b.staffId ?? appt.staff_id,
          actor: 'business',
          ignoreHours: true,
        });
      }
      if (b.status && b.status !== appt.status) {
        if (appt.status === 'cancelled') throw badRequest('appointment_cancelled');
        await db.query('update appointments set status = $2 where id = $1', [id, b.status]);
      }
      if (b.notes !== undefined) {
        await db.query('update appointments set notes = $2 where id = $1', [id, b.notes]);
      }
      return { ok: true };
    });
  });

  app.post('/api/t/:tid/appointments/:id/cancel', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await withTenant(tid, async (db) => {
      const appt = await one<{ staff_id: string }>(db, 'select staff_id from appointments where id = $1', [id]);
      if (!appt) throw notFound();
      assertStaffScope(m, appt.staff_id);
      await cancelAppointment(db, tid, id, 'business');
    });
    return { ok: true };
  });

  // ── CSV export: an answer to lock-in fears ──────────────────────────────────
  const csv = (rows: Record<string, unknown>[], columns: string[]) => {
    const cell = (v: unknown) => {
      if (v === null || v === undefined) return '';
      let s = v instanceof Date ? v.toISOString() : String(v);
      // Neutralise spreadsheet formula injection.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  };

  app.get('/api/t/:tid/export/clients.csv', async (req, reply) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const rows = await withTenant(tid, (db) =>
      db.query('select name, email, phone, notes, created_at from clients order by name').then((r) => r.rows),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="clients.csv"');
    return '﻿' + csv(rows, ['name', 'email', 'phone', 'notes', 'created_at']);
  });

  app.get('/api/t/:tid/export/appointments.csv', async (req, reply) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const rows = await withTenant(tid, (db) =>
      db
        .query(
          `select to_char(a.starts_at at time zone t.timezone, 'YYYY-MM-DD HH24:MI') as local_start,
                  to_char(a.ends_at at time zone t.timezone, 'YYYY-MM-DD HH24:MI') as local_end,
                  a.service_name, s.name as staff, c.name as client, c.email as client_email,
                  c.phone as client_phone, a.status, a.source, a.price_cents::numeric / 100 as price,
                  a.currency, a.notes, a.created_at
             from appointments a join clients c on c.id = a.client_id join staff s on s.id = a.staff_id
             join tenants t on t.id = a.tenant_id
            order by a.starts_at`,
        )
        .then((r) => r.rows),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="appointments.csv"');
    return '﻿' + csv(rows, ['local_start', 'local_end', 'service_name', 'staff', 'client', 'client_email',
      'client_phone', 'status', 'source', 'price', 'currency', 'notes', 'created_at']);
  });
}
