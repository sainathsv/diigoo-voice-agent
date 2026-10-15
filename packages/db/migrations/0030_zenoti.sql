-- 0030 Zenoti: who took which service, who is booked, and what is left on a package (Zennara, 2026-10-04).
--
-- Many clinics, salons and spas run their front desk and billing on Zenoti.
-- JENAI reads it, never writes to it, so the call plan knows who actually
-- took which service, who is booked, who missed a booking and how many
-- sessions are left on a package. Only what planning needs is kept: name,
-- number, service, dates, doctor, package counts and the two SMS consents.
-- Their system stays the record of truth, so all of this can be read again,
-- and disconnecting it takes its copy with it.
--
-- The tables are named for any front-desk system, not for Zenoti: the next
-- one a client brings fills the same rows.

-- Postgres 12 and later add an enum value inside a transaction, which is how
-- the migrate script runs each file. It cannot be used until that transaction
-- commits, so nothing below uses it.
alter type integration_kind add value if not exists 'zenoti';

-- One row per person in the client's system, as last read: how to reach them
-- and whether they agreed to messages. Their visits and bookings name them
-- by external_id, so a number read once serves all of them.
create table external_people (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  integration_id uuid not null,
  external_id text not null,                     -- their person id (Zenoti's guest id)
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),  -- empty when they hold no number JENAI can read
  name text,
  marketing_sms_consent boolean,                 -- empty when their system does not say
  transactional_sms_consent boolean,
  fetched_at timestamptz not null default now(), -- when it was last read from their system
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, integration_id, external_id),
  foreign key (tenant_id, integration_id) references integrations(tenant_id, id) on delete cascade
);
create index external_people_phone on external_people(tenant_id, phone_e164);

-- Bookings in the client's front desk: who is coming, who came and who did
-- not. Separate from appointments, which are the visits JENAI itself books.
-- Their status codes are translated in code; one their documentation does not
-- explain is 'unknown', which counts as neither booked nor done.
create table clinic_appointments (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  integration_id uuid not null,
  external_id text not null,                     -- their appointment id
  guest_ref text not null,                       -- their person id, as in external_people.external_id
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  service text not null,                         -- as their system names it
  category text,
  starts_at timestamptz not null,
  status text not null check (status in ('booked', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'unknown')),
  doctor text,                                   -- the doctor or therapist, by name
  centre_ref text,                               -- their centre id
  branch_id uuid,                                -- the branch here, when it could be matched
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, integration_id, external_id),
  foreign key (tenant_id, integration_id) references integrations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id)
);
create index clinic_appointments_time on clinic_appointments(tenant_id, starts_at);
create index clinic_appointments_phone on clinic_appointments(tenant_id, phone_e164);

-- A visit can now be read from a connected system as well as uploaded. Their
-- sales report names the person but carries no number, which is read from
-- their person record separately; until it arrives the visit is kept without
-- one, counted as waiting for a phone number, and not planned. An uploaded
-- visit still always has its number. Once a number is known, visits_once
-- still holds: one visit per person, service and day, however it arrived.
alter table visits add column integration_id uuid;
alter table visits add column external_id text;    -- their line on the invoice, so reading it again updates it
alter table visits add column guest_ref text;      -- their person id, to find the number by
alter table visits alter column phone_e164 drop not null;
alter table visits add constraint visits_phone_or_guest
  check (phone_e164 is not null or (integration_id is not null and external_id is not null and guest_ref is not null));
alter table visits add constraint visits_integration
  foreign key (tenant_id, integration_id) references integrations(tenant_id, id) on delete cascade;
create unique index visits_external on visits(tenant_id, integration_id, external_id) where external_id is not null;
create index visits_guest on visits(tenant_id, guest_ref);

-- Sessions bought, used and left on each package, per service in it, as last
-- read. Counts are kept as their system gives them, unchecked, so one odd
-- package does not stop a read.
create table package_balances (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  integration_id uuid not null,
  guest_ref text not null,                       -- their person id
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  package_ref text,                              -- their package id
  package_name text not null,
  service text not null,
  total int,
  used int,
  balance int,
  status text not null check (status in ('active', 'frozen', 'expired', 'cancelled', 'not_started', 'unknown')),
  expires_on date,
  fetched_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, integration_id, guest_ref, package_name, service),
  foreign key (tenant_id, integration_id) references integrations(tenant_id, id) on delete cascade
);
create index package_balances_phone on package_balances(tenant_id, phone_e164);

do $$
declare t text;
begin
  foreach t in array array['external_people', 'clinic_appointments', 'package_balances'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
    execute format('grant select, insert, update, delete on %I to jenai_app, jenai_platform', t);
  end loop;
end $$;
