import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RESERVED_SLUGS } from '../../../shared/plans.js';
import { config } from '../config.js';
import { manyCamel, one, oneCamel, pool, tx, withTenant, type Db } from '../db.js';
import { badRequest, conflict, forbidden, isUniqueError, notFound, planLimit } from '../lib/errors.js';
import { asLocale, t } from '../lib/i18n.js';
import { queueRawEmail } from '../lib/notify.js';
import { monthlyOnlineBookings, tenantPlan } from '../lib/plans.js';
import { emailLayout } from '../lib/templates.js';
import { hashToken, randomToken } from '../lib/tokens.js';
import {
  isManager,
  MANAGERS,
  parse,
  requireMember,
  requireUser,
  zDate,
  zEmail,
  zPhone,
  zTime,
  zUuid,
  type Membership,
} from '../http.js';

const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'use 3–40 letters, numbers or dashes')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'this address is reserved');

const zTenantPatch = z.object({
  name: z.string().trim().min(1).max(80),
  slug: zSlug,
  timezone: z.string().min(1).max(64),
  address: z.string().trim().max(200).nullable(),
  phone: zPhone.nullable(),
  logoData: z
    .string()
    .max(300_000)
    .regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,/, 'logo must be an image')
    .nullable(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  locale: z.enum(['en', 'el']),
  slotStepMin: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  minNoticeMin: z.number().int().min(0).max(10080),
  maxDaysAhead: z.number().int().min(1).max(365),
  published: z.boolean(),
  onboardingDone: z.boolean(),
});

const zService = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  durationMin: z.number().int().min(5).max(720),
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: z.string().length(3).toUpperCase().default('EUR'),
  bufferMin: z.number().int().min(0).max(240).default(0),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});

const zStaff = z.object({
  name: z.string().trim().min(1).max(80),
  email: zEmail.nullable().optional(),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});

const zHours = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start: zTime, end: zTime }))
  .max(50)
  .refine((rows) => rows.every((r) => r.start < r.end), 'start must be before end');

const DEFAULT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

async function validTimezone(tz: string): Promise<boolean> {
  return Boolean(await one(pool, 'select 1 from pg_timezone_names where name = $1', [tz]));
}

async function replaceHours(db: Db, tenantId: string, staffId: string, rows: z.infer<typeof zHours>) {
  await db.query('delete from working_hours where staff_id = $1', [staffId]);
  for (const r of rows) {
    await db.query(
      'insert into working_hours (tenant_id, staff_id, weekday, start_time, end_time) values ($1, $2, $3, $4, $5)',
      [tenantId, staffId, r.weekday, r.start, r.end],
    );
  }
}

async function activeStaffCount(db: Db, excludeId?: string): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    'select count(*)::int as n from staff where active and id is distinct from $1',
    [excludeId ?? null],
  );
  return row!.n;
}

async function assertStaffSeat(db: Db, tenantId: string, excludeId?: string) {
  const { limits } = await tenantPlan(db, tenantId);
  if ((await activeStaffCount(db, excludeId)) >= limits.maxStaff) {
    throw planLimit('staff_limit_reached', `Your plan allows ${limits.maxStaff} active staff`);
  }
}

/** Staff may only touch their own calendar entries; managers may touch any. */
export function assertStaffScope(m: Membership, staffId: string) {
  if (!isManager(m) && m.staffId !== staffId) throw forbidden('own_calendar_only');
}

export function tenantIdParam(req: FastifyRequest): string {
  return (req.params as { tid: string }).tid;
}

export async function tenantRoutes(app: FastifyInstance) {
  // ── Business ────────────────────────────────────────────────────────────────
  app.post('/api/tenants', async (req) => {
    const user = requireUser(req);
    const body = parse(
      zTenantPatch.pick({ name: true, slug: true, timezone: true, address: true, phone: true, locale: true })
        .partial({ address: true, phone: true, locale: true }),
      req.body,
    );
    if (!(await validTimezone(body.timezone))) throw badRequest('invalid_timezone');
    try {
      return await tx(async (db) => {
        const tenant = await one<{ id: string }>(
          db,
          `insert into tenants (slug, name, timezone, address, phone, locale)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [body.slug, body.name, body.timezone, body.address ?? null, body.phone ?? null, body.locale ?? 'en'],
        );
        const tenantId = tenant!.id;
        await db.query('insert into subscriptions (tenant_id) values ($1)', [tenantId]);
        const staff = await one<{ id: string }>(
          db,
          'insert into staff (tenant_id, name, email) values ($1, $2, $3) returning id',
          [tenantId, user.name || body.name, user.email],
        );
        await db.query(
          `insert into memberships (tenant_id, user_id, role, staff_id) values ($1, $2, 'owner', $3)`,
          [tenantId, user.id, staff!.id],
        );
        await replaceHours(db, tenantId, staff!.id, DEFAULT_HOURS);
        return { id: tenantId, slug: body.slug };
      });
    } catch (err) {
      if (isUniqueError(err, 'tenants_slug_key')) throw conflict('slug_taken');
      throw err;
    }
  });

  app.get('/api/slug-available/:slug', async (req) => {
    const slug = (req.params as { slug: string }).slug.toLowerCase();
    if (!zSlug.safeParse(slug).success) return { available: false };
    return { available: !(await one(pool, 'select 1 from tenants where slug = $1', [slug])) };
  });

  app.get('/api/timezones', async () => {
    const rows = await manyCamel(pool, `select name from pg_timezone_names where name ~ '^[A-Z][a-z]+/' order by name`);
    return rows.map((r) => r.name);
  });

  app.get('/api/t/:tid', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    return withTenant(tid, async (db) => {
      const tenant = await oneCamel(db, 'select * from tenants where id = $1', [tid]);
      const plan = await tenantPlan(db, tid);
      const used = await monthlyOnlineBookings(db, tid);
      const sub = plan.subscription;
      return {
        tenant,
        membership: m,
        bookingUrl: `${config.appUrl}/${tenant.slug}`,
        plan: {
          plan: plan.plan,
          rawPlan: plan.rawPlan,
          limits: plan.limits,
          status: sub?.status ?? 'active',
          interval: sub?.billing_interval ?? null,
          currentPeriodEnd: sub?.current_period_end ?? null,
          foundingUntil: sub?.founding_until ?? null,
          hasBillingAccount: Boolean(sub?.stripe_customer_id),
        },
        usage: {
          bookingsThisMonth: used,
          bookingLimit: plan.limits.monthlyBookings,
          activeStaff: await activeStaffCount(db),
          staffLimit: plan.limits.maxStaff,
        },
      };
    });
  });

  app.patch('/api/t/:tid', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const body = parse(zTenantPatch.partial(), req.body);
    if (body.timezone && !(await validTimezone(body.timezone))) throw badRequest('invalid_timezone');
    return withTenant(tid, async (db) => {
      if (body.brandColor) {
        const { limits } = await tenantPlan(db, tid);
        if (!limits.branding) throw planLimit('branding_requires_pro');
      }
      const map: Record<string, string> = {
        name: 'name', slug: 'slug', timezone: 'timezone', address: 'address', phone: 'phone',
        logoData: 'logo_data', brandColor: 'brand_color', locale: 'locale', slotStepMin: 'slot_step_min',
        minNoticeMin: 'min_notice_min', maxDaysAhead: 'max_days_ahead', published: 'published',
        onboardingDone: 'onboarding_done',
      };
      const sets: string[] = [];
      const values: unknown[] = [tid];
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || !map[k]) continue;
        values.push(v);
        sets.push(`${map[k]} = $${values.length}`);
      }
      if (!sets.length) return { ok: true };
      try {
        await db.query('savepoint patch');
        await db.query(`update tenants set ${sets.join(', ')} where id = $1`, values);
      } catch (err) {
        if (isUniqueError(err, 'tenants_slug_key')) throw conflict('slug_taken');
        throw err;
      }
      return { ok: true };
    });
  });

  app.delete('/api/t/:tid', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, ['owner']);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.body ?? {});
    const tenant = await one<{ slug: string }>(pool, 'select slug from tenants where id = $1', [tid]);
    if (!tenant || confirm !== tenant.slug) throw badRequest('confirm_with_slug');
    await pool.query('delete from tenants where id = $1', [tid]);
    return { ok: true };
  });

  // ── Services ────────────────────────────────────────────────────────────────
  app.get('/api/t/:tid/services', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid);
    return withTenant(tid, (db) => manyCamel(db, 'select * from services order by sort, created_at'));
  });

  app.post('/api/t/:tid/services', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const s = parse(zService, req.body);
    return withTenant(tid, (db) =>
      oneCamel(
        db,
        `insert into services (tenant_id, name, description, duration_min, price_cents, currency, buffer_min, active, sort)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [tid, s.name, s.description ?? null, s.durationMin, s.priceCents, s.currency, s.bufferMin, s.active, s.sort],
      ),
    );
  });

  app.patch('/api/t/:tid/services/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const s = parse(zService.partial(), req.body);
    return withTenant(tid, async (db) => {
      const row = await oneCamel(
        db,
        `update services set
           name = coalesce($2, name), description = case when $3::boolean then $4 else description end,
           duration_min = coalesce($5, duration_min), price_cents = coalesce($6, price_cents),
           currency = coalesce($7, currency), buffer_min = coalesce($8, buffer_min),
           active = coalesce($9, active), sort = coalesce($10, sort)
         where id = $1 returning *`,
        [id, s.name ?? null, s.description !== undefined, s.description ?? null, s.durationMin ?? null,
         s.priceCents ?? null, s.currency ?? null, s.bufferMin ?? null, s.active ?? null, s.sort ?? null],
      );
      if (!row) throw notFound();
      return row;
    });
  });

  app.delete('/api/t/:tid/services/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await withTenant(tid, (db) => db.query('delete from services where id = $1', [id]));
    return { ok: true };
  });

  // ── Staff, hours, invitations ────────────────────────────────────────────────
  app.get('/api/t/:tid/staff', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid);
    return withTenant(tid, (db) =>
      manyCamel(
        db,
        `select s.*,
                coalesce((select json_agg(json_build_object('weekday', w.weekday,
                            'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI'))
                            order by w.weekday, w.start_time)
                          from working_hours w where w.staff_id = s.id), '[]') as hours,
                (select json_build_object('userId', m.user_id, 'role', m.role, 'email', u.email)
                   from memberships m join users u on u.id = m.user_id
                  where m.staff_id = s.id limit 1) as member,
                (select json_build_object('email', i.email, 'role', i.role, 'expiresAt', i.expires_at)
                   from invitations i
                  where i.staff_id = s.id and i.accepted_at is null and i.expires_at > now()
                  order by i.created_at desc limit 1) as pending_invite
           from staff s order by s.sort, s.created_at`,
      ),
    );
  });

  app.post('/api/t/:tid/staff', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const s = parse(zStaff, req.body);
    return withTenant(tid, async (db) => {
      if (s.active) await assertStaffSeat(db, tid);
      const row = await oneCamel(
        db,
        'insert into staff (tenant_id, name, email, active, sort) values ($1, $2, $3, $4, $5) returning *',
        [tid, s.name, s.email ?? null, s.active, s.sort],
      );
      await replaceHours(db, tid, row.id, DEFAULT_HOURS);
      return row;
    });
  });

  app.patch('/api/t/:tid/staff/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const s = parse(zStaff.partial(), req.body);
    return withTenant(tid, async (db) => {
      if (s.active) await assertStaffSeat(db, tid, id);
      const row = await oneCamel(
        db,
        `update staff set name = coalesce($2, name),
                          email = case when $3::boolean then $4 else email end,
                          active = coalesce($5, active), sort = coalesce($6, sort)
          where id = $1 returning *`,
        [id, s.name ?? null, s.email !== undefined, s.email ?? null, s.active ?? null, s.sort ?? null],
      );
      if (!row) throw notFound();
      return row;
    });
  });

  app.delete('/api/t/:tid/staff/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return withTenant(tid, async (db) => {
      const upcoming = await one(
        db,
        `select 1 from appointments where staff_id = $1 and status = 'confirmed' and starts_at > now() limit 1`,
        [id],
      );
      if (upcoming) throw conflict('staff_has_upcoming_appointments', 'Move or cancel their upcoming appointments first, or deactivate instead');
      const owner = await one(db, `select 1 from memberships where staff_id = $1 and role = 'owner'`, [id]);
      if (owner) throw conflict('cannot_delete_owner');
      await db.query('delete from memberships where staff_id = $1', [id]);
      await db.query('delete from staff where id = $1', [id]);
      return { ok: true };
    });
  });

  app.put('/api/t/:tid/staff/:id/hours', async (req) => {
    const tid = tenantIdParam(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const m = await requireMember(req, tid);
    assertStaffScope(m, id);
    const rows = parse(zHours, req.body);
    return withTenant(tid, async (db) => {
      if (!(await one(db, 'select 1 from staff where id = $1', [id]))) throw notFound();
      await replaceHours(db, tid, id, rows);
      return { ok: true };
    });
  });

  app.post('/api/t/:tid/staff/:id/invite', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ email: zEmail, role: z.enum(['staff', 'admin']).default('staff') }), req.body);
    return withTenant(tid, async (db) => {
      const staff = await one<{ id: string }>(db, 'select id from staff where id = $1', [id]);
      if (!staff) throw notFound();
      const tenant = await one<{ name: string; locale: string }>(db, 'select name, locale from tenants where id = $1', [tid]);
      const token = randomToken();
      await db.query(
        `insert into invitations (tenant_id, email, role, staff_id, token_hash, expires_at)
         values ($1, $2, $3, $4, $5, now() + interval '7 days')`,
        [tid, body.email, body.role, id, hashToken(token)],
      );
      await db.query('update staff set email = coalesce(email, $2) where id = $1', [id, body.email]);
      const s = t(asLocale(tenant!.locale));
      const msg = emailLayout({
        heading: s.inviteSubject(tenant!.name),
        intro: s.inviteIntro(tenant!.name),
        button: { label: s.inviteButton, url: `${config.appUrl}/invite/${token}` },
      });
      await queueRawEmail(db, tid, 'invite', body.email, { subject: s.inviteSubject(tenant!.name), ...msg });
      return { ok: true, ...(config.production ? {} : { inviteUrl: `${config.appUrl}/invite/${token}` }) };
    });
  });

  app.delete('/api/t/:tid/members/:userId', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { userId } = parse(z.object({ userId: zUuid }), req.params);
    await withTenant(tid, (db) =>
      db.query(`delete from memberships where user_id = $1 and role <> 'owner'`, [userId]),
    );
    return { ok: true };
  });

  // ── Time off & blocked time ─────────────────────────────────────────────────
  app.get('/api/t/:tid/time-off', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const q = parse(z.object({ from: zDate, to: zDate, staffId: zUuid.optional() }), req.query);
    const staffId = isManager(m) ? q.staffId ?? null : m.staffId;
    return withTenant(tid, (db) =>
      manyCamel(
        db,
        `select o.*, s.name as staff_name,
                to_char(o.starts_at at time zone t.timezone, 'YYYY-MM-DD"T"HH24:MI') as local_start,
                to_char(o.ends_at at time zone t.timezone, 'YYYY-MM-DD"T"HH24:MI') as local_end
           from time_off o join staff s on s.id = o.staff_id join tenants t on t.id = o.tenant_id
          where o.starts_at < tenant_local_to_utc($1, $3::date + 1, '00:00')
            and o.ends_at > tenant_local_to_utc($1, $2::date, '00:00')
            and ($4::uuid is null or o.staff_id = $4)
          order by o.starts_at`,
        [tid, q.from, q.to, staffId],
      ),
    );
  });

  app.post('/api/t/:tid/time-off', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const b = parse(
      z.object({
        staffId: zUuid,
        kind: z.enum(['day_off', 'block']),
        startDate: zDate,
        endDate: zDate,
        startTime: zTime.optional(),
        endTime: zTime.optional(),
        reason: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    assertStaffScope(m, b.staffId);
    return withTenant(tid, async (db) => {
      const range = await one<{ s: Date; e: Date }>(
        db,
        b.kind === 'day_off'
          ? `select tenant_local_to_utc($1, $2::date, '00:00') as s, tenant_local_to_utc($1, $3::date + 1, '00:00') as e`
          : `select tenant_local_to_utc($1, $2::date, $4::time) as s, tenant_local_to_utc($1, $3::date, $5::time) as e`,
        b.kind === 'day_off'
          ? [tid, b.startDate, b.endDate]
          : [tid, b.startDate, b.endDate, b.startTime ?? '00:00', b.endTime ?? '23:59'],
      );
      if (!range || range.s >= range.e) throw badRequest('invalid_range');
      return oneCamel(
        db,
        `insert into time_off (tenant_id, staff_id, starts_at, ends_at, kind, reason)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [tid, b.staffId, range.s, range.e, b.kind, b.reason ?? null],
      );
    });
  });

  app.delete('/api/t/:tid/time-off/:id', async (req) => {
    const tid = tenantIdParam(req);
    const m = await requireMember(req, tid);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await withTenant(tid, async (db) => {
      const row = await one<{ staff_id: string }>(db, 'select staff_id from time_off where id = $1', [id]);
      if (!row) throw notFound();
      assertStaffScope(m, row.staff_id);
      await db.query('delete from time_off where id = $1', [id]);
    });
    return { ok: true };
  });

  // ── Clients ─────────────────────────────────────────────────────────────────
  app.get('/api/t/:tid/clients', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid);
    const { q } = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    return withTenant(tid, (db) =>
      manyCamel(
        db,
        `select c.*,
                count(a.id) filter (where a.status in ('confirmed', 'completed')) as visits,
                count(a.id) filter (where a.status = 'no_show') as no_shows,
                max(a.starts_at) filter (where a.status <> 'cancelled' and a.starts_at <= now()) as last_visit,
                min(a.starts_at) filter (where a.status = 'confirmed' and a.starts_at > now()) as next_visit
           from clients c left join appointments a on a.client_id = c.id
          where $1::text is null or c.name ilike '%' || $1 || '%' or c.email ilike '%' || $1 || '%' or c.phone like '%' || $1 || '%'
          group by c.id
          order by c.name
          limit 500`,
        [q?.trim() || null],
      ),
    );
  });

  app.patch('/api/t/:tid/clients/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        email: zEmail.nullable().optional(),
        phone: zPhone.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
      req.body,
    );
    return withTenant(tid, async (db) => {
      try {
        await db.query('savepoint c');
        return await oneCamel(
          db,
          `update clients set name = coalesce($2, name),
                  email = case when $3::boolean then $4 else email end,
                  phone = case when $5::boolean then $6 else phone end,
                  notes = case when $7::boolean then $8 else notes end
            where id = $1 returning *`,
          [id, b.name ?? null, b.email !== undefined, b.email ?? null, b.phone !== undefined, b.phone ?? null,
           b.notes !== undefined, b.notes ?? null],
        );
      } catch (err) {
        if (isUniqueError(err)) throw conflict('client_email_exists');
        throw err;
      }
    });
  });

  /** GDPR erasure of one client and their appointment history. */
  app.delete('/api/t/:tid/clients/:id', async (req) => {
    const tid = tenantIdParam(req);
    await requireMember(req, tid, MANAGERS);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await withTenant(tid, (db) => db.query('delete from clients where id = $1', [id]));
    return { ok: true };
  });
}
