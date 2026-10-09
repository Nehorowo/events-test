import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { cancelAppointment, createAppointment, rescheduleAppointment } from '../booking.js';
import { config } from '../config.js';
import { manyCamel, one, oneCamel, pool, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { buildIcs } from '../lib/ics.js';
import { bookableStaffIds, monthlyOnlineBookings, tenantPlan } from '../lib/plans.js';
import { manageTokenFor, verifyManageToken } from '../lib/tokens.js';
import { parse, zDate, zEmail, zPhone, zUuid } from '../http.js';

interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  phone: string | null;
  logo_data: string | null;
  brand_color: string | null;
  locale: string;
  published: boolean;
  max_days_ahead: number;
}

async function tenantBySlug(slug: string): Promise<PublicTenant> {
  const t = await one<PublicTenant>(
    pool,
    `select id, slug, name, timezone, address, phone, logo_data, brand_color, locale, published, max_days_ahead
       from tenants where slug = $1`,
    [slug.toLowerCase()],
  );
  if (!t) throw notFound('business_not_found');
  return t;
}

export async function publicTenantInfo(slug: string) {
  const t = await tenantBySlug(slug);
  const plan = await tenantPlan(pool, t.id);
  const staffIds = await bookableStaffIds(pool, t.id, plan.limits.maxStaff);
  const services = await manyCamel(
    pool,
    `select id, name, description, duration_min, price_cents, currency
       from services where tenant_id = $1 and active order by sort, created_at`,
    [t.id],
  );
  const staff = await manyCamel(
    pool,
    'select id, name from staff where id = any($1) order by sort, created_at',
    [staffIds],
  );
  const limitReached =
    plan.limits.monthlyBookings !== null && (await monthlyOnlineBookings(pool, t.id)) >= plan.limits.monthlyBookings;
  return {
    tenant: {
      slug: t.slug,
      name: t.name,
      timezone: t.timezone,
      address: t.address,
      phone: t.phone,
      logoData: t.logo_data,
      brandColor: plan.limits.branding ? t.brand_color : null,
      locale: t.locale,
      maxDaysAhead: t.max_days_ahead,
    },
    published: t.published,
    acceptingBookings: t.published && !limitReached && services.length > 0 && staff.length > 0,
    badge: plan.limits.badge,
    services,
    staff,
  };
}

async function loadManaged(token: string) {
  const id = verifyManageToken(token);
  if (!id) throw notFound('link_invalid');
  const appt = await oneCamel(
    pool,
    `select a.id, a.tenant_id, a.service_id, a.staff_id, a.service_name, a.price_cents, a.currency,
            a.starts_at, a.ends_at, a.status, c.name as client_name, s.name as staff_name,
            t.slug, t.name as tenant_name, t.timezone, t.address, t.phone as tenant_phone, t.locale,
            to_char(a.starts_at at time zone t.timezone, 'YYYY-MM-DD') as local_date,
            (a.starts_at > now()) as upcoming
       from appointments a
       join clients c on c.id = a.client_id
       join staff s on s.id = a.staff_id
       join tenants t on t.id = a.tenant_id
      where a.id = $1`,
    [id],
  );
  if (!appt) throw notFound('appointment_not_found');
  return appt;
}

const slotQuery = z.object({
  serviceId: zUuid,
  staffId: zUuid.optional(),
  ignore: z.string().optional(),
});

export async function publicRoutes(app: FastifyInstance) {
  app.get('/api/public/:slug', async (req) => publicTenantInfo((req.params as { slug: string }).slug));

  /** Number of free slots per day, for the date strip. */
  app.get('/api/public/:slug/availability', async (req) => {
    const t = await tenantBySlug((req.params as { slug: string }).slug);
    const q = parse(slotQuery.extend({ from: zDate, days: z.coerce.number().int().min(1).max(62).default(14) }), req.query);
    const { limits } = await tenantPlan(pool, t.id);
    const allowed = await bookableStaffIds(pool, t.id, limits.maxStaff);
    const ignore = q.ignore ? verifyManageToken(q.ignore) : null;
    const rows = await manyCamel(
      pool,
      `select d::date::text as date, coalesce(n, 0)::int as slots
         from generate_series($4::date, $4::date + ($5::int - 1), interval '1 day') d
         left join (
           select local_date, count(distinct starts_at) as n
             from available_slots($1, $2, $3, $4::date, $4::date + ($5::int - 1), $6, $7)
            group by local_date
         ) s on s.local_date = d::date
        order by d`,
      [t.id, q.serviceId, q.staffId ?? null, q.from, q.days, ignore, allowed],
    );
    return rows;
  });

  app.get('/api/public/:slug/slots', async (req) => {
    const t = await tenantBySlug((req.params as { slug: string }).slug);
    const q = parse(slotQuery.extend({ date: zDate }), req.query);
    const { limits } = await tenantPlan(pool, t.id);
    const allowed = await bookableStaffIds(pool, t.id, limits.maxStaff);
    const ignore = q.ignore ? verifyManageToken(q.ignore) : null;
    return manyCamel(
      pool,
      `select local_time as time, starts_at, count(*)::int as staff_count
         from available_slots($1, $2, $3, $4::date, $4::date, $5, $6)
        group by local_time, starts_at
        order by starts_at`,
      [t.id, q.serviceId, q.staffId ?? null, q.date, ignore, allowed],
    );
  });

  app.post('/api/public/:slug/book', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const t = await tenantBySlug((req.params as { slug: string }).slug);
    const b = parse(
      z.object({
        serviceId: zUuid,
        staffId: zUuid.nullable().optional(),
        startsAt: z.string().datetime({ offset: true }),
        name: z.string().trim().min(1).max(80),
        email: zEmail,
        phone: zPhone.min(6).max(40),
        notes: z.string().trim().max(500).optional(),
        website: z.string().max(0).optional(), // honeypot: real people leave it empty
      }),
      req.body,
    );
    if (!t.published) throw conflict('not_accepting_bookings');
    const result = await tx((db) =>
      createAppointment(db, {
        tenantId: t.id,
        serviceId: b.serviceId,
        staffId: b.staffId ?? null,
        startsAt: new Date(b.startsAt),
        client: { name: b.name, email: b.email, phone: b.phone },
        notes: b.notes || null,
        source: 'online',
      }),
    );
    return { id: result.id, manageToken: manageTokenFor(result.id, result.startsAt) };
  });

  app.get('/api/public/:slug/qr.png', async (req, reply) => {
    const t = await tenantBySlug((req.params as { slug: string }).slug);
    const size = Math.min(Math.max(Number((req.query as { size?: string }).size) || 768, 128), 2048);
    const png = await QRCode.toBuffer(`${config.appUrl}/${t.slug}?utm_source=qr`, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'public, max-age=3600');
    if ((req.query as { download?: string }).download) {
      reply.header('content-disposition', `attachment; filename="${t.slug}-booking-qr.png"`);
    }
    return png;
  });

  // ── Client self-service via signed link ─────────────────────────────────────
  app.get('/api/public/manage/:token', async (req) => {
    const appt = await loadManaged((req.params as { token: string }).token);
    const { tenantId: _t, ...rest } = appt;
    return rest;
  });

  app.get('/api/public/manage/:token/ics', async (req, reply) => {
    const a = await loadManaged((req.params as { token: string }).token);
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="appointment.ics"');
    return buildIcs({
      uid: a.id,
      start: a.startsAt,
      end: a.endsAt,
      summary: `${a.serviceName} — ${a.tenantName}`,
      location: a.address ?? undefined,
      cancelled: a.status === 'cancelled',
    });
  });

  app.post('/api/public/manage/:token/cancel', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const a = await loadManaged((req.params as { token: string }).token);
    if (!a.upcoming) throw badRequest('appointment_in_past');
    await tx((db) => cancelAppointment(db, a.tenantId, a.id, 'client'));
    return { ok: true };
  });

  app.post('/api/public/manage/:token/reschedule', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const token = (req.params as { token: string }).token;
    const a = await loadManaged(token);
    if (!a.upcoming) throw badRequest('appointment_in_past');
    const b = parse(z.object({ startsAt: z.string().datetime({ offset: true }), staffId: zUuid.nullable().optional() }), req.body);
    const result = await tx((db) =>
      rescheduleAppointment(db, {
        tenantId: a.tenantId,
        appointmentId: a.id,
        startsAt: new Date(b.startsAt),
        staffId: b.staffId === undefined ? a.staffId : b.staffId,
        actor: 'client',
      }),
    );
    return { ok: true, manageToken: manageTokenFor(result.id, result.startsAt) };
  });
}
