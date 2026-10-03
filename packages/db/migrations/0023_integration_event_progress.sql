-- 0023 What part of a write-back already landed (Zennara's Zoho, 2026-10-03).
--
-- One event can take more than one request on the client's side: Zoho logs the
-- call as a Call record, then updates the fields they mapped. When the second
-- request failed, the retry sent the whole event again and the same call was
-- logged twice. The connector now says what it has written (for Zoho, the id
-- of the Call or Note), it is kept here, and a retry carries on from there.

alter table integration_events add column if not exists progress jsonb not null default '{}'::jsonb;
