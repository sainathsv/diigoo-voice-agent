-- 0026 A contact can come from a clinic's visit list (Zennara, 2026-10-04).
--
-- A clinic uploads the services people actually took, exported from its front
-- desk or billing software. Everyone on that list becomes a contact, so their
-- visits, calls and plan stay joined up, and the contact says where it came
-- from. Only a new allowed value: every existing row already passes.

alter table contacts drop constraint contacts_source_check;
alter table contacts add constraint contacts_source_check
  check (source in ('call', 'import', 'form', 'manual', 'campaign', 'api', 'visit_list'));
