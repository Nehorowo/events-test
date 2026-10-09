import { many, one, type Db } from '../db.js';
import { tenantPlan } from './plans.js';

export type AppointmentEvent = 'booked' | 'cancelled' | 'rescheduled';
export type Actor = 'client' | 'business';

/**
 * Queues every notification an appointment change causes. Runs inside the
 * caller's transaction, so a rolled-back booking never sends anything.
 *
 * - The client is emailed about every change (with an .ics file).
 * - The business is emailed and pushed only for changes the client made;
 *   changes staff make themselves need no alert.
 */
export async function queueAppointmentEvent(
  db: Db,
  appointmentId: string,
  event: AppointmentEvent,
  actor: Actor,
  extra: { previousStart?: string } = {},
): Promise<void> {
  const appt = await one<{ tenant_id: string; staff_id: string; client_email: string | null; staff_email: string | null }>(
    db,
    `select a.tenant_id, a.staff_id, c.email as client_email, s.email as staff_email
       from appointments a
       join clients c on c.id = a.client_id
       join staff s on s.id = a.staff_id
      where a.id = $1`,
    [appointmentId],
  );
  if (!appt) return;
  const payload = JSON.stringify({ event, actor, ...extra });
  const rows: [string, string, string][] = [];

  if (appt.client_email) rows.push(['email', `client_${event}`, appt.client_email]);

  if (actor === 'client') {
    const members = await many<{ user_id: string; email: string; role: string; staff_id: string | null }>(
      db,
      `select m.user_id, u.email, m.role, m.staff_id
         from memberships m join users u on u.id = m.user_id
        where m.tenant_id = $1`,
      [appt.tenant_id],
    );
    // Owners/admins hear about every booking; staff only about their own.
    const audience = members.filter((m) => m.role !== 'staff' || m.staff_id === appt.staff_id);
    const emails = new Set(audience.map((m) => m.email.toLowerCase()));
    if (appt.staff_email) emails.add(appt.staff_email.toLowerCase());
    for (const e of emails) rows.push(['email', `owner_${event}`, e]);

    const { limits } = await tenantPlan(db, appt.tenant_id);
    if (limits.push) for (const m of audience) rows.push(['push', `owner_${event}`, m.user_id]);
  }

  for (const [channel, kind, recipient] of rows) {
    await db.query(
      `insert into notification_log (tenant_id, appointment_id, channel, kind, recipient, payload)
       values ($1, $2, $3, $4, $5, $6)`,
      [appt.tenant_id, appointmentId, channel, kind, recipient, payload],
    );
  }
  await db.query(`select pg_notify('slotwise_outbox', '')`);
}

/** A non-appointment email (sign-in link, invitation) rendered up front. */
export async function queueRawEmail(
  db: Db | { query: Db['query'] },
  tenantId: string | null,
  kind: string,
  to: string,
  message: { subject: string; html: string; text: string },
): Promise<void> {
  await db.query(
    `insert into notification_log (tenant_id, channel, kind, recipient, payload)
     values ($1, 'email', $2, $3, $4)`,
    [tenantId, kind, to, JSON.stringify(message)],
  );
  await db.query(`select pg_notify('slotwise_outbox', '')`);
}
