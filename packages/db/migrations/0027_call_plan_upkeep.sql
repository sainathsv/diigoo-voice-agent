-- 0027 Keeping the call plan honest and current (Zennara, 2026-10-04).
--
-- The plan is a client's own choice: reading their CRM on a timer starts only
-- when they switch the plan on, and each client's plan is worked out again
-- on its own clock, claimed by one worker at a time. A Zoho date with no time
-- of day is kept as such, so a reminder never says midnight, and a "do not
-- call" the team wrote in the notes keeps that person out. What a read passed
-- over is kept for the clinic to see, and a connection that keeps failing is
-- read less often. Only new columns, one trigger and one grant of an existing
-- permission: every existing row stays valid.

-- The appointment field held a date only: no time of day to remind them of.
-- Empty on rows read before this, which are read again in full.
alter table crm_records add column if not exists appointment_has_time boolean;
-- Their notes say not to call this person. Only this flag is kept, never the notes.
alter table crm_records add column if not exists notes_say_do_not_call boolean not null default false;

-- What the last read passed over or noticed, in plain words (no names or numbers).
alter table integrations add column if not exists last_pull_notes jsonb not null default '[]'::jsonb;
-- Reads that failed in a row, so a connection that keeps failing is read less often.
alter table integrations add column if not exists pull_failures int not null default 0;

-- The plan's own switch and clock, per client. A client's plan is read and
-- worked out on a timer only once they switch it on; next_replan_at is when
-- it is next worked out, and replan_lease_until holds it for one worker.
alter table call_plan_settings add column if not exists enabled boolean not null default false;
alter table call_plan_settings add column if not exists computed_at timestamptz;
alter table call_plan_settings add column if not exists next_replan_at timestamptz;
alter table call_plan_settings add column if not exists replan_lease_until timestamptz;
create index if not exists call_plan_settings_due on call_plan_settings(next_replan_at) where next_replan_at is not null;

-- Someone asking not to be called, or that entry going, changes their plan:
-- the client's plan is worked out again on the next pass, whoever wrote it
-- (the workspace, the call analyser, an import, the API).
create or replace function call_plan_suppressions_added() returns trigger language plpgsql as $$
begin
  update call_plan_settings c set next_replan_at = now()
  where c.tenant_id in (select distinct tenant_id from added where tenant_id is not null);
  return null;
end $$;
create or replace function call_plan_suppressions_removed() returns trigger language plpgsql as $$
begin
  update call_plan_settings c set next_replan_at = now()
  where c.tenant_id in (select distinct tenant_id from removed where tenant_id is not null);
  return null;
end $$;
drop trigger if exists suppressions_replan_added on suppressions;
create trigger suppressions_replan_added after insert on suppressions
  referencing new table as added for each statement execute function call_plan_suppressions_added();
drop trigger if exists suppressions_replan_removed on suppressions;
create trigger suppressions_replan_removed after delete on suppressions
  referencing old table as removed for each statement execute function call_plan_suppressions_removed();

-- The built-in roles that upload the visit list (0025's visits:import). Roles
-- are read from these rows, not from code, so the permission is added here,
-- where it also reaches a client's own database with its migrations. Built-in
-- roles have no tenant, so row-level security is lifted for this one update,
-- by the table's owner, and put back in the same transaction.
alter table roles no force row level security;
update roles set permissions = array_append(permissions, 'visits:import'), updated_at = now()
where tenant_id is null and is_system and side = 'client' and key in ('owner', 'admin', 'branch_manager')
  and not ('visits:import' = any(permissions));
alter table roles force row level security;
