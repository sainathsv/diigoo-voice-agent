-- 0024 Which kind of record a write-back is about (Zennara's Zoho, 2026-10-03).
--
-- A caller can be a Lead or a Contact in Zoho, and the Call, the Note and the
-- field update each have to name the right one. The event already keeps the
-- record's id once it is known (from external_links, or found by a try that
-- then failed). It now keeps the record's kind beside it, so the next try, and
-- the next event for the same person, write to the module the record is in.
-- Empty on older rows: those go to the module set on the connection, as before.

alter table integration_events add column if not exists external_type text;
