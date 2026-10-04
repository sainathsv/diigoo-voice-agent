-- 0032 The call plan reads the clinic's front desk bookings (Zennara, 2026-10-04).
--
-- A booking in the clinic's front desk system (clinic_appointments) now
-- prompts calls of its own: a reminder before it, and a call to rebook once
-- it was missed or cancelled. Those planned calls name the booking they came
-- from, so planned_calls takes it as an origin besides a CRM record and a
-- visit. Widening the check only: every row already stored still passes.

alter table planned_calls drop constraint planned_calls_origin_type_check;
alter table planned_calls add constraint planned_calls_origin_type_check
  check (origin_type in ('crm_record', 'visit', 'clinic_appointment'));
