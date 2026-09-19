-- 0011 AI safety checks: every agent version is attacked by the AI red team
-- before it can go live, and every live agent is re-checked by a weekly sweep.
-- Built for the whole fleet: one row per check, cached by prompt fingerprint.

create type safety_status as enum ('queued', 'running', 'passed', 'failed', 'needs_review', 'error');
create type safety_reason as enum ('publish', 'manual', 'sweep');

create table agent_safety_checks (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  agent_id uuid not null,
  version_id uuid not null,
  prompt_hash text not null,            -- the exact inbound + outbound prompts checked
  suite_version int not null,           -- which set of attacks
  guardrails_version int,               -- platform safety block inside the prompt (null = legacy prompt)
  vertical text not null default 'general',
  target_model text not null,
  judge_model text not null,
  reason safety_reason not null,
  status safety_status not null default 'queued',
  held int not null default 0,
  failed int not null default 0,
  review int not null default 0,
  critical_failed int not null default 0,
  results jsonb not null default '[]'::jsonb,
  error text,
  cached_from uuid,                     -- a passing check with the same fingerprint was reused
  requested_by text references "user"(id),
  reviewed_by text references "user"(id),
  reviewed_at timestamptz,
  review_note text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, version_id) references agent_versions(tenant_id, id) on delete cascade
);
create index agent_safety_checks_queue on agent_safety_checks(created_at) where status = 'queued';
create index agent_safety_checks_version on agent_safety_checks(tenant_id, version_id, created_at desc);
create index agent_safety_checks_hash on agent_safety_checks(prompt_hash, suite_version, target_model) where status = 'passed';
create index agent_safety_checks_status on agent_safety_checks(status, finished_at desc);

alter table agent_safety_checks enable row level security;
alter table agent_safety_checks force row level security;
create policy safety_tenant_read on agent_safety_checks for select using (tenant_id = app_tenant_id());
create policy safety_tenant_insert on agent_safety_checks for insert with check (tenant_id = app_tenant_id());
create policy safety_tenant_update on agent_safety_checks for update using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update on agent_safety_checks to jenai_app;
grant select, insert, update on agent_safety_checks to jenai_platform;

-- Which safety block each version carries, so the fleet view can count agents on old guardrails.
alter table agent_versions add column guardrails_version int;
