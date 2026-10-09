import { config } from './config.js';
import { one, pool } from './db.js';
import { sendEmail, type EmailMessage } from './lib/email.js';
import { buildIcs } from './lib/ics.js';
import { asLocale, formatWhen, t } from './lib/i18n.js';
import { tenantPlan } from './lib/plans.js';
import { pushToUser } from './lib/push.js';
import { emailLayout } from './lib/templates.js';
import { manageUrl } from './lib/tokens.js';

interface OutboxRow {
  id: number;
  tenant_id: string | null;
  appointment_id: string | null;
  channel: 'email' | 'push';
  kind: string;
  recipient: string;
  payload: Record<string, any>;
  attempts: number;
}

interface ApptDetails {
  id: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  service_name: string;
  staff_name: string;
  client_name: string;
  tenant_name: string;
  slug: string;
  timezone: string;
  address: string | null;
  tenant_phone: string | null;
  locale: string;
  brand_color: string | null;
  tenant_id: string;
}

/**
 * Queues 24-hour reminders. Marking reminder_sent_at and inserting the email
 * happen in one statement, so a reminder is queued exactly once. Appointments
 * booked less than 24 h ahead skip it: the confirmation is fresh enough.
 */
export async function queueReminders(): Promise<number> {
  const res = await pool.query(
    `with due as (
       update appointments a set reminder_sent_at = now()
        where a.status = 'confirmed' and a.reminder_sent_at is null
          and a.starts_at > now() + interval '1 hour'
          and a.starts_at <= now() + interval '24 hours'
          and a.created_at <= a.starts_at - interval '24 hours'
       returning a.id, a.tenant_id, a.client_id
     )
     insert into notification_log (tenant_id, appointment_id, channel, kind, recipient, payload)
     select d.tenant_id, d.id, 'email', 'client_reminder', c.email, '{}'::jsonb
       from due d join clients c on c.id = d.client_id
      where c.email is not null`,
  );
  return res.rowCount ?? 0;
}

async function loadAppointment(id: string): Promise<ApptDetails | undefined> {
  return one<ApptDetails>(
    pool,
    `select a.id, a.starts_at, a.ends_at, a.status, a.service_name, s.name as staff_name,
            c.name as client_name, t.name as tenant_name, t.slug, t.timezone, t.address,
            t.phone as tenant_phone, t.locale, t.brand_color, t.id as tenant_id
       from appointments a
       join staff s on s.id = a.staff_id
       join clients c on c.id = a.client_id
       join tenants t on t.id = a.tenant_id
      where a.id = $1`,
    [id],
  );
}

export async function renderAppointmentEmail(row: OutboxRow, a: ApptDetails): Promise<EmailMessage> {
  const locale = asLocale(a.locale);
  const s = t(locale);
  const when = formatWhen(a.starts_at, a.timezone, locale);
  const { limits } = await tenantPlan(pool, a.tenant_id);
  const accent = limits.branding && a.brand_color ? a.brand_color : undefined;
  const [audience, event] = row.kind.split('_') as ['client' | 'owner', string];
  const detailRows: [string, string][] = [
    [s.service, a.service_name],
    [s.with, a.staff_name],
    [s.when, when],
  ];
  if (a.address) detailRows.push([s.where, a.address]);
  if (event === 'rescheduled' && row.payload.previousStart) {
    detailRows.push([s.previously, formatWhen(new Date(row.payload.previousStart), a.timezone, locale)]);
  }

  if (audience === 'owner') {
    const short = formatWhen(a.starts_at, a.timezone, locale, 'short');
    const subject =
      event === 'cancelled' ? s.ownerCancelledSubject(a.client_name, short)
      : event === 'rescheduled' ? s.ownerRescheduledSubject(a.client_name, short)
      : s.ownerNewSubject(a.client_name, short);
    const body = emailLayout({
      heading: subject,
      intro: a.tenant_name,
      rows: [[s.client, a.client_name], ...detailRows],
      button: { label: s.openCalendar, url: `${config.appUrl}/app?date=${a.starts_at.toISOString().slice(0, 10)}` },
      accent,
    });
    return { to: row.recipient, subject, ...body };
  }

  const cancelled = event === 'cancelled';
  const subject =
    event === 'cancelled' ? s.cancelledSubject(a.tenant_name)
    : event === 'rescheduled' ? s.rescheduledSubject(a.tenant_name)
    : event === 'reminder' ? s.reminderSubject(a.tenant_name)
    : s.bookedSubject(a.tenant_name);
  const intro =
    event === 'cancelled' ? s.cancelledIntro(a.client_name)
    : event === 'rescheduled' ? s.rescheduledIntro(a.client_name)
    : event === 'reminder' ? s.reminderIntro(a.client_name)
    : s.bookedIntro(a.client_name);
  const link = manageUrl(a.id, a.starts_at);
  const body = emailLayout({
    heading: subject,
    intro,
    rows: detailRows,
    button: cancelled
      ? { label: s.bookAgain, url: `${config.appUrl}/${a.slug}` }
      : { label: s.manageButton, url: link },
    footer: `${s.footer} ${a.tenant_name}${a.tenant_phone ? ` · ${a.tenant_phone}` : ''}`,
    accent,
  });
  const ics = buildIcs({
    uid: a.id,
    start: a.starts_at,
    end: a.ends_at,
    summary: `${a.service_name} — ${a.tenant_name}`,
    description: cancelled ? undefined : link,
    location: a.address ?? undefined,
    url: cancelled ? undefined : link,
    cancelled,
  });
  return {
    to: row.recipient,
    subject,
    ...body,
    attachments: [{ filename: 'appointment.ics', content: ics, contentType: 'text/calendar; charset=utf-8' }],
  };
}

async function deliver(row: OutboxRow): Promise<void> {
  if (!row.appointment_id) {
    // Pre-rendered message (sign-in link, invitation).
    const p = row.payload as { subject: string; html: string; text: string };
    await sendEmail({ to: row.recipient, subject: p.subject, html: p.html, text: p.text });
    return;
  }
  const a = await loadAppointment(row.appointment_id);
  if (!a) return; // appointment deleted since; nothing to say
  if (row.kind === 'client_reminder' && a.status !== 'confirmed') return;

  if (row.channel === 'email') {
    await sendEmail(await renderAppointmentEmail(row, a));
    return;
  }
  const s = t(asLocale(a.locale));
  const event = row.kind.split('_')[1];
  const title = event === 'cancelled' ? s.pushCancelled : event === 'rescheduled' ? s.pushRescheduled : s.pushNew;
  await pushToUser(row.recipient, {
    title,
    body: `${a.client_name} · ${a.service_name} · ${formatWhen(a.starts_at, a.timezone, asLocale(a.locale), 'short')}`,
    url: `/app?date=${a.starts_at.toISOString().slice(0, 10)}`,
    tag: a.id,
  });
}

/** Claims a batch of due messages and sends them, with exponential backoff on failure. */
export async function processOutbox(batch = 25): Promise<{ sent: number; failed: number }> {
  const { rows } = await pool.query<OutboxRow>(
    `update notification_log n
        set attempts = n.attempts + 1,
            send_after = now() + make_interval(mins => power(2, n.attempts)::int)
      where n.id in (
        select id from notification_log
         where status = 'pending' and send_after <= now()
         order by id limit $1 for update skip locked)
      returning n.*`,
    [batch],
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deliver(row);
      await pool.query(`update notification_log set status = 'sent', sent_at = now(), last_error = null where id = $1`, [row.id]);
      sent++;
    } catch (err) {
      failed++;
      const final = row.attempts >= config.worker.maxAttempts;
      await pool.query(
        `update notification_log set status = $2, last_error = $3 where id = $1`,
        [row.id, final ? 'failed' : 'pending', String((err as Error).message ?? err).slice(0, 1000)],
      );
      console.error(`[outbox] ${row.kind} #${row.id} attempt ${row.attempts} failed:`, (err as Error).message);
    }
  }
  return { sent, failed };
}

export async function housekeeping(): Promise<void> {
  await pool.query(`delete from login_tokens where expires_at < now() - interval '1 day'`);
  await pool.query(`delete from sessions where expires_at < now()`);
  await pool.query(`delete from notification_log where status = 'sent' and sent_at < now() - interval '90 days'`);
}
