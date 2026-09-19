-- 0003 Voice engine connection, agent templates, agents and immutable versions.
-- Blueprint Part 9: one shared behaviour base + per-client facts; every release
-- is an immutable snapshot; one live pointer serves inbound AND outbound.

-- Shared behaviour templates (global, versioned). Clients never edit these.
create table agent_templates (
  key text not null,                      -- clinic_receptionist, sales_outreach, grievance_desk
  version int not null,
  name text not null,
  base_prompt text not null,              -- universal behaviour (language, clarity, booking guard, no invented prices)
  end_prompt text not null,               -- goodbye node
  extraction jsonb not null,              -- [{name,type,prompt}] with {{domain}} placeholder allowed
  extraction_prompt text not null,
  created_at timestamptz not null default now(),
  primary key (key, version)
);

-- One connection per client to the voice engine (Dograh today).
create type voice_mode as enum ('read_only', 'managed');

create table voice_connections (
  tenant_id uuid primary key references organizations(id) on delete cascade,
  provider text not null default 'dograh' check (provider in ('dograh')),
  base_url text not null,
  external_org_id int,
  auth_kind text not null check (auth_kind in ('api_key', 'password')),
  credential_ciphertext text not null,          -- encrypted with the tenant's data key (AAD = tenant + purpose)
  mode voice_mode not null default 'read_only', -- read_only: import and sync; managed: JENAI publishes agents and dials
  status text not null default 'unverified' check (status in ('unverified','ok','error')),
  last_error text,
  last_verified_at timestamptz,
  last_sync_at timestamptz,
  created_by text references "user"(id),
  updated_at timestamptz not null default now()
);

create type agent_purpose as enum ('receptionist', 'outbound_sales', 'reminders', 'grievance', 'other');

create table agents (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  name text not null,
  purpose agent_purpose not null default 'receptionist',
  template_key text not null,
  template_version int not null,
  domain text not null default 'clinic',        -- used in extraction prompts: dental, skin or hair ...
  inbound_workflow_id int,                       -- Dograh workflow ids (inbound reads PUBLISHED)
  outbound_workflow_id int,                      -- (outbound reads draft unless triggered via public agent API)
  outbound_workflow_uuid text,                   -- for POST /public/agent/workflow/{uuid}
  live_version_id uuid,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id),
  foreign key (template_key, template_version) references agent_templates(key, version)
);

create type version_state as enum ('draft', 'pending_approval', 'publishing', 'live', 'superseded', 'failed', 'imported');

create table agent_versions (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  agent_id uuid not null,
  number int not null,
  state version_state not null default 'draft',
  persona_name text,
  greeting text not null,
  facts text not null,                          -- the ONLY per-client content (Blueprint Part 9)
  outbound_opening text,                        -- optional override of the outbound first line
  inbound_prompt text,                          -- rendered at publish time, kept for audit and drift checks
  outbound_prompt text,
  prompt_hash text,
  change_note text,
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  approved_by text references "user"(id),
  published_by text references "user"(id),
  published_at timestamptz,
  publish_result jsonb,                         -- per direction: workflow id, version before/after, ok, error
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, agent_id, number),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id) on delete cascade
);

-- Versions are immutable once they leave draft: only state/approval/publish bookkeeping may change.
create or replace function agent_versions_immutable() returns trigger language plpgsql as $$
begin
  if old.state not in ('draft', 'pending_approval') and (
       new.greeting is distinct from old.greeting or new.facts is distinct from old.facts
    or new.persona_name is distinct from old.persona_name or new.outbound_opening is distinct from old.outbound_opening) then
    raise exception 'agent_version_immutable: published versions cannot be edited; create a new version';
  end if;
  return new;
end $$;
create trigger agent_versions_immutable before update on agent_versions
  for each row execute function agent_versions_immutable();

do $$
declare t text;
begin
  foreach t in array array['agents','agent_versions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;
alter table voice_connections enable row level security;
alter table voice_connections force row level security;
create policy tenant_isolation on voice_connections using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());

grant select on agent_templates to jenai_app;
grant select, insert, update on agent_templates to jenai_platform;
grant select, insert, update, delete on voice_connections, agents, agent_versions to jenai_app, jenai_platform;
