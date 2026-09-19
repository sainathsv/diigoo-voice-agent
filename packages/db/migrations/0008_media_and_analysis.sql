-- 0008 Internal media address for the voice engine (transcripts and recordings are
-- only reachable inside the engine's network) and post-call analysis bookkeeping.
alter table voice_connections add column media_base_url text;
alter table calls add column analyzed_at timestamptz;
alter table calls add column analysis_model text;
create index calls_needs_analysis on calls(tenant_id, started_at) where analyzed_at is null and status = 'completed';
