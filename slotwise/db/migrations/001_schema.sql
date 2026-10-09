-- Slotwise core schema.
-- Shared database, shared schema: every tenant-owned row carries tenant_id, and
-- cross-table references go through composite (tenant_id, id) foreign keys so a
-- row can never point at another tenant's data.

create extension if not exists btree_gist;
create extension if not exists citext;

-- ── Identity ────────────────────────────────────────────────────────────────

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null unique,
  name        text,
  google_sub  text unique,
  locale      text not null default 'en',
  created_at  timestamptz not null default now()
);

create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table login_tokens (
  token_hash  text primary key,
  email       citext not null,
  redirect    text,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- ── Tenants ─────────────────────────────────────────────────────────────────

create table tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            citext not null unique
                  check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name            text not null check (length(name) between 1 and 80),
  timezone        text not null,
  address         text,
  phone           text,
  logo_data       text check (logo_data is null or length(logo_data) <= 300000),
  brand_color     text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  locale          text not null default 'en',
  slot_step_min   int  not null default 15 check (slot_step_min in (5, 10, 15, 20, 30, 60)),
  min_notice_min  int  not null default 60 check (min_notice_min between 0 and 10080),
  max_days_ahead  int  not null default 60 check (max_days_ahead between 1 and 365),
  published       boolean not null default false,
  onboarding_done boolean not null default false,
  created_at      timestamptz not null default now()
);

create table staff (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  name        text not null check (length(name) between 1 and 80),
  email       citext,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);

create table memberships (
  tenant_id   uuid not null references tenants on delete cascade,
  user_id     uuid not null references users on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'staff')),
  staff_id    uuid,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id) on delete set null (staff_id)
);
create index memberships_user_idx on memberships (user_id);

create table invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  email       citext not null,
  role        text not null check (role in ('admin', 'staff')),
  staff_id    uuid,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id) on delete cascade
);

create table services (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  name         text not null check (length(name) between 1 and 80),
  description  text,
  duration_min int  not null check (duration_min between 5 and 720),
  price_cents  int  not null default 0 check (price_cents >= 0),
  currency     text not null default 'EUR',
  buffer_min   int  not null default 0 check (buffer_min between 0 and 240),
  active       boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id)
);

-- weekday follows extract(dow): 0 = Sunday … 6 = Saturday. Several ranges per
-- day are allowed (e.g. a lunch break splits the day in two).
create table working_hours (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  staff_id    uuid not null,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  check (start_time < end_time),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id) on delete cascade
);
create index working_hours_staff_idx on working_hours (staff_id, weekday);

-- Days off and manually blocked time share one table.
create table time_off (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  staff_id    uuid not null,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  kind        text not null default 'block' check (kind in ('day_off', 'block')),
  reason      text,
  created_at  timestamptz not null default now(),
  check (starts_at < ends_at),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id) on delete cascade
);
create index time_off_range_idx on time_off using gist (staff_id, tstzrange(starts_at, ends_at));

create table clients (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  name        text not null,
  email       citext,
  phone       text,
  notes       text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index clients_tenant_email_idx on clients (tenant_id, email) where email is not null;

-- blocked_until = ends_at + the service buffer. The exclusion constraint is the
-- real double-booking guarantee: two live appointments for the same staff
-- member can never overlap, whatever the application code does.
create table appointments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  staff_id         uuid not null,
  service_id       uuid,
  client_id        uuid not null,
  service_name     text not null,
  price_cents      int not null default 0,
  currency         text not null default 'EUR',
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  blocked_until    timestamptz not null,
  status           text not null default 'confirmed'
                   check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  source           text not null check (source in ('online', 'manual')),
  notes            text,
  reminder_sent_at timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     text check (cancelled_by in ('client', 'business')),
  created_at       timestamptz not null default now(),
  check (starts_at < ends_at and ends_at <= blocked_until),
  foreign key (tenant_id, staff_id)   references staff (tenant_id, id)    on delete cascade,
  foreign key (tenant_id, service_id) references services (tenant_id, id) on delete set null (service_id),
  foreign key (tenant_id, client_id)  references clients (tenant_id, id)  on delete cascade,
  constraint appointments_no_overlap exclude using gist (
    staff_id with =,
    tstzrange(starts_at, blocked_until) with &&
  ) where (status <> 'cancelled')
);
create index appointments_tenant_start_idx on appointments (tenant_id, starts_at);
create index appointments_reminder_idx on appointments (starts_at)
  where status = 'confirmed' and reminder_sent_at is null;

-- ── Billing ─────────────────────────────────────────────────────────────────

create table subscriptions (
  tenant_id              uuid primary key references tenants on delete cascade,
  plan                   text not null default 'free' check (plan in ('free', 'pro', 'founding')),
  status                 text not null default 'active',
  billing_interval       text check (billing_interval in ('month', 'year')),
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  current_period_end     timestamptz,
  founding_until         timestamptz,
  updated_at             timestamptz not null default now()
);

create table stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

-- ── Notifications ───────────────────────────────────────────────────────────

-- Outbox: everything the worker sends (email, web push) is queued here first,
-- so a request never waits on a mail server and failures are retried.
create table notification_log (
  id             bigserial primary key,
  tenant_id      uuid references tenants on delete cascade,
  appointment_id uuid references appointments on delete set null,
  channel        text not null check (channel in ('email', 'push')),
  kind           text not null,
  recipient      text not null,
  payload        jsonb not null,
  status         text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts       int not null default 0,
  last_error     text,
  send_after     timestamptz not null default now(),
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index notification_pending_idx on notification_log (send_after) where status = 'pending';

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);

create table app_settings (
  key   text primary key,
  value text not null
);
