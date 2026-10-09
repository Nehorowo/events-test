# Slotwise

A multi-tenant appointment booking app for small service businesses (1–5 staff), built from the MVP spec of 5 Oct 2026. Each business gets a public booking link and QR code, a staff calendar, and automatic email reminders. Clients book in three screens with no account.

```
                ┌──────────────────────── app container ─────────────────────────┐
 browser ──────►│ Fastify API  ·  serves the PWA  ·  per-tenant link previews      │
 (PWA)          └──────────────┬─────────────────────────────────────────────────┘
                               │ SQL (RLS per tenant)
                ┌──────────────▼──────────────┐      ┌──────── worker ────────┐
                │ Postgres 16                 │◄────►│ reminders (24 h)       │──► email (Resend / SMTP)
                │ exclusion constraint,       │      │ outbox → email + push  │──► web push (VAPID)
                │ slot function, outbox       │      └────────────────────────┘
                └─────────────────────────────┘
```

## Quick start (Docker)

```bash
cd slotwise
cp .env.example .env
echo "APP_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

- App: http://localhost:8080
- Local inbox (sign-in links, confirmations, reminders): http://localhost:8025

Sign up with any email address and open the sign-in link from the local inbox. The 4-step setup creates the business, adds services and working hours, then publishes the booking page. Open the booking link in another browser (or a private window) to book as a client.

| Service | What it does |
| --- | --- |
| `app` | API plus the built PWA on port 3000 (published as 8080). Applies database migrations on start. |
| `worker` | Queues the 24-hour reminders and sends everything in the outbox (email + push), with retries. |
| `db` | Postgres 16 (data in the `pgdata` volume). |
| `mailpit` | Catches all mail locally. It is no longer used once `RESEND_API_KEY` is set. |
| `backup` | Runs a nightly `pg_dump` into `./backups` and keeps 14 days. |
| `uptime-kuma` | Optional monitoring: `docker compose --profile ops up -d`. |

Operator commands:

```bash
docker compose exec app node api/dist/admin.js tenants            # list businesses
docker compose exec app node api/dist/admin.js founding <slug>    # founding offer: Pro free for 3 months, then €5/month
docker compose exec app node api/dist/admin.js plan <slug> pro
```

Restore a backup: `gunzip -c backups/slotwise-YYYYMMDD.sql.gz | docker compose exec -T db psql -U slotwise -d slotwise`

## Configuration

Every setting is in `.env.example`. Only `APP_SECRET` is required. The other integrations turn on when you add their keys:

- **Email:** set `RESEND_API_KEY` and a verified `EMAIL_FROM`. Set up SPF, DKIM and DMARC on day 1.
- **Google sign-in:** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, with redirect URI `${APP_URL}/api/auth/google/callback`.
- **Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY` (€9), `STRIPE_PRICE_YEARLY` (€90) and `STRIPE_WEBHOOK_SECRET`. The webhook goes to `${APP_URL}/api/stripe/webhook`. Without these keys, billing runs in **test mode** and "Upgrade" switches the plan instantly.
- **Web push:** VAPID keys are generated on first start and stored in the database. You can also pin them with `VAPID_*`.
- **Analytics:** set `UMAMI_SCRIPT_URL` + `UMAMI_WEBSITE_ID` to add the script to every page.

In production, put the app behind TLS (Coolify, Caddy or Traefik) and set `APP_URL` to the public `https://` origin. Cookies become `Secure`, and cross-origin writes are rejected.

## Local development

```bash
cd slotwise && npm install
# Postgres on :5432 with user/password slotwise, database slotwise
npm run dev            # API :3000, worker, Vite :5173 (proxies /api)
npm test               # API integration tests (needs Postgres; see below)
npm run typecheck
```

The tests need a database whose name ends in `_test` (they reset its schema): `createdb slotwise_test`, or set `TEST_DATABASE_URL`.

## How the spec maps to the code

| Spec requirement | Where |
| --- | --- |
| Shared schema, `tenant_id` everywhere, RLS | `db/migrations/001_schema.sql`, `002_rls.sql`. Member requests run as role `slotwise_tenant` with `app.tenant_id` set for the transaction (`withTenant` in `api/src/db.ts`). |
| No double booking enforced in the database | Exclusion constraint `appointments_no_overlap` on `(staff_id, tstzrange(starts_at, blocked_until))`. Service buffers are included. |
| Slot calculation in Postgres, DST-safe | `available_slots()` in `003_slots.sql`: working hours − time off − appointments − buffers. Slots are generated in local wall-clock time, and times that don't exist (spring-forward gap) are dropped. |
| Times stored as UTC, shown in the tenant's timezone | `timestamptz` everywhere. The API returns `localStart` / `localEnd` strings already in the tenant's timezone. |
| Cancel/reschedule via signed, expiring links | `api/src/lib/tokens.ts` (HMAC). Client pages: `web/src/pages/Manage.tsx`. |
| Emails queued in the DB, sent by a job | `notification_log` outbox. `api/src/outbox.ts` + `worker.ts` (LISTEN/NOTIFY plus a 10 s poll). |
| Confirmation + .ics, 24 h reminder, owner email + push | `api/src/outbox.ts`, `lib/ics.ts`, `lib/push.ts`, `web/src/sw.ts` |
| Freemium limits (1 staff, 40 online bookings/month, badge, branding) | `shared/plans.ts`, `api/src/lib/plans.ts`. Usage meter with a warning at 80%. |
| Stripe Checkout, Customer Portal, idempotent webhooks | `api/src/routes/billing.ts` |
| Per-tenant link previews for a static SPA | `api/src/spa.ts` injects `og:` tags for `/{slug}` |
| PWA, EN + Greek | `vite-plugin-pwa` (injectManifest), `web/src/locales/{en,el}.ts` |
| CSV export, account/business/client deletion (GDPR) | `/api/t/:id/export/*.csv`, `DELETE /api/me`, `DELETE /api/t/:id`, `DELETE /api/t/:id/clients/:cid` |

### Deliberate deviations from the spec

- **Stack:** a Fastify API and worker on plain Postgres instead of self-hosted Supabase. The full Supabase stack (Kong, GoTrue, PostgREST, Realtime, Storage, Edge Runtime) is about ten containers to run on a 4 GB VPS. The parts the spec depends on are all kept in Postgres: RLS, the exclusion constraint, the slot function, and the queued email job. Magic-link and Google sign-in are implemented directly.
- **Hosting:** the API serves the PWA and the link-preview HTML itself, so no Cloudflare Pages Function is needed. You can still put a CDN in front of it.
- **Email templates** are plain inline-styled HTML rather than React Email.
- **Plan limits:** the 40/month limit counts online bookings only. Bookings that staff add by hand are never blocked. All plans can upload a logo; custom colours and removing the badge are Pro-only. On Free, only the first active staff member can be booked.
- **Reminders** go to appointments booked at least 24 h ahead. Later bookings already have a fresh confirmation.

## Tests

`api/test/` runs against a real Postgres:

- Slots stay inside working hours and respect days off, blocked time and buffers.
- No slots are offered in the past.
- DST change days work in both directions (Europe/Nicosia).
- 12 simultaneous bookings for the same slot: exactly one succeeds.
- The database constraint holds even when the app's own checks are bypassed.
- Choosing "any staff" assigns the next free person.
- Free-plan limits are enforced.
- RLS isolation between tenants.
- A full HTTP flow: sign up → create a business → book publicly → outbox → client reschedules and cancels → staff can only see their own calendar → CSV export → reminders.
