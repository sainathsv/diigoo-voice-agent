-- 0033 Reading Zenoti for a fleet of clinics, safely (review of the Zenoti read, 2026-10-04).
--
-- What reading a front desk system needs once it runs for thousands of
-- clinics, many with several centres, and once their front desks do what
-- front desks do: merge duplicate guests, change a guest's mobile, void an
-- invoice, sell a package that covers a whole category of services.

-- A guest whose profile keeps giving no number JENAI can dial (or whom their
-- system no longer has) is asked for again later each time, then not until
-- they are seen again, so a few thousand of them cannot use up every run.
alter table external_people add column profile_misses int not null default 0;

-- Which of their centres a visit was read at, so re-reading a centre's days
-- can remove a line their system no longer lists (a voided invoice); when the
-- connection last listed it; and the service's category and sub-category, so
-- a package that covers a category can be matched to the visits it pays for.
alter table visits add column centre_ref text;
alter table visits add column seen_at timestamptz;
alter table visits add column categories text[];
create index visits_centre_day on visits(tenant_id, integration_id, centre_ref, visit_date) where integration_id is not null;

-- The day a booking falls on in the centre's own time, as their system lists
-- bookings by it. Removing the ones it no longer lists for some days goes by
-- this day, never by a time zone JENAI had to guess for the centre.
alter table clinic_appointments add column local_day date;
create index clinic_appointments_guest on clinic_appointments(tenant_id, guest_ref);
create index clinic_appointments_centre_day on clinic_appointments(tenant_id, integration_id, centre_ref, local_day);

-- What a package line covers: one service, every service in a category, or
-- every service with a tag. Only a service line is matched by the service's name.
alter table package_balances add column covers text not null default 'service' check (covers in ('service', 'category', 'tag'));

-- A planned call goes with what prompted it. planned_calls has no foreign key
-- to its origin (one of three tables), so a visit, a front desk booking or a
-- CRM record deleted any way at all, a connection removed included, takes
-- its planned calls, with the names, numbers and treatments in them, along.
create function drop_planned_calls_of_origin() returns trigger language plpgsql as $$
begin
  delete from planned_calls p using gone g
  where p.tenant_id = g.tenant_id and p.origin_type = tg_argv[0] and p.origin_id = g.id;
  return null;
end $$;

create trigger visits_planned_calls after delete on visits
  referencing old table as gone for each statement execute function drop_planned_calls_of_origin('visit');
create trigger clinic_appointments_planned_calls after delete on clinic_appointments
  referencing old table as gone for each statement execute function drop_planned_calls_of_origin('clinic_appointment');
create trigger crm_records_planned_calls after delete on crm_records
  referencing old table as gone for each statement execute function drop_planned_calls_of_origin('crm_record');
