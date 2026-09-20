-- 0013 Call programs: ready-made calling jobs per industry.
--
-- One client runs several different jobs (a clinic: cold outreach, warm
-- follow-up, recalls, reminders, offers; a corporation: property tax, trade
-- licence renewal, policy notices, grievance follow-up). Each job has its own
-- script, its own per-person data, its own legal class (promotional calls
-- follow different rules from service calls), its own outcomes and its own
-- safety tests. JENAI owns the catalogue; a client switches one on and fills
-- in a few facts.

create table program_templates (
  key text not null,                    -- e.g. clinic.revisit_recall
  version int not null,
  vertical text not null,               -- health | government | general
  name text not null,                   -- what a client sees
  summary text not null,                -- one plain line
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  purpose consent_purpose not null,     -- drives the compliance gate (DND, caller ID series, consent)
  goal text not null,                   -- what a good call achieves
  task_prompt text not null,            -- the job, added under the client's facts
  opening text not null,                -- first words, may use {{variables}}
  variables jsonb not null default '[]'::jsonb,      -- per-person data the call needs
  client_fields jsonb not null default '[]'::jsonb,  -- facts the client fills once
  extraction jsonb not null default '[]'::jsonb,     -- what the analyser pulls from the call
  outcomes jsonb not null default '[]'::jsonb,       -- outcome -> lead stage
  defaults jsonb not null default '{}'::jsonb,       -- windows, attempts, caps
  requirements jsonb not null default '{}'::jsonb,   -- caller ID series, consent basis, records needed
  compliance_note text not null default '',
  redteam_cases jsonb not null default '[]'::jsonb,  -- extra adversarial callers for this job
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (key, version)
);
create index program_templates_vertical on program_templates(vertical, status);
grant select on program_templates to jenai_app, jenai_platform;
grant insert, update on program_templates to jenai_platform;

-- A client's copy of one program: their facts, their agent, their number.
create table client_programs (
  tenant_id uuid not null references organizations(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  branch_id uuid,
  program_key text not null,
  program_version int not null,
  name text not null,
  agent_id uuid,                        -- created when the program is set up
  caller_number_id uuid,
  values jsonb not null default '{}'::jsonb,   -- answers to client_fields
  status text not null default 'draft' check (status in ('draft', 'ready', 'paused')),
  created_by text references "user"(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (id),
  unique (tenant_id, program_key, branch_id),
  foreign key (program_key, program_version) references program_templates(key, version)
);
create index client_programs_tenant on client_programs(tenant_id, status);

alter table client_programs enable row level security;
alter table client_programs force row level security;
create policy client_programs_rw on client_programs using (tenant_id = app_tenant_id()) with check (tenant_id = app_tenant_id());
grant select, insert, update, delete on client_programs to jenai_app, jenai_platform;

-- Which program an agent, a version and a campaign belong to.
alter table agents add column client_program_id uuid;
alter table agent_versions add column task_prompt text;
alter table campaigns add column client_program_id uuid;
create index campaigns_program on campaigns(tenant_id, client_program_id);

-- A program brings its own adversarial callers to the AI safety check.
alter table agent_safety_checks add column extra_cases jsonb not null default '[]'::jsonb;
