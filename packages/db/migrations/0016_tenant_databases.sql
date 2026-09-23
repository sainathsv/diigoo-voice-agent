-- Client-hosted data (Blue Cloud, 2026-09-23).
--
-- A client may keep their own records on their own Postgres server. This table
-- is the registry: it lives on the PLATFORM database and never moves, because
-- it is how we find a client's database in the first place.
--
-- Five kinds of row stay on our server even for these clients, and the reasons
-- are not stylistic:
--   subscriptions   billing. A client must not be able to edit their own plan.
--   api_keys        our API authenticates against these; if they lived on the
--                   client's server, their outage would break authentication.
--   security_events, security_alerts
--                   our record of abuse and attacks. Evidence does not get
--                   stored where the subject of it can delete it.
--   audit anchors   the chain itself follows the client, but the hourly
--                   fingerprint stays here, so tampering is still detectable.

create table if not exists tenant_databases (
  tenant_id       uuid primary key references organizations(id) on delete cascade,
  label           text not null,
  host            text not null,
  port            integer not null default 5432,
  database        text not null,
  username        text not null,
  secret          text not null,              -- sealed with sealSecret(tenant, 'tenant_db')
  sslmode         text not null default 'verify-full',
  ca_certificate  text,                       -- pinned server certificate, when they give us one
  status          text not null default 'pending'
                  check (status in ('pending', 'migrating', 'ready', 'unreachable', 'disabled')),
  schema_version  integer not null default 0, -- highest migration applied over there
  last_ok_at      timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table tenant_databases is
  'Clients whose own records live on their own Postgres. One row per client; absent means they use the shared database.';
comment on column tenant_databases.secret is
  'Password, sealed with the tenant-bound AES-GCM helper. Never stored in plain text and never logged.';
comment on column tenant_databases.sslmode is
  'verify-full by default: the connection is encrypted AND the server identity is checked. Never disable.';

-- The registry is how the app finds a client's database, so the app role reads
-- it; only the platform console may change it. It carries no tenant data of its
-- own, so it is deliberately NOT under row-level security: a lookup has to work
-- before any tenant context exists.
revoke all on tenant_databases from public;
grant select on tenant_databases to jenai_app;
grant select, insert, update, delete on tenant_databases to jenai_platform;
