-- 0019 Cases and WhatsApp through OpenWA (CY Police, 2026-10-02).
--
-- The call takes the scam down while it is fresh. WhatsApp then collects the
-- rest from the complainant at their own pace: their name, father's or
-- husband's name, who did it, where it happened, and the proof (screenshots,
-- UTR slips, chats). A case is "ready" for officers only when every required
-- item is in; until then the complainant is reminded.
--
-- WhatsApp runs through OpenWA on the client's own server (a linked WhatsApp
-- number, like WhatsApp Web), not Meta's cloud API: the police do not want
-- complaints decrypted on Meta's servers. Messages are queued in
-- whatsapp_inbox as they arrive and read by the worker, so a slow local model
-- never holds up the webhook.

create type case_status as enum ('collecting', 'ready', 'taken_up', 'closed');

create table cases (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  seq integer not null,                          -- per workspace, shown as CY-2026-000123
  branch_id uuid,
  status case_status not null default 'collecting',
  complainant_e164 text not null,
  contact_id uuid,
  first_call_id uuid,
  scam_type text,                                -- a key from the scam catalogue
  fields jsonb not null default '{}'::jsonb,     -- everything gathered, by field key
  missing text[] not null default '{}',          -- required field keys still to collect
  language text,                                 -- hi, en, ne, or another the complainant used
  amount_lost_paise bigint,
  district text,
  asking text,                                   -- the field the last WhatsApp question asked for
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  reminders_sent integer not null default 0,
  ready_at timestamptz,
  assigned_membership_id uuid,
  officer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, seq)
);
create index cases_tenant_status on cases(tenant_id, status, updated_at desc);
create index cases_tenant_phone on cases(tenant_id, complainant_e164);

-- Proof the complainant sent: kept in the database with the case so it is
-- backed up, access-checked and deleted with it.
create table case_evidence (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  case_id uuid not null,
  kind text not null check (kind in ('image', 'document', 'audio', 'video', 'text')),
  mime text not null,
  filename text,
  caption text,
  bytes bytea,
  size_bytes integer not null default 0,
  sha256 text,
  source text not null default 'whatsapp',
  external_id text,                              -- the WhatsApp message id
  received_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, external_id),
  foreign key (tenant_id, case_id) references cases(tenant_id, id) on delete cascade
);
create index case_evidence_case on case_evidence(tenant_id, case_id);

-- The WhatsApp thread of a case, both ways.
create table case_messages (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  case_id uuid not null,
  direction text not null check (direction in ('in', 'out')),
  channel text not null default 'whatsapp',
  body text,
  evidence_id uuid,
  external_id text,
  status text not null default 'sent',          -- out: sent, delivered, read, failed, simulated
  error text,
  at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, external_id),
  foreign key (tenant_id, case_id) references cases(tenant_id, id) on delete cascade
);
create index case_messages_case on case_messages(tenant_id, case_id, at);

-- One WhatsApp number per workspace. "simulated" writes messages into the case
-- without sending (tests, and before a number is linked); "openwa" sends through
-- the OpenWA gateway on this server.
create table whatsapp_channels (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  mode text not null default 'simulated' check (mode in ('simulated', 'openwa')),
  display_e164 text,                             -- the linked number, as WhatsApp reports it
  openwa_url text,                               -- e.g. http://127.0.0.1:2785
  openwa_session text,                           -- the OpenWA session id
  credentials text,                              -- sealed: { apiKey, webhookSecret }
  link_status text,                              -- as OpenWA last reported it: qr_ready, ready, disconnected...
  form_url text,                                 -- the cyber team's form, sent for complaints without money lost
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id),
  unique (openwa_session)
);

-- Inbound WhatsApp messages as they arrive, read by the worker in order.
create table whatsapp_inbox (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  external_id text not null,                     -- the WhatsApp message id (deduplicates retries)
  message jsonb not null,                        -- the message, already parsed
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  primary key (tenant_id, id),
  unique (tenant_id, external_id)
);
create index whatsapp_inbox_pending on whatsapp_inbox(tenant_id, received_at) where processed_at is null;

do $$
declare t text;
begin
  foreach t in array array['cases', 'case_evidence', 'case_messages', 'whatsapp_channels', 'whatsapp_inbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id())', t);
    execute format('grant select, insert, update, delete on %I to jenai_app, jenai_platform', t);
  end loop;
end $$;
