-- 0010 Two-step sign-in (TOTP authenticator apps), Better Auth two-factor plugin.
-- Required for Diigoo staff in production; optional for client users.

alter table "user" add column two_factor_enabled boolean not null default false;

create table two_factor (
  id text primary key,
  secret text not null,                 -- encrypted by Better Auth with the auth secret
  backup_codes text not null,           -- encrypted
  user_id text not null references "user"(id) on delete cascade,
  verified boolean not null default true,
  failed_verification_count integer not null default 0,
  locked_until timestamptz
);
create index two_factor_user on two_factor(user_id);
create index two_factor_secret on two_factor(secret);

grant select, insert, update, delete on two_factor to jenai_app, jenai_platform;

-- A person's own recent sign-in activity, for their "Sign-in and security" page.
-- The app role cannot read security_events; this returns only the caller's rows.
create or replace function lookup.my_security_events(p_user_id text, p_email text, p_limit int default 20)
returns table (kind security_event_kind, ip text, user_agent text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.kind, e.ip, e.user_agent, e.created_at
  from security_events e
  where (e.user_id = p_user_id or e.email = lower(p_email))
    and e.kind in ('signin_ok', 'signin_failed', 'signin_locked', 'mfa_failed', 'mfa_enabled', 'mfa_disabled', 'session_revoked', 'password_changed')
  order by e.id desc
  limit least(greatest(p_limit, 1), 50)
$$;
alter function lookup.my_security_events(text, text, int) owner to jenai_platform;
revoke all on function lookup.my_security_events(text, text, int) from public;
grant execute on function lookup.my_security_events(text, text, int) to jenai_app, jenai_platform;
