-- 0014 Integrations: JENAI plugs into the client's own system.
--
-- Clients have run Zoho, SAP, LeadSquared or an in-house panel for years and
-- everything lives there. We do not ask them to move. Their system stays the
-- record of truth: it tells us who to call, we hand back what happened on the
-- call. We keep only what a call needs, plus a link to their record.

create type integration_kind as enum (
  'webhook_out',      -- signed HTTP push to any endpoint they own
  'rest_generic',     -- call their own API with a templated request
  'zoho_crm',
  'salesforce',
  'hubspot',
  'leadsquared',
  'sap_odata',
  'google_sheets'
);
create type integration_status as enum ('draft', 'connected', 'error', 'paused');

create table integrations (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  kind integration_kind not null,
  name text not null,
  status integration_status not null default 'draft',
  config jsonb not null default '{}'::jsonb,     -- endpoints, module and view names, sheet id
  mapping jsonb not null default '{}'::jsonb,    -- JENAI field -> their field, per object
  events text[] not null default '{}',           -- which events to push out
  credentials text,                              -- sealed with the tenant key (AES-256-GCM)
  direction text not null default 'both' check (direction in ('in', 'out', 'both')),
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id)
);
create index integrations_tenant on integrations(tenant_id, status);

alter table integrations enable row level security;
alter table integrations force row level security;
create policy integrations_rw on integrations using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on integrations to jenai_app, jenai_platform;

-- Every write-back and every incoming trigger, with an idempotency key so a
-- retry (theirs or ours) never doubles a call or a CRM note.
create table integration_events (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  integration_id uuid,
  direction text not null check (direction in ('in', 'out')),
  kind text not null,                            -- call.completed, lead.created, call.requested
  ref_type text,
  ref_id text,
  external_id text,                              -- their record
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'done', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  http_status int,
  response text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key)
);
create index integration_events_queue on integration_events(next_attempt_at) where status = 'queued';
create index integration_events_tenant_time on integration_events(tenant_id, created_at desc);

alter table integration_events enable row level security;
alter table integration_events force row level security;
create policy integration_events_read on integration_events for select using (tenant_id = app_tenant_id());
create policy integration_events_write on integration_events for insert with check (tenant_id = app_tenant_id());
create policy integration_events_update on integration_events for update using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update on integration_events to jenai_app, jenai_platform;

-- Our record <-> their record, so a second call updates the same CRM row.
create table external_links (
  tenant_id uuid not null references organizations(id) on delete cascade,
  integration_id uuid not null,
  our_type text not null,                        -- contact | lead | call | campaign_target
  our_id uuid not null,
  external_type text not null,                   -- Leads | Contacts | Invoice | row
  external_id text not null,
  external_url text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, integration_id, our_type, our_id),
  unique (tenant_id, integration_id, external_type, external_id)
);
alter table external_links enable row level security;
alter table external_links force row level security;
create policy external_links_rw on external_links using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on external_links to jenai_app, jenai_platform;

-- API keys already exist (0001). A key now records where it may be used from
-- and what it last did, so a leaked key is easy to spot and pin down.
alter table api_keys add column allowed_ips text[] not null default '{}';
alter table api_keys add column last_used_ip text;
alter table api_keys add column calls_made int not null default 0;

-- A campaign that exists to receive calls asked for by the client's own system
-- (a button in their CRM), rather than a list uploaded here.
alter table campaigns add column on_demand boolean not null default false;
create index campaigns_on_demand on campaigns(tenant_id, client_program_id) where on_demand;
