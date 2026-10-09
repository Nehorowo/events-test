-- Slot engine: working hours − time off − existing appointments − buffers.
-- Lives in Postgres so the web app and any future native client share one
-- source of truth. Security definer so public callers see availability only,
-- never client data.
--
-- DST safety: candidates are generated as local wall-clock timestamps in the
-- tenant's timezone and converted to UTC per slot. A local time that does not
-- exist (the spring-forward gap) does not survive the round trip and is dropped.

create or replace function available_slots(
  p_tenant       uuid,
  p_service      uuid,
  p_staff        uuid,      -- null = any staff member
  p_from         date,
  p_to           date,
  p_ignore_appt  uuid default null,  -- the appointment being rescheduled
  p_staff_ids    uuid[] default null -- optional allow-list (plan limits)
)
returns table (staff_id uuid, starts_at timestamptz, local_date date, local_time text)
language sql stable security definer set search_path = public, pg_temp as $$
  with t as (
    select timezone, slot_step_min, min_notice_min, max_days_ahead
    from tenants where id = p_tenant
  ),
  svc as (
    select duration_min, buffer_min
    from services where id = p_service and tenant_id = p_tenant and active
  ),
  st as (
    select s.id from staff s
    where s.tenant_id = p_tenant and s.active
      and (p_staff is null or s.id = p_staff)
      and (p_staff_ids is null or s.id = any (p_staff_ids))
  ),
  days as (
    select d::date as d
    from t, generate_series(
      greatest(p_from, (now() at time zone t.timezone)::date),
      least(p_to, (now() at time zone t.timezone)::date + t.max_days_ahead),
      interval '1 day') d
  ),
  cand as (
    select st.id as staff_id, days.d, ls as local_ts,
           ls at time zone t.timezone as start_utc,
           make_interval(mins => svc.duration_min) as dur,
           make_interval(mins => svc.duration_min + svc.buffer_min) as dur_buf,
           t.timezone as tz, t.min_notice_min
    from st
    cross join days
    cross join t
    cross join svc
    join working_hours wh
      on wh.staff_id = st.id and wh.weekday = extract(dow from days.d)
    cross join lateral generate_series(
      days.d + wh.start_time,
      days.d + wh.end_time - make_interval(mins => svc.duration_min),
      make_interval(mins => t.slot_step_min)) ls
  )
  select distinct c.staff_id, c.start_utc, c.d, to_char(c.local_ts, 'HH24:MI')
  from cand c
  where (c.start_utc at time zone c.tz) = c.local_ts
    and c.start_utc >= now() + make_interval(mins => c.min_notice_min)
    and not exists (
      select 1 from time_off o
      where o.staff_id = c.staff_id
        and tstzrange(o.starts_at, o.ends_at) && tstzrange(c.start_utc, c.start_utc + c.dur))
    and not exists (
      select 1 from appointments a
      where a.staff_id = c.staff_id
        and a.status <> 'cancelled'
        and a.id is distinct from p_ignore_appt
        and tstzrange(a.starts_at, a.blocked_until) && tstzrange(c.start_utc, c.start_utc + c.dur_buf))
  order by 2, 1
$$;

-- Local wall-clock → UTC for a tenant, used when staff type a date and time.
create or replace function tenant_local_to_utc(p_tenant uuid, p_date date, p_time time)
returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select (p_date + p_time) at time zone timezone from tenants where id = p_tenant
$$;

grant execute on function available_slots(uuid, uuid, uuid, date, date, uuid, uuid[]) to slotwise_tenant;
grant execute on function tenant_local_to_utc(uuid, date, time) to slotwise_tenant;
