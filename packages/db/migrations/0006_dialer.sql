-- 0006 Dialer: consent ledger, suppression lists, campaigns and call targets.
-- Every outbound attempt passes the compliance gate in @jenai/engine (dialer/policy.ts).

create type consent_purpose as enum ('service', 'transactional', 'promotional');
create type consent_status as enum ('granted', 'revoked');

create table consents (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  phone_e164 text not null,
  contact_id uuid,
  purpose consent_purpose not null,
  channel text not null default 'voice' check (channel in ('voice','whatsapp','sms','any')),
  status consent_status not null default 'granted',
  source text not null,                         -- inbound_call, web_form, walk_in, import_attested, verbal_on_call
  evidence text,                                -- call id, form id, attestation note
  captured_at timestamptz not null default now(),
  expires_at timestamptz,                       -- enquiry-based consent lapses (TRAI: 7 days)
  revoked_at timestamptz,
  created_by text references "user"(id),
  primary key (tenant_id, id),
  unique (id)
);
create index consents_lookup on consents(tenant_id, phone_e164, purpose);

-- Do-not-call entries. tenant_id NULL = platform-wide (e.g. NCPR/DND scrub imports).
create type suppression_reason as enum ('opt_out', 'dnd_registry', 'complaint', 'legal', 'wrong_number');

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references organizations(id) on delete cascade,
  phone_e164 text not null,
  reason suppression_reason not null,
  scope consent_purpose,                        -- NULL = all calls; dnd_registry applies to promotional only
  source text,
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index suppressions_phone on suppressions(phone_e164);
create unique index suppressions_unique on suppressions(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), phone_e164, reason);

create type campaign_status as enum ('draft', 'pending_approval', 'approved', 'running', 'paused', 'completed', 'cancelled');

create table campaigns (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  agent_id uuid not null,
  caller_number_id uuid not null,
  name text not null,
  purpose consent_purpose not null,
  status campaign_status not null default 'draft',
  call_purpose_text text,                       -- spoken as {{call_purpose}} in the opening line
  timezone text not null default 'Asia/Kolkata',
  windows jsonb not null default '{"days":[1,2,3,4,5,6],"start":"10:00","end":"19:00"}'::jsonb,
  max_concurrency int not null default 2 check (max_concurrency between 1 and 200),
  max_attempts int not null default 3 check (max_attempts between 1 and 10),
  daily_cap_per_contact int not null default 2 check (daily_cap_per_contact between 1 and 5),
  consent_attested boolean not null default false,
  created_by text references "user"(id),
  approved_by text references "user"(id),
  approved_at timestamptz,
  launched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id) on delete restrict,
  foreign key (tenant_id, caller_number_id) references phone_numbers(tenant_id, id) on delete restrict,
  check (approved_by is null or approved_by <> created_by)   -- maker-checker
);

create type target_state as enum ('queued', 'scheduled', 'dialing', 'completed', 'skipped', 'failed', 'cancelled');

create table campaign_targets (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  campaign_id uuid not null,
  contact_id uuid,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  context jsonb not null default '{}'::jsonb,
  state target_state not null default 'queued',
  attempt_no int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_outcome text,
  last_call_id uuid,
  skip_reason text,
  external_run_id text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, campaign_id, phone_e164),
  foreign key (tenant_id, campaign_id) references campaigns(tenant_id, id) on delete cascade
);
create index campaign_targets_due on campaign_targets(next_attempt_at) where state in ('queued', 'scheduled');

-- One row per dial attempt: evidence of what the gate decided and why.
create table dial_attempts (
  tenant_id uuid not null,
  id bigint generated always as identity,
  target_id uuid not null,
  campaign_id uuid not null,
  phone_e164 text not null,
  decision text not null check (decision in ('dial','defer','skip')),
  reason text not null,
  gateway text,
  external_run_id text,
  outcome text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index dial_attempts_phone_day on dial_attempts(tenant_id, phone_e164, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['consents','campaigns','campaign_targets','dial_attempts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

-- Suppressions: a tenant sees its own list plus platform-wide entries; writes only its own.
alter table suppressions enable row level security;
alter table suppressions force row level security;
create policy supp_read on suppressions for select using (tenant_id is null or tenant_id = app_tenant_id());
create policy supp_insert on suppressions for insert with check (tenant_id = app_tenant_id());
create policy supp_delete on suppressions for delete using (tenant_id = app_tenant_id());

grant select, insert, update, delete on consents, campaigns, campaign_targets to jenai_app, jenai_platform;
grant select, insert, update on dial_attempts to jenai_app, jenai_platform;
grant select, insert, delete on suppressions to jenai_app, jenai_platform;
grant usage on all sequences in schema public to jenai_app, jenai_platform;
