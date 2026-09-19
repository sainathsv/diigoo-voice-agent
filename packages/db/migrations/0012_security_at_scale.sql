-- 0012 Security at fleet scale (tens of thousands of workspaces).
--   1. Sign-in events partitioned by month: retention drops whole months, no bloat.
--   2. Sign-in lockout counted in the database, shared by every web server.
--   3. Audit chains: O(1) head per chain, incremental verification from a
--      checkpoint, and one fingerprint over all chains for off-site anchoring.

-- ---------------------------------------------------------------------------
-- 1. security_events -> monthly partitions
-- ---------------------------------------------------------------------------
create sequence security_events_seq;

create table security_events_p (
  id bigint not null default nextval('security_events_seq'),
  kind security_event_kind not null,
  email text,
  user_id text,
  tenant_id uuid,
  ip text,
  user_agent text,
  detail jsonb,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- Catch-all so an insert never fails if the worker has not created a month yet.
create table security_events_default partition of security_events_p default;

-- Months from the oldest existing event to three months ahead.
do $$
declare
  m date := date_trunc('month', coalesce((select min(created_at) from security_events), now()))::date;
  stop date := (date_trunc('month', now()) + interval '4 months')::date;
begin
  while m < stop loop
    execute format('create table %I partition of security_events_p for values from (%L) to (%L)',
      'security_events_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
    m := (m + interval '1 month')::date;
  end loop;
end $$;

insert into security_events_p (id, kind, email, user_id, tenant_id, ip, user_agent, detail, created_at)
  select id, kind, email, user_id, tenant_id, ip, user_agent, detail, created_at from security_events;
select setval('security_events_seq', coalesce((select max(id) from security_events), 0) + 1, false);

drop table security_events;
alter table security_events_p rename to security_events;
alter sequence security_events_seq owned by security_events.id;

create index security_events_time on security_events(created_at desc);
create index security_events_email_time on security_events(email, created_at desc);
create index security_events_ip_time on security_events(ip, created_at desc);
create index security_events_user_time on security_events(user_id, created_at desc);
create index security_events_id on security_events(id);

grant insert on security_events to jenai_app, jenai_platform;
grant select on security_events to jenai_platform;
grant usage on sequence security_events_seq to jenai_app, jenai_platform;

-- Creates the next months and drops months past retention. Owned by the table
-- owner (DDL); the worker calls it through the console role.
create or replace function lookup.security_events_maintain(p_keep_days int default 365)
returns text
language plpgsql security definer set search_path = public as $$
declare
  m date;
  r record;
  made int := 0;
  dropped int := 0;
begin
  for i in 0..3 loop
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    if to_regclass('security_events_' || to_char(m, 'YYYY_MM')) is null then
      execute format('create table %I partition of security_events for values from (%L) to (%L)',
        'security_events_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
      made := made + 1;
    end if;
  end loop;
  for r in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'security_events'::regclass and c.relname ~ '^security_events_\d{4}_\d{2}$'
  loop
    if to_date(substr(r.relname, 17), 'YYYY_MM') + interval '1 month' < now() - make_interval(days => greatest(p_keep_days, 180)) then
      execute format('drop table %I', r.relname);
      dropped := dropped + 1;
    end if;
  end loop;
  return format('%s month(s) added, %s dropped', made, dropped);
end $$;
revoke all on function lookup.security_events_maintain(int) from public;
grant execute on function lookup.security_events_maintain(int) to jenai_platform;

-- ---------------------------------------------------------------------------
-- 2. Shared sign-in lockout: wrong passwords since the last success, in the window.
-- ---------------------------------------------------------------------------
create or replace function lookup.signin_failures(p_email text, p_minutes int default 15)
returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from security_events f
  where f.email = lower(p_email) and f.kind = 'signin_failed'
    and f.created_at > now() - make_interval(mins => p_minutes)
    and f.created_at > coalesce((
      select max(s.created_at) from security_events s
      where s.email = lower(p_email) and s.kind = 'signin_ok' and s.created_at > now() - make_interval(mins => p_minutes)
    ), '-infinity'::timestamptz)
$$;
alter function lookup.signin_failures(text, int) owner to jenai_platform;
revoke all on function lookup.signin_failures(text, int) from public;
grant execute on function lookup.signin_failures(text, int) to jenai_app, jenai_platform;

-- ---------------------------------------------------------------------------
-- 3. Audit chains at scale
-- ---------------------------------------------------------------------------
create table audit_chain_heads (
  chain text primary key,
  seq bigint not null,
  hash text not null,
  updated_at timestamptz not null default now()
);
create index audit_chain_heads_updated on audit_chain_heads(updated_at);

-- Seed heads from existing chains (the owner is bound by RLS on audit_events, lifted briefly).
alter table audit_events no force row level security;
insert into audit_chain_heads (chain, seq, hash, updated_at)
  select distinct on (chain) chain, chain_seq, hash, created_at from audit_events order by chain, chain_seq desc;
alter table audit_events force row level security;

-- Linking now reads and moves the head row (row lock per chain) instead of
-- searching the log: constant time however long the history gets.
create or replace function lookup.audit_link()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  h audit_chain_heads%rowtype;
begin
  new.chain := coalesce(new.tenant_id::text, 'platform');
  insert into audit_chain_heads (chain, seq, hash) values (new.chain, 0, 'genesis') on conflict (chain) do nothing;
  select * into h from audit_chain_heads where chain = new.chain for update;
  new.chain_seq := h.seq + 1;
  new.prev_hash := h.hash;
  new.hash := lookup.audit_row_hash(new.prev_hash, new);
  update audit_chain_heads set seq = new.chain_seq, hash = new.hash, updated_at = now() where chain = new.chain;
  return new;
end $$;
-- The owner of the heads table runs the trigger; nobody else may write heads.
alter function lookup.audit_link() owner to jenai_owner;
grant select on audit_chain_heads to jenai_platform;

create table audit_chain_checkpoints (
  chain text primary key,
  seq bigint not null,
  hash text not null,
  verified_at timestamptz not null default now()
);
grant select on audit_chain_checkpoints to jenai_platform;

-- Verifies only the events added since the chain's last checkpoint, checks the
-- head agrees, and moves the checkpoint forward. p_full walks from the start.
create or replace function lookup.verify_audit_chain_since(p_chain text, p_full boolean default false)
returns table (chain text, checked bigint, head_seq bigint, first_bad_id bigint, problem text)
language plpgsql security definer set search_path = public as $$
declare
  cp audit_chain_checkpoints%rowtype;
  hd audit_chain_heads%rowtype;
  r audit_events%rowtype;
  expect_prev text := 'genesis';
  expect_seq bigint := 1;
  n bigint := 0;
begin
  if not p_full then
    select * into cp from audit_chain_checkpoints c where c.chain = p_chain;
    if found then
      expect_prev := cp.hash;
      expect_seq := cp.seq + 1;
    end if;
  end if;
  for r in select * from audit_events a where a.chain = p_chain and a.chain_seq >= expect_seq order by a.chain_seq loop
    n := n + 1;
    if r.chain_seq <> expect_seq then
      return query select p_chain, n, expect_seq - 1, r.id, format('event %s missing before this one', expect_seq);
      return;
    end if;
    if r.prev_hash <> expect_prev then
      return query select p_chain, n, expect_seq - 1, r.id, 'link to the previous event does not match';
      return;
    end if;
    if r.hash <> lookup.audit_row_hash(r.prev_hash, r) then
      return query select p_chain, n, expect_seq - 1, r.id, 'event content was changed after it was written';
      return;
    end if;
    expect_prev := r.hash;
    expect_seq := expect_seq + 1;
  end loop;
  select * into hd from audit_chain_heads h where h.chain = p_chain;
  if found and (hd.seq <> expect_seq - 1 or hd.hash <> expect_prev) then
    return query select p_chain, n, expect_seq - 1, null::bigint, 'the chain head does not match the log (events removed from the end?)';
    return;
  end if;
  insert into audit_chain_checkpoints as c (chain, seq, hash, verified_at) values (p_chain, expect_seq - 1, expect_prev, now())
    on conflict on constraint audit_chain_checkpoints_pkey do update set seq = excluded.seq, hash = excluded.hash, verified_at = now();
  return query select p_chain, n, expect_seq - 1, null::bigint, null::text;
end $$;
-- Reads every workspace's log (BYPASSRLS) and writes checkpoints.
alter function lookup.verify_audit_chain_since(text, boolean) owner to jenai_platform;
grant insert, update on audit_chain_checkpoints to jenai_platform;
revoke all on function lookup.verify_audit_chain_since(text, boolean) from public;
grant execute on function lookup.verify_audit_chain_since(text, boolean) to jenai_platform;

-- One fingerprint over every chain head, plus the heads that moved since the
-- last anchor. The fingerprint is shipped off the database (server logs, 180+
-- days): rewriting history then also means matching a value already shipped.
create table audit_anchors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  root text not null,
  chains int not null,
  changed jsonb not null
);
grant select on audit_anchors to jenai_platform;

create or replace function lookup.audit_anchor()
returns table (id bigint, root text, chains int, changed int)
language plpgsql security definer set search_path = public as $$
declare
  last_at timestamptz;
  v_root text;
  v_n int;
  v_changed jsonb;
  v_id bigint;
begin
  select max(a.at) into last_at from audit_anchors a;
  select encode(sha256(convert_to(coalesce(string_agg(h.chain || ':' || h.seq || ':' || h.hash, E'\n' order by h.chain), ''), 'UTF8')), 'hex'), count(*)::int
    into v_root, v_n from audit_chain_heads h;
  select coalesce(jsonb_object_agg(h.chain, jsonb_build_array(h.seq, h.hash)), '{}'::jsonb)
    into v_changed from audit_chain_heads h where last_at is null or h.updated_at > last_at;
  insert into audit_anchors (root, chains, changed) values (v_root, v_n, v_changed) returning audit_anchors.id into v_id;
  return query select v_id, v_root, v_n, (select count(*)::int from jsonb_object_keys(v_changed));
end $$;
revoke all on function lookup.audit_anchor() from public;
grant execute on function lookup.audit_anchor() to jenai_platform;

-- Chains that moved since their last checkpoint (the hourly work list).
create or replace function lookup.audit_chains_to_verify(p_limit int default 5000)
returns table (chain text)
language sql stable security definer set search_path = public as $$
  select h.chain from audit_chain_heads h left join audit_chain_checkpoints c on c.chain = h.chain
  where c.chain is null or c.seq < h.seq
  order by c.verified_at nulls first limit p_limit
$$;
alter function lookup.audit_chains_to_verify(int) owner to jenai_platform;
revoke all on function lookup.audit_chains_to_verify(int) from public;
grant execute on function lookup.audit_chains_to_verify(int) to jenai_platform;
