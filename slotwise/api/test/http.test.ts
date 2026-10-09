import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { many, one, pool } from '../src/db.js';
import { processOutbox, queueReminders } from '../src/outbox.js';
import { daysFromNow, resetDb } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Signs in through the real magic-link flow and returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/magic-link', payload: { email } });
  expect(res.statusCode).toBe(200);
  const row = await one<{ payload: { text: string } }>(
    pool,
    `select payload from notification_log where kind = 'login_link' and recipient = $1 order by id desc limit 1`,
    [email],
  );
  const link = row!.payload.text.match(/https?:\/\/\S+\/api\/auth\/verify\?token=\S+/)![0];
  const verify = await app.inject({ method: 'GET', url: link.replace(/^https?:\/\/[^/]+/, '') });
  expect(verify.statusCode).toBe(302);
  const cookie = [verify.headers['set-cookie']].flat().find((c) => c?.startsWith('sw_session='));
  return cookie!.split(';')[0]!;
}

describe('owner onboarding → public booking → client self-service', () => {
  let cookie: string;
  let tenantId: string;
  let serviceId: string;
  let staffId: string;
  let manageToken: string;
  const slug = 'elena-beauty';

  it('signs up with a magic link and creates a business', async () => {
    cookie = await signIn('elena@example.com');
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.user.email).toBe('elena@example.com');
    expect(me.memberships).toHaveLength(0);

    const res = await app.inject({
      method: 'POST', url: '/api/tenants', headers: { cookie },
      payload: { name: 'Elena Beauty', slug, timezone: 'Europe/Nicosia' },
    });
    expect(res.statusCode).toBe(200);
    tenantId = res.json().id;

    const dup = await app.inject({
      method: 'POST', url: '/api/tenants', headers: { cookie },
      payload: { name: 'Copy', slug, timezone: 'Europe/Nicosia' },
    });
    expect(dup.json().error).toBe('slug_taken');

    const reserved = await app.inject({
      method: 'POST', url: '/api/tenants', headers: { cookie },
      payload: { name: 'X', slug: 'app', timezone: 'Europe/Nicosia' },
    });
    expect(reserved.statusCode).toBe(400);
  });

  it('adds a service, opens every day and publishes', async () => {
    const svc = await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/services`, headers: { cookie },
      payload: { name: 'Manicure', durationMin: 45, priceCents: 2500 },
    });
    expect(svc.statusCode).toBe(200);
    serviceId = svc.json().id;

    const staff = (await app.inject({ method: 'GET', url: `/api/t/${tenantId}/staff`, headers: { cookie } })).json();
    expect(staff).toHaveLength(1);
    staffId = staff[0].id;
    expect(staff[0].hours).toHaveLength(5); // default Mon–Fri

    const hours = await app.inject({
      method: 'PUT', url: `/api/t/${tenantId}/staff/${staffId}/hours`, headers: { cookie },
      payload: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
    });
    expect(hours.statusCode).toBe(200);

    // Free plan: a second active staff member is refused.
    const second = await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/staff`, headers: { cookie }, payload: { name: 'Maria' },
    });
    expect(second.statusCode).toBe(402);

    const pub = await app.inject({
      method: 'PATCH', url: `/api/t/${tenantId}`, headers: { cookie }, payload: { published: true, onboardingDone: true },
    });
    expect(pub.statusCode).toBe(200);
  });

  it('shows the public page and books in one request', async () => {
    const page = (await app.inject({ method: 'GET', url: `/api/public/${slug}` })).json();
    expect(page.acceptingBookings).toBe(true);
    expect(page.badge).toBe(true);
    expect(page.services[0].name).toBe('Manicure');

    const date = daysFromNow(3);
    const days = (await app.inject({
      method: 'GET', url: `/api/public/${slug}/availability?serviceId=${serviceId}&from=${date}&days=7`,
    })).json();
    expect(days).toHaveLength(7);
    expect(days[0].slots).toBeGreaterThan(0);

    const slots = (await app.inject({
      method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&date=${date}`,
    })).json();
    expect(slots[0].time).toBe('09:00');

    const book = await app.inject({
      method: 'POST', url: `/api/public/${slug}/book`,
      payload: { serviceId, startsAt: slots[0].startsAt, name: 'Chloe', email: 'chloe@example.com', phone: '+357 99 123456' },
    });
    expect(book.statusCode).toBe(200);
    manageToken = book.json().manageToken;

    const again = await app.inject({
      method: 'POST', url: `/api/public/${slug}/book`,
      payload: { serviceId, startsAt: slots[0].startsAt, name: 'Late', email: 'late@example.com', phone: '+357 99 000000' },
    });
    expect(again.statusCode).toBe(409);

    const after = (await app.inject({
      method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&date=${date}`,
    })).json();
    expect(after.map((s: { time: string }) => s.time)).not.toContain('09:00');
  });

  it('queues a client confirmation and an owner alert, and sends them', async () => {
    const queued = await many(pool, `select kind, recipient from notification_log where appointment_id is not null order by id`);
    expect(queued).toEqual(
      expect.arrayContaining([
        { kind: 'client_booked', recipient: 'chloe@example.com' },
        { kind: 'owner_booked', recipient: 'elena@example.com' },
      ]),
    );
    const result = await processOutbox();
    expect(result.failed).toBe(0);
    const pending = await one(pool, `select count(*)::int as n from notification_log where status = 'pending'`);
    expect(pending.n).toBe(0);
  });

  it('lets the client view, get an .ics, reschedule and cancel without an account', async () => {
    const view = (await app.inject({ method: 'GET', url: `/api/public/manage/${manageToken}` })).json();
    expect(view.clientName).toBe('Chloe');
    expect(view.status).toBe('confirmed');

    const ics = await app.inject({ method: 'GET', url: `/api/public/manage/${manageToken}/ics` });
    expect(ics.body).toContain('BEGIN:VEVENT');

    const tampered = await app.inject({ method: 'GET', url: `/api/public/manage/${manageToken.slice(0, -2)}xx` });
    expect(tampered.statusCode).toBe(404);

    const date = daysFromNow(4);
    const slots = (await app.inject({
      method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&date=${date}&ignore=${manageToken}`,
    })).json();
    const moved = await app.inject({
      method: 'POST', url: `/api/public/manage/${manageToken}/reschedule`, payload: { startsAt: slots[2].startsAt },
    });
    expect(moved.statusCode).toBe(200);
    manageToken = moved.json().manageToken;

    const cancel = await app.inject({ method: 'POST', url: `/api/public/manage/${manageToken}/cancel` });
    expect(cancel.statusCode).toBe(200);
    const kinds = (await many(pool, `select kind from notification_log where status = 'pending'`)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['client_rescheduled', 'owner_rescheduled', 'client_cancelled', 'owner_cancelled']));
  });

  it('keeps staff to their own calendar and isolates other tenants', async () => {
    // Upgrade (dev billing mode) to add a second staff member.
    const up = await app.inject({ method: 'POST', url: `/api/t/${tenantId}/billing/checkout`, headers: { cookie }, payload: {} });
    expect(up.statusCode).toBe(200);
    const maria = (await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/staff`, headers: { cookie }, payload: { name: 'Maria' },
    })).json();
    const inv = (await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/staff/${maria.id}/invite`, headers: { cookie },
      payload: { email: 'maria@example.com' },
    })).json();
    const token = inv.inviteUrl.split('/invite/')[1];

    const mariaCookie = await signIn('maria@example.com');
    const accept = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: { cookie: mariaCookie } });
    expect(accept.statusCode).toBe(200);

    // Owner books Elena (owner's staff record) manually.
    const manual = await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/appointments`, headers: { cookie },
      payload: { serviceId, staffId, date: daysFromNow(5), time: '11:00', client: { name: 'Phone client', phone: '+35799111111' } },
    });
    expect(manual.statusCode).toBe(200);

    const from = daysFromNow(0);
    const to = daysFromNow(10);
    const mine = (await app.inject({
      method: 'GET', url: `/api/t/${tenantId}/appointments?from=${from}&to=${to}`, headers: { cookie: mariaCookie },
    })).json();
    expect(mine).toHaveLength(0);
    const all = (await app.inject({
      method: 'GET', url: `/api/t/${tenantId}/appointments?from=${from}&to=${to}`, headers: { cookie },
    })).json();
    expect(all).toHaveLength(1);

    const settings = await app.inject({ method: 'PATCH', url: `/api/t/${tenantId}`, headers: { cookie: mariaCookie }, payload: { name: 'Hacked' } });
    expect(settings.statusCode).toBe(403);
    const block = await app.inject({
      method: 'POST', url: `/api/t/${tenantId}/time-off`, headers: { cookie: mariaCookie },
      payload: { staffId, kind: 'day_off', startDate: from, endDate: from },
    });
    expect(block.statusCode).toBe(403);

    const stranger = await signIn('stranger@example.com');
    const peek = await app.inject({ method: 'GET', url: `/api/t/${tenantId}/clients`, headers: { cookie: stranger } });
    expect(peek.statusCode).toBe(403);
  });

  it('exports CSV and queues reminders for appointments 24 h out', async () => {
    const csv = await app.inject({ method: 'GET', url: `/api/t/${tenantId}/export/appointments.csv`, headers: { cookie } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('Phone client');

    // An appointment created a week ago, starting in 23h50m, is due a reminder.
    const appt = await one(pool, `select id from appointments where tenant_id = $1 and status = 'confirmed' limit 1`, [tenantId]);
    await pool.query(
      `update appointments set created_at = now() - interval '7 days', starts_at = now() + interval '23 hours 50 minutes',
              ends_at = now() + interval '24 hours 35 minutes', blocked_until = now() + interval '24 hours 35 minutes'
        where id = $1`,
      [appt.id],
    );
    await pool.query(`update clients set email = 'phone@example.com' where name = 'Phone client'`);
    expect(await queueReminders()).toBe(1);
    expect(await queueReminders()).toBe(0);
  });
});
