-- 0025 The call plan: who JENAI would call, when and why (Zennara, 2026-10-04).
--
-- A clinic's next calls are already written down, just not in one place: the
-- enquiries and callbacks sit in their CRM, the services people actually took
-- sit in the front desk or billing software. JENAI reads both and works out,
-- for every person, which call it would make (a follow-up, a reminder, a
-- check-in after a treatment, the next session) and when, or why that person
-- is kept out. This migration only stores what that needs. Nothing here dials,
-- and nothing here is ever written back to the client's CRM.
--
-- Free text from the CRM (Description, notes) is never stored: it often holds
-- health detail. Only values derived from it are kept, such as a callback date.

-- One row per record in the client's CRM, as last read. Their CRM stays the
-- record of truth; this is a read-only mirror of the few fields planning uses.
create table crm_records (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  integration_id uuid not null,
  module text not null,                          -- their module: Leads, Contacts
  external_id text not null,                     -- their record id (Zoho's is a 19-digit number, kept as text)
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),  -- empty when their number cannot be read
  name text,
  status text,                                   -- their lead status, as they word it
  source text,                                   -- their lead source
  centre text,                                   -- the branch they named, as they word it
  created_ext timestamptz,                       -- when it was created in their system
  modified_ext timestamptz,                      -- when it last changed there
  appointment_at timestamptz,
  follow_up_at timestamptz,                      -- their follow-up field, or a callback date read from their notes
  treatment text,                                -- treatment, sub category and category, joined short
  consultant text,
  deleted_at timestamptz,                        -- deleted or merged away in their system
  synced_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, integration_id, module, external_id),
  -- Disconnecting their CRM takes its copy with it.
  foreign key (tenant_id, integration_id) references integrations(tenant_id, id) on delete cascade
);
create index crm_records_phone on crm_records(tenant_id, phone_e164);

-- Services a patient actually took, uploaded from the clinic's own software.
-- One row per person, service and day, so the same file uploaded twice, or
-- an overlapping one, updates rather than doubles.
create table visits (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  contact_id uuid,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  service text not null,                         -- as their software names it: "Hydrafacial", "PRP - Hair"
  visit_date date not null,
  doctor text,
  branch text,                                   -- the branch as their software names it
  branch_id uuid,                                -- the branch here, when it could be matched
  sessions_done int check (sessions_done >= 0),
  sessions_total int check (sessions_total > 0),
  source text not null default 'upload',         -- upload | api | manual
  batch text,                                    -- which upload it came in, so one can be told apart or undone
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, contact_id) references contacts(tenant_id, id) on delete set null (contact_id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id)
);
create unique index visits_once on visits(tenant_id, phone_e164, lower(service), visit_date);

-- When each treatment's calls fall due, per client. A keyword is matched,
-- ignoring case, against the service name. A client with no rows gets the
-- defaults for their industry, which live in code.
create table treatment_rules (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  match text not null,                           -- "hydrafacial", "laser hair", "prp"
  label text not null,                           -- what the clinic sees
  feedback_after_days int check (feedback_after_days >= 0),
  result_check_after_days int check (result_check_after_days >= 0),
  session_interval_days int check (session_interval_days > 0),
  course_sessions int check (course_sessions > 0),
  maintenance_after_days int check (maintenance_after_days > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index treatment_rules_match on treatment_rules(tenant_id, lower(match));

-- A client's own choices for the plan (which calls, quiet periods, synonyms
-- for their CRM's wording). Absent keys take the defaults in code.
create table call_plan_settings (
  tenant_id uuid not null references organizations(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id)
);

-- The plan itself: one row per person, per thing that prompts a call, per
-- kind of call. Worked out again from the sources whenever they change, so it
-- is safe to throw away; nothing here has been dialled.
create table planned_calls (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  contact_id uuid,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),  -- empty for someone kept out for having no usable number
  name text,
  journey text not null,                         -- enquiry_follow_up, appointment_reminder, visit_feedback ...
  program_key text not null,                     -- the call program that would make the call
  verdict text not null check (verdict in ('call_now', 'scheduled', 'waiting', 'kept_out')),
  reason text not null,                          -- plain English, for the clinic
  call_at timestamptz,
  priority int not null default 0,
  origin_type text not null check (origin_type in ('crm_record', 'visit')),
  origin_id uuid not null,
  origin_label text not null,                    -- where it came from, for the clinic: "Zoho Lead", "Visit list"
  context jsonb not null default '{}'::jsonb,    -- the variables the call needs: caller_name, treatment, visit_date ...
  computed_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, origin_type, origin_id, journey),
  foreign key (tenant_id, contact_id) references contacts(tenant_id, id) on delete set null (contact_id)
);
create index planned_calls_due on planned_calls(tenant_id, verdict, call_at);

do $$
declare t text;
begin
  foreach t in array array['crm_records', 'visits', 'treatment_rules', 'call_plan_settings', 'planned_calls'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
    execute format('grant select, insert, update, delete on %I to jenai_app, jenai_platform', t);
  end loop;
end $$;

-- Reading from a client's CRM on a timer. The worker takes a connection whose
-- next pull is due, holds a short lease on it so a second worker leaves it
-- alone, and keeps where it got to (per module) in pull_cursor, so the next
-- pull asks only for what changed since.
alter table integrations add column if not exists next_pull_at timestamptz;
alter table integrations add column if not exists pull_lease_until timestamptz;
alter table integrations add column if not exists pull_cursor jsonb not null default '{}'::jsonb;
alter table integrations add column if not exists last_pull_at timestamptz;
alter table integrations add column if not exists last_pull_error text;
create index if not exists integrations_pull_due on integrations(next_pull_at) where next_pull_at is not null;
