-- 0002 Plans and billing terms. No payments here: prepaid wallets and a payment
-- gateway come later. Government and enterprise clients are billed postpaid
-- with a monthly invoice against a PO; usage is metered from calls.

create type billing_model as enum ('prepaid', 'postpaid_invoice', 'contract');

-- Global plan catalog (not tenant-owned). Money in paise.
create table plans (
  key text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  name text not null,
  description text not null default '',
  billing_model billing_model not null,
  monthly_fee_paise bigint not null default 0,
  fee_basis text not null default 'per_workspace' check (fee_basis in ('per_workspace','per_branch','contract')),
  included_minutes int not null default 0,
  overage_paise_per_min bigint,
  limits jsonb not null default '{}'::jsonb,       -- branches, phone_numbers, concurrent_calls, agents, users, campaigns
  features text[] not null default '{}',           -- outbound_campaigns, ai_qa, api_webhooks, integrations, multi_branch_number, custom_voice, sla, private_hosting
  is_public boolean not null default true,
  active boolean not null default true,
  sort int not null default 100,
  updated_at timestamptz not null default now()
);

-- One row per client: the plan they are on and how they are billed.
create table subscriptions (
  tenant_id uuid primary key references organizations(id) on delete cascade,
  plan_key text not null references plans(key),
  billing_model billing_model not null,
  starts_on date not null default current_date,
  ends_on date,
  billing_day int not null default 1 check (billing_day between 1 and 28),
  -- Contract terms (enterprise / government); null means the plan's numbers apply.
  contract_fee_paise bigint,
  contract_rate_paise_per_min bigint,
  committed_minutes int,
  limit_overrides jsonb not null default '{}'::jsonb,
  extra_features text[] not null default '{}',
  -- Invoice details (postpaid): who the monthly bill is raised to.
  po_number text,
  po_valid_until date,
  invoice_to_name text,
  invoice_to_department text,
  invoice_to_address text,
  invoice_to_gstin text,
  invoice_email text,
  payment_terms_days int not null default 30,
  notes text,
  updated_by text references "user"(id),
  updated_at timestamptz not null default now()
);

alter table subscriptions enable row level security;
alter table subscriptions force row level security;
create policy tenant_isolation on subscriptions using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());

grant select on plans to jenai_app;
grant select, insert, update, delete on plans to jenai_platform;
grant select, insert, update on subscriptions to jenai_app, jenai_platform;
