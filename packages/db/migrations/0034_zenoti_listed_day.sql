-- 0034 The day a front desk system lists a visit under (review of the Zenoti read, 2026-10-04).
--
-- A sales report lists a line by the day it was sold, which can be a day
-- after the service it is for. Re-reading a span of days removes the lines
-- the report no longer lists there (a voided or reopened invoice) only when
-- both days fall in the span, so a line listed under the day after is never
-- taken for one that was dropped.
alter table visits add column listed_on date;
