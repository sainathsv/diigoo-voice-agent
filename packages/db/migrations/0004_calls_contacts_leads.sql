-- 0004 Calls (synced from the voice engine), contacts and leads.

create table contacts (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  email text,
  source text not null default 'call' check (source in ('call','import','form','manual','campaign','api')),
  tags text[] not null default '{}',
  attrs jsonb not null default '{}'::jsonb,
  owner_membership_id uuid,
  first_seen_at timestamptz not null default now(),
  last_call_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, phone_e164),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id)
);

create type call_direction as enum ('inbound', 'outbound');
create type call_status as enum ('queued', 'ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'unknown');

create table calls (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  agent_id uuid,
  agent_version_id uuid,
  contact_id uuid,
  campaign_id uuid,
  target_id uuid,
  direction call_direction not null,
  status call_status not null default 'unknown',
  provider text not null default 'dograh',
  external_run_id text not null,                -- Dograh workflow run id
  external_workflow_id int,
  from_e164 text,
  to_e164 text,
  started_at timestamptz not null,
  duration_s int,
  disposition text,
  summary text,
  transcript text,
  extracted jsonb not null default '{}'::jsonb, -- the engine's extraction (caller_name, concern, preferred_time, next_step ...)
  recording_ref text,                           -- server-side only; played through an authorised proxy
  transcript_ref text,
  cost_paise bigint,
  synced_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, provider, external_run_id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id) on delete set null (agent_id),
  foreign key (tenant_id, contact_id) references contacts(tenant_id, id) on delete set null (contact_id)
);
create index calls_tenant_time on calls(tenant_id, started_at desc);
create index calls_tenant_branch_time on calls(tenant_id, branch_id, started_at desc);

create type lead_stage as enum ('new', 'contacted', 'callback', 'booked', 'won', 'lost');

create table leads (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  contact_id uuid not null,
  branch_id uuid,
  source text not null default 'call' check (source in ('call','form','campaign','manual','api')),
  first_call_id uuid,
  last_call_id uuid,
  stage lead_stage not null default 'new',
  interest text,                                -- what they asked about, in English
  preferred_time_text text,                     -- as extracted
  preferred_at timestamptz,                     -- parsed, when possible
  temperature text check (temperature in ('hot','warm','cold')),
  owner_membership_id uuid,
  next_follow_up_at timestamptz,
  lost_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, contact_id) references contacts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id)
);
-- At most one open lead per contact; closed ones (won/lost) stay as history.
create unique index leads_one_open_per_contact on leads(tenant_id, contact_id) where stage not in ('won', 'lost');

do $$
declare t text;
begin
  foreach t in array array['contacts','calls','leads'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on contacts, calls, leads to jenai_app, jenai_platform;
