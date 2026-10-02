-- 0021 Which case each call belongs to (CY Police, 2026-10-03).
--
-- A call opens the complainant's case, or adds to the one still being filled
-- in on WhatsApp. The case starts from what the voice engine took on the call
-- as soon as the call ends; the local AI reads the call again later. This link
-- makes sure WhatsApp follows each call once, and lets Analytics show every
-- call of a case (not only the first). One call belongs to one case.

create table case_calls (
  tenant_id uuid not null references organizations(id) on delete cascade,
  call_id uuid not null,
  case_id uuid not null,
  linked_at timestamptz not null default now(),
  primary key (tenant_id, call_id)
);
create index case_calls_case on case_calls(tenant_id, case_id);

alter table case_calls enable row level security;
alter table case_calls force row level security;
create policy tenant_isolation on case_calls using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on case_calls to jenai_app, jenai_platform;
