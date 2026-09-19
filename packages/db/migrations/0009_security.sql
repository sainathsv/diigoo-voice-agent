-- 0009 Security (blue side): sign-in events, detection alerts, tamper-evident audit log.

-- ---------------------------------------------------------------------------
-- 1. Sign-in and access events. Platform-wide: most are written before any
--    workspace is known. The app may only append; only the console role reads.
--    Kept at least 180 days (CERT-In, April 2022 directions); purged after 365.
-- ---------------------------------------------------------------------------
create type security_event_kind as enum (
  'signin_ok', 'signin_failed', 'signin_locked', 'signout',
  'access_denied', 'session_revoked', 'password_changed',
  'mfa_enabled', 'mfa_disabled', 'mfa_failed'
);

create table security_events (
  id bigint generated always as identity primary key,
  kind security_event_kind not null,
  email text,                 -- lower-cased, as typed at sign-in
  user_id text,
  tenant_id uuid,
  ip text,
  user_agent text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index security_events_time on security_events(created_at desc);
create index security_events_email_time on security_events(email, created_at desc);
create index security_events_ip_time on security_events(ip, created_at desc);
create index security_events_user_time on security_events(user_id, created_at desc);

grant insert on security_events to jenai_app, jenai_platform;
grant select, delete on security_events to jenai_platform;

-- ---------------------------------------------------------------------------
-- 2. Security alerts raised by the detector. One open alert per dedupe key;
--    repeats raise the hit count instead of flooding the queue.
-- ---------------------------------------------------------------------------
create type alert_severity as enum ('low', 'medium', 'high', 'critical');
create type alert_status as enum ('open', 'acknowledged', 'resolved', 'false_positive');

create table security_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references organizations(id) on delete set null,
  rule text not null,
  severity alert_severity not null,
  title text not null,
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status alert_status not null default 'open',
  hits int not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  notified_at timestamptz,
  handled_by text references "user"(id),
  handled_at timestamptz,
  note text
);
create unique index security_alerts_live_key on security_alerts(dedupe_key) where status in ('open', 'acknowledged');
create index security_alerts_status_time on security_alerts(status, last_seen desc);
create index security_alerts_tenant_time on security_alerts(tenant_id, last_seen desc);

alter table security_alerts enable row level security;
alter table security_alerts force row level security;
-- A client sees alerts about its own workspace; the console role bypasses RLS.
create policy alerts_tenant_read on security_alerts for select using (tenant_id = app_tenant_id());
grant select on security_alerts to jenai_app;
grant select, insert, update on security_alerts to jenai_platform;

-- Where each detector rule has read up to, so every event is judged once.
create table security_detector_state (
  name text primary key,
  last_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
grant select, insert, update on security_detector_state to jenai_platform;

-- ---------------------------------------------------------------------------
-- 3. Tamper-evident audit log. Each workspace (and the platform) has its own
--    hash chain: every event carries the previous event's hash, so editing or
--    removing any row breaks every hash after it. The app roles already cannot
--    UPDATE or DELETE; the trigger below also stops the owner role.
-- ---------------------------------------------------------------------------
alter table audit_events
  add column chain text,
  add column chain_seq bigint,
  add column prev_hash text,
  add column hash text;

-- The exact bytes that are hashed. Shared by the trigger and the verifier.
create or replace function lookup.audit_row_hash(p_prev text, e audit_events)
returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(concat_ws(chr(31),
    p_prev, e.chain, e.chain_seq::text, e.id::text,
    coalesce(e.actor_user_id, ''), coalesce(e.impersonator_user_id, ''), e.via::text, e.action,
    coalesce(e.target_type, ''), coalesce(e.target_id, ''), e.summary, coalesce(e.diff::text, ''),
    coalesce(e.ip, ''), coalesce(e.user_agent, ''),
    to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex')
$$;

-- Backfill the chains for events written before this migration, oldest first.
-- The owner is itself bound by RLS on this table (FORCE), so lift that for the backfill only.
alter table audit_events no force row level security;
do $$
declare
  r audit_events%rowtype;
  last_hash jsonb := '{}'::jsonb;
  last_seq jsonb := '{}'::jsonb;
  c text;
  prev text;
  s bigint;
begin
  for r in select * from audit_events order by id loop
    c := coalesce(r.tenant_id::text, 'platform');
    prev := coalesce(last_hash ->> c, 'genesis');
    s := coalesce((last_seq ->> c)::bigint, 0) + 1;
    r.chain := c;
    r.chain_seq := s;
    r.prev_hash := prev;
    r.hash := lookup.audit_row_hash(prev, r);
    update audit_events set chain = r.chain, chain_seq = r.chain_seq, prev_hash = r.prev_hash, hash = r.hash where id = r.id;
    last_hash := jsonb_set(last_hash, array[c], to_jsonb(r.hash));
    last_seq := jsonb_set(last_seq, array[c], to_jsonb(s));
  end loop;
end $$;
alter table audit_events force row level security;

alter table audit_events
  alter column chain set not null,
  alter column chain_seq set not null,
  alter column prev_hash set not null,
  alter column hash set not null;
create unique index audit_events_chain_seq on audit_events(chain, chain_seq);

-- Links each new event to the end of its chain. SECURITY DEFINER (owned by the
-- BYPASSRLS role) so it can see the previous event whatever the caller's RLS.
create or replace function lookup.audit_link()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prev_hash text;
  prev_seq bigint;
begin
  new.chain := coalesce(new.tenant_id::text, 'platform');
  -- One writer per chain at a time; different workspaces never wait on each other.
  perform pg_advisory_xact_lock(hashtextextended('audit:' || new.chain, 0));
  select a.hash, a.chain_seq into prev_hash, prev_seq
  from audit_events a where a.chain = new.chain order by a.chain_seq desc limit 1;
  new.chain_seq := coalesce(prev_seq, 0) + 1;
  new.prev_hash := coalesce(prev_hash, 'genesis');
  new.hash := lookup.audit_row_hash(new.prev_hash, new);
  return new;
end $$;

create trigger audit_events_link before insert on audit_events
  for each row execute function lookup.audit_link();

-- Nobody edits or deletes history. The one allowed change is the foreign key
-- clearing tenant_id when a workspace is deleted; the chain key stays intact.
create or replace function lookup.audit_immutable()
returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.tenant_id is not null and new.tenant_id is null
     and (to_jsonb(old) - 'tenant_id') = (to_jsonb(new) - 'tenant_id') then
    return new;
  end if;
  raise exception 'audit_events is append-only (% blocked)', tg_op;
end $$;

create trigger audit_events_no_update before update on audit_events
  for each row execute function lookup.audit_immutable();
create trigger audit_events_no_delete before delete on audit_events
  for each row execute function lookup.audit_immutable();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function lookup.audit_immutable();

-- Walks one chain and reports the first break (null when intact).
create or replace function lookup.verify_audit_chain(p_chain text)
returns table (chain text, events bigint, head_hash text, first_bad_id bigint, problem text)
language plpgsql stable security definer set search_path = public as $$
declare
  r audit_events%rowtype;
  expect_prev text := 'genesis';
  expect_seq bigint := 1;
  n bigint := 0;
begin
  for r in select * from audit_events a where a.chain = p_chain order by a.chain_seq loop
    n := n + 1;
    if r.chain_seq <> expect_seq then
      return query select p_chain, n, expect_prev, r.id, format('event %s missing before this one', expect_seq);
      return;
    end if;
    if r.prev_hash <> expect_prev then
      return query select p_chain, n, expect_prev, r.id, 'link to the previous event does not match';
      return;
    end if;
    if r.hash <> lookup.audit_row_hash(r.prev_hash, r) then
      return query select p_chain, n, expect_prev, r.id, 'event content was changed after it was written';
      return;
    end if;
    expect_prev := r.hash;
    expect_seq := expect_seq + 1;
  end loop;
  return query select p_chain, n, expect_prev, null::bigint, null::text;
end $$;

-- Latest position of every chain (for anchoring outside the database).
create or replace function lookup.audit_chain_heads()
returns table (chain text, chain_seq bigint, hash text, at timestamptz)
language sql stable security definer set search_path = public as $$
  select distinct on (a.chain) a.chain, a.chain_seq, a.hash, a.created_at
  from audit_events a order by a.chain, a.chain_seq desc
$$;

alter function lookup.audit_row_hash(text, audit_events) owner to jenai_platform;
alter function lookup.audit_link() owner to jenai_platform;
alter function lookup.verify_audit_chain(text) owner to jenai_platform;
alter function lookup.audit_chain_heads() owner to jenai_platform;
revoke all on function lookup.verify_audit_chain(text) from public;
revoke all on function lookup.audit_chain_heads() from public;
grant execute on function lookup.verify_audit_chain(text), lookup.audit_chain_heads() to jenai_platform;
grant execute on function lookup.audit_row_hash(text, audit_events) to jenai_app, jenai_platform;

grant usage on all sequences in schema public to jenai_app, jenai_platform;
