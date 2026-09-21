-- 0015 Calendar: the visits the AI books, and everything the team writes in.
--
-- A clinic's day is people and rooms: Dr Rickson at Kondapur, the laser room,
-- the front desk. The calendar shows every visit against whoever it is with,
-- alongside leave, camps and anything else the team needs on the same page.
-- Calls that end in a booking land here automatically.

create type resource_kind as enum ('doctor', 'staff', 'room', 'equipment');

create table resources (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  name text not null,
  kind resource_kind not null default 'doctor',
  title text,                                   -- "Dermatologist", "Laser room 2"
  colour text not null default '#C96A3C',
  working_hours jsonb not null default '{}'::jsonb,  -- { days: [1..6], start: "10:00", end: "19:00" }
  active boolean not null default true,
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id)
);
create index resources_tenant on resources(tenant_id, active);

alter table resources enable row level security;
alter table resources force row level security;
create policy resources_rw on resources using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on resources to jenai_app, jenai_platform;

create type appointment_kind as enum ('visit', 'follow_up', 'procedure', 'call_back', 'block', 'other');
create type appointment_status as enum ('booked', 'confirmed', 'arrived', 'completed', 'cancelled', 'no_show');

create table appointments (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  resource_id uuid,                             -- the doctor, room or person it is with
  contact_id uuid,
  call_id uuid,                                 -- the call that booked it
  client_program_id uuid,
  title text not null,
  kind appointment_kind not null default 'visit',
  status appointment_status not null default 'booked',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  person_name text,
  phone_e164 text,
  notes text,
  source text not null default 'manual' check (source in ('call', 'manual', 'api', 'crm', 'import')),
  external_id text,                             -- their system's id, when it came from there
  created_by text references "user"(id),
  updated_by text references "user"(id),
  cancelled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  check (ends_at > starts_at)
);
create index appointments_when on appointments(tenant_id, starts_at);
create index appointments_resource on appointments(tenant_id, resource_id, starts_at);
create index appointments_contact on appointments(tenant_id, contact_id, starts_at desc);
-- One appointment per call, so a re-analysed call never doubles the diary.
create unique index appointments_call on appointments(tenant_id, call_id) where call_id is not null;

alter table appointments enable row level security;
alter table appointments force row level security;
create policy appointments_rw on appointments using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on appointments to jenai_app, jenai_platform;

-- A read-only calendar feed the client can subscribe to from Google or Outlook.
alter table organizations add column calendar_token text;
