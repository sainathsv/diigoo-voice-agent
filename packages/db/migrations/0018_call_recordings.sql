-- 0018 Recordings kept on the client's own server (CY Police, 2026-10-01).
--
-- A police department keeps its complaint calls on its own private server: the
-- recording is copied here when the call is synced, not streamed from the voice
-- engine on every play. Once a call's recording and transcript are held here, the
-- voice engine's copy can be deleted. Kept in its own table so listing calls never
-- reads the audio.

create table if not exists call_recordings (
  tenant_id uuid not null references organizations(id) on delete cascade,
  call_id uuid not null,
  mime text not null default 'audio/wav',
  bytes bytea not null,
  size_bytes integer not null,
  sha256 text not null,
  fetched_at timestamptz not null default now(),
  primary key (tenant_id, call_id),
  foreign key (tenant_id, call_id) references calls(tenant_id, id) on delete cascade
);
-- Audio barely compresses; stored uncompressed, a seek reads only the bytes it asks for.
alter table call_recordings alter column bytes set storage external;

alter table call_recordings enable row level security;
alter table call_recordings force row level security;
create policy tenant_isolation on call_recordings using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on call_recordings to jenai_app, jenai_platform;
