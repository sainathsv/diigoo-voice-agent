-- 0005 Telephony: each client has its own carrier account (no shared account),
-- and every number carries its series, purpose and A2P declaration (TRAI, 18 Sep 2026).

create type carrier_mode as enum ('managed_subaccount', 'client_account', 'forwarding');
create type kyc_status as enum ('not_started', 'link_sent', 'submitted', 'verified', 'rejected');

create table carrier_accounts (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  provider text not null check (provider in ('vobiz','exotel','plivo','tata','other')),
  mode carrier_mode not null,
  display_name text not null,
  external_account_id text,                     -- carrier sub-account id / account sid
  credential_ciphertext text,                   -- encrypted; never shown again after saving
  kyc_status kyc_status not null default 'not_started',
  kyc_reference text,
  voice_config_id int,                          -- Dograh telephony configuration id for this account
  status text not null default 'active' check (status in ('active','suspended','closed')),
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id)
);

create type number_series as enum ('landline', 'mobile', 'series_140', 'series_1600', 'toll_free');
create type number_purpose as enum ('inbound', 'outbound_service', 'outbound_promotional', 'both');

create table phone_numbers (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  carrier_account_id uuid not null,
  branch_id uuid,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  label text,
  series number_series not null,
  purpose number_purpose not null default 'inbound',
  inbound_agent_id uuid,
  is_default_caller_id boolean not null default false,
  a2p_declared_at timestamptz,                  -- declared to the operator as used for AI / automated calls
  a2p_reference text,
  dlt_header text,
  max_concurrency int not null default 10 check (max_concurrency between 1 and 1000),
  voice_number_id int,                          -- Dograh telephony phone number id
  status text not null default 'active' check (status in ('active','pending','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, carrier_account_id) references carrier_accounts(tenant_id, id) on delete restrict,
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id),
  foreign key (tenant_id, inbound_agent_id) references agents(tenant_id, id) on delete set null (inbound_agent_id)
);
-- A number belongs to exactly one client, platform-wide (a shared number is how inbound calls get hijacked).
create unique index phone_numbers_e164_global on phone_numbers(e164) where status <> 'released';

do $$
declare t text;
begin
  foreach t in array array['carrier_accounts','phone_numbers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

grant select, insert, update, delete on carrier_accounts, phone_numbers to jenai_app, jenai_platform;
