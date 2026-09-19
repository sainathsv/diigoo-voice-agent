-- 0001 Foundation: identity, tenancy hierarchy, roles, audit, support access, outbox.
-- Runs as jenai_owner. The app connects as jenai_app (row-level security applies);
-- the Diigoo console uses jenai_platform (BYPASSRLS) only after a platform permission check.

create extension if not exists pgcrypto;

-- Tenant id for the current transaction, set by withTenant() with set_config(..., true).
-- NULLIF: after a transaction the setting reads as '' not NULL on pooled connections.
create or replace function app_tenant_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Authentication (Better Auth). Global, not tenant-owned.
-- ---------------------------------------------------------------------------
create table "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table session (
  id text primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  user_id text not null references "user"(id) on delete cascade
);
create index session_user_idx on session(user_id);

create table account (
  id text primary key,
  account_id text not null,
  provider_id text not null,
  user_id text not null references "user"(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index account_user_idx on account(user_id);

create table verification (
  id text primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index verification_identifier_idx on verification(identifier);

-- ---------------------------------------------------------------------------
-- Organizations: the platform (Diigoo), partners (later) and clients (tenants).
-- A client organization's id IS its tenant id.
-- ---------------------------------------------------------------------------
create type org_kind as enum ('platform', 'partner', 'client');
create type org_status as enum ('onboarding', 'active', 'suspended', 'closed');

create table organizations (
  id uuid primary key default gen_random_uuid(),
  kind org_kind not null,
  parent_id uuid references organizations(id),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  status org_status not null default 'onboarding',
  vertical text,                                  -- dental, derma, hospital, municipal, spa, gym, restaurant, other
  plan text not null default 'trial',
  legal_name text,
  gstin text,
  city text,
  state text,
  timezone text not null default 'Asia/Kolkata',
  languages text[] not null default array['te','hi','en'],
  support_access_until timestamptz,               -- client's standing consent for read-only JENAI support
  suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_one_platform on organizations(kind) where kind = 'platform';

-- ---------------------------------------------------------------------------
-- Tenant-owned tables. tenant_id = organizations.id of the client (or platform).
-- ---------------------------------------------------------------------------
create table branches (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  code text,
  city text,
  address text,
  phone text,
  timezone text not null default 'Asia/Kolkata',
  languages text[] not null default array['te','hi','en'],
  hours jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id)
);

create table teams (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  name text not null,
  kind text,                                      -- front_desk, marketing, doctors, qa, sales ...
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete set null (branch_id)
);

create type membership_status as enum ('invited', 'active', 'suspended');

create table memberships (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  user_id text not null references "user"(id) on delete cascade,
  status membership_status not null default 'active',
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

create table team_members (
  tenant_id uuid not null,
  team_id uuid not null,
  membership_id uuid not null,
  primary key (tenant_id, team_id, membership_id),
  foreign key (tenant_id, team_id) references teams(tenant_id, id) on delete cascade,
  foreign key (tenant_id, membership_id) references memberships(tenant_id, id) on delete cascade
);

-- Roles: system templates have tenant_id NULL and are readable by everyone.
create type role_side as enum ('platform', 'client');

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references organizations(id) on delete cascade,
  side role_side not null,
  key text not null,
  name text not null,
  description text not null default '',
  permissions text[] not null,
  default_scope text not null default 'org' check (default_scope in ('org','branch')),
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index roles_system_key on roles(side, key) where tenant_id is null;
create unique index roles_tenant_key on roles(tenant_id, key) where tenant_id is not null;

create type scope_type as enum ('org', 'branch');

create table role_bindings (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  membership_id uuid not null,
  role_id uuid not null references roles(id),
  scope_type scope_type not null default 'org',
  branch_id uuid,
  granted_by text references "user"(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, membership_id) references memberships(tenant_id, id) on delete cascade,
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete cascade,
  check ((scope_type = 'org' and branch_id is null) or (scope_type = 'branch' and branch_id is not null))
);
create unique index role_bindings_unique on role_bindings(tenant_id, membership_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

create type invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table invitations (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  email text not null,
  name text,
  role_id uuid not null references roles(id),
  scope_type scope_type not null default 'org',
  branch_id uuid,
  token_hash text not null unique,
  invited_by text references "user"(id),
  status invitation_status not null default 'pending',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete cascade
);

create table api_keys (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  branch_id uuid,
  created_by text references "user"(id),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id) on delete cascade
);

-- Go-live gate (Blueprint Part 11): a client cannot go live until every step passes.
create type step_status as enum ('pending', 'in_progress', 'passed', 'failed', 'skipped');

create table provisioning_steps (
  tenant_id uuid not null references organizations(id) on delete cascade,
  step text not null,
  status step_status not null default 'pending',
  detail text,
  updated_by text references "user"(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, step)
);

-- Support access (Blueprint Part 3): no standing access; consented, time-boxed, audited.
create type support_mode as enum ('read', 'write', 'breakglass');
create type grant_status as enum ('requested', 'approved', 'denied', 'revoked', 'expired');

create table support_grants (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  staff_user_id text not null references "user"(id),
  mode support_mode not null,
  reason text not null,
  ticket text,
  status grant_status not null default 'requested',
  duration_minutes int not null default 60 check (duration_minutes between 5 and 240),
  requested_at timestamptz not null default now(),
  decided_by text references "user"(id),
  decided_at timestamptz,
  platform_approver text references "user"(id),   -- second approver for write mode
  starts_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  primary key (tenant_id, id),
  unique (id)
);

-- Append-only audit log. tenant_id NULL = platform-level event.
create type audit_via as enum ('user', 'support', 'api', 'system');

create table audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references organizations(id) on delete set null,
  actor_user_id text,
  impersonator_user_id text,
  via audit_via not null default 'user',
  action text not null,
  target_type text,
  target_id text,
  summary text not null,
  diff jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index audit_events_tenant_time on audit_events(tenant_id, created_at desc);

-- Transactional outbox: written in the same transaction as the business change.
create table outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  aggregate text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox(id) where published_at is null;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table organizations enable row level security;
alter table organizations force row level security;
create policy tenant_self on organizations
  using (id = app_tenant_id())
  with check (id = app_tenant_id());

do $$
declare t text;
begin
  foreach t in array array['branches','teams','memberships','team_members','role_bindings',
                           'invitations','api_keys','provisioning_steps','support_grants']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
  end loop;
end $$;

-- Roles: system templates visible to all; custom roles only inside their tenant.
alter table roles enable row level security;
alter table roles force row level security;
create policy roles_read on roles for select using (tenant_id is null or tenant_id = app_tenant_id());
create policy roles_write on roles for insert with check (tenant_id = app_tenant_id());
create policy roles_update on roles for update using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
create policy roles_delete on roles for delete using (tenant_id = app_tenant_id());

-- Audit: a tenant reads its own events; inserts must match the current tenant (or be platform-level with no tenant set).
alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_read on audit_events for select using (tenant_id = app_tenant_id());
create policy audit_insert on audit_events for insert
  with check (tenant_id = app_tenant_id() or (tenant_id is null and app_tenant_id() is null));

alter table outbox enable row level security;
alter table outbox force row level security;
create policy outbox_insert on outbox for insert with check (tenant_id = app_tenant_id() or (tenant_id is null and app_tenant_id() is null));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant usage on schema public to jenai_app, jenai_platform;
grant select, insert, update, delete on "user", session, account, verification to jenai_app, jenai_platform;
grant select, insert, update, delete on organizations, branches, teams, memberships, team_members, roles,
  role_bindings, invitations, api_keys, provisioning_steps, support_grants to jenai_app, jenai_platform;
-- Audit and outbox are append-only for the app.
grant select, insert on audit_events, outbox to jenai_app, jenai_platform;
grant update (published_at) on outbox to jenai_platform;
grant usage on all sequences in schema public to jenai_app, jenai_platform;
grant execute on function app_tenant_id() to jenai_app, jenai_platform;

-- ---------------------------------------------------------------------------
-- Narrow cross-tenant lookups (SECURITY DEFINER, owned by the BYPASSRLS role).
-- These are the ONLY ways the app pool reads across tenants.
-- ---------------------------------------------------------------------------

-- A dedicated schema so the BYPASSRLS role only ever needs CREATE here, never on public.
create schema lookup;
grant create on schema lookup to jenai_platform;
grant usage on schema lookup to jenai_app, jenai_platform;

-- Organizations a user belongs to (for the organization switcher at login).
create or replace function lookup.my_organizations(p_user_id text)
returns table (org_id uuid, kind org_kind, name text, slug text, org_status org_status,
               membership_id uuid, membership_status membership_status)
language sql stable security definer set search_path = public as $$
  select o.id, o.kind, o.name, o.slug, o.status, m.id, m.status
  from memberships m join organizations o on o.id = m.tenant_id
  where m.user_id = p_user_id and m.status <> 'suspended' and o.status <> 'closed'
  order by o.kind, o.name
$$;

-- Pending invitation by token hash (for the accept-invite page).
create or replace function lookup.invitation_by_token(p_token_hash text)
returns table (tenant_id uuid, invitation_id uuid, email text, name text, org_name text, role_name text,
               status invitation_status, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select i.tenant_id, i.id, i.email, i.name, o.name, r.name, i.status, i.expires_at
  from invitations i join organizations o on o.id = i.tenant_id join roles r on r.id = i.role_id
  where i.token_hash = p_token_hash
$$;

-- Accept an invitation atomically: membership + role binding + mark accepted.
-- The caller must pass the signed-in user's id; the email must match the invitation.
create or replace function lookup.accept_invitation(p_token_hash text, p_user_id text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
  u_email text;
  m_id uuid;
begin
  select * into inv from invitations where token_hash = p_token_hash for update;
  if not found then raise exception 'invitation_not_found'; end if;
  if inv.status <> 'pending' then raise exception 'invitation_not_pending'; end if;
  if inv.expires_at < now() then
    update invitations set status = 'expired' where tenant_id = inv.tenant_id and id = inv.id;
    raise exception 'invitation_expired';
  end if;
  select email into u_email from "user" where id = p_user_id;
  if u_email is null or lower(u_email) <> lower(inv.email) then raise exception 'invitation_email_mismatch'; end if;

  insert into memberships (tenant_id, user_id, status) values (inv.tenant_id, p_user_id, 'active')
  on conflict (tenant_id, user_id) do update set status = 'active', updated_at = now()
  returning id into m_id;

  insert into role_bindings (tenant_id, membership_id, role_id, scope_type, branch_id, granted_by)
  values (inv.tenant_id, m_id, inv.role_id, inv.scope_type, inv.branch_id, inv.invited_by)
  on conflict do nothing;

  update invitations set status = 'accepted', accepted_at = now() where tenant_id = inv.tenant_id and id = inv.id;

  insert into audit_events (tenant_id, actor_user_id, via, action, target_type, target_id, summary)
  values (inv.tenant_id, p_user_id, 'user', 'member.joined', 'membership', m_id::text,
          'Accepted invitation for ' || inv.email);
  return inv.tenant_id;
end $$;

alter function lookup.my_organizations(text) owner to jenai_platform;
alter function lookup.invitation_by_token(text) owner to jenai_platform;
alter function lookup.accept_invitation(text, text) owner to jenai_platform;
revoke all on function lookup.my_organizations(text), lookup.invitation_by_token(text), lookup.accept_invitation(text, text) from public;
grant execute on function lookup.my_organizations(text), lookup.invitation_by_token(text), lookup.accept_invitation(text, text) to jenai_app;
