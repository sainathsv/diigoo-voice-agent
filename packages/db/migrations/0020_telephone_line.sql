-- 0020 The government telephone line, as this server sees it (2026-10-02).
--
-- One row per server, written by the worker every minute: the cable on its own
-- Ethernet port, the network address there, the telecom team's SIP system, our
-- telephone gateway and the automatic AI test call. The portal's home page shows
-- it with what to do. It describes this server's network, not any client's data.

create table telephone_line_status (
  id text primary key default 'line' check (id = 'line'),
  status jsonb not null,
  checked_at timestamptz not null default now()
);
grant select on telephone_line_status to jenai_app;
grant select, insert, update, delete on telephone_line_status to jenai_platform;
