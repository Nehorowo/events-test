-- Row-level security.
-- The API connects as the database owner for system work (auth, the public
-- booking engine, the worker). Every request made on behalf of a signed-in
-- member runs inside a transaction that does
--   SET LOCAL ROLE slotwise_tenant; SELECT set_config('app.tenant_id', $1, true);
-- so a query that forgets its tenant filter still cannot see another tenant.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'slotwise_tenant') then
    create role slotwise_tenant nologin;
  end if;
end $$;

grant slotwise_tenant to current_user;
grant usage on schema public to slotwise_tenant;

create or replace function app_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

grant select (id, email, name) on users to slotwise_tenant;

grant select, update on tenants to slotwise_tenant;
alter table tenants enable row level security;
create policy tenant_isolation on tenants for all to slotwise_tenant
  using (id = app_current_tenant()) with check (id = app_current_tenant());

do $$
declare
  t text;
begin
  foreach t in array array[
    'memberships', 'staff', 'invitations', 'services', 'working_hours',
    'time_off', 'clients', 'appointments', 'subscriptions', 'notification_log'
  ] loop
    execute format('grant select, insert, update, delete on %I to slotwise_tenant', t);
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all to slotwise_tenant
         using (tenant_id = app_current_tenant()) with check (tenant_id = app_current_tenant())', t);
  end loop;
end $$;

grant usage on sequence notification_log_id_seq to slotwise_tenant;
