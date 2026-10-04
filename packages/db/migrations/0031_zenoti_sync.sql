-- 0031 Reading Zenoti on a timer: what was last read for each guest (Zennara, 2026-10-04).
--
-- The sync meets a guest first on a booking or a sales line, which names them
-- but does not say whether they agreed to SMS, and on a sales line not even
-- their number. Their profile says both, and costs one call to Zenoti, so it
-- is read once and again after a while. fetched_at now means when their
-- profile was last read, and is empty until it is: a guest seen only on a
-- booking is read first.
--
-- Their packages are read at most once a week per guest, whether or not they
-- have any, so the week is kept on the guest rather than on a package row a
-- guest with no packages never gets.

alter table external_people alter column fetched_at drop not null;
alter table external_people alter column fetched_at drop default;
alter table external_people add column packages_fetched_at timestamptz;
