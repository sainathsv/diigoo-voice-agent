-- 0022 The complaint status lookup at the start of a call (CY Police, 2026-10-03).
--
-- When a call comes in, the voice engine can ask this server whether the number
-- calling has a complaint in progress, so the agent tells the caller its status
-- instead of taking the complaint again. The engine proves itself with a token
-- it keeps as a credential; only the token's SHA-256 is stored here. The answer
-- is the status alone, never the complaint.

create table voice_status_tokens (
  tenant_id uuid primary key references organizations(id) on delete cascade,
  token_sha256 text not null unique,
  created_at timestamptz not null default now()
);

alter table voice_status_tokens enable row level security;
alter table voice_status_tokens force row level security;
create policy tenant_isolation on voice_status_tokens using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on voice_status_tokens to jenai_app, jenai_platform;
