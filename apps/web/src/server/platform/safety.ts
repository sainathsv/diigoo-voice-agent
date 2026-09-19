import "server-only";
import { sql } from "drizzle-orm";
import { platformDb } from "@jenai/db";
import { GUARDRAILS_VERSION } from "@jenai/voice";
import { SUITE_VERSION } from "@jenai/engine";

// Console reads only (fleet-wide, BYPASSRLS). Callers have passed requirePlatform() first.

/** The latest check of every LIVE agent version: the fleet's current safety state. */
const LATEST_LIVE = sql`
  with live as (
    select a.tenant_id, a.id as agent_id, a.name as agent_name, v.id as version_id, v.number, v.prompt_hash, v.guardrails_version,
           o.name as org_name, o.slug as org_slug
    from agents a
    join agent_versions v on v.tenant_id = a.tenant_id and v.id = a.live_version_id
    join organizations o on o.id = a.tenant_id
  ),
  latest as (
    select distinct on (c.tenant_id, c.version_id) c.*
    from agent_safety_checks c
    join live l on l.tenant_id = c.tenant_id and l.version_id = c.version_id
    order by c.tenant_id, c.version_id, c.created_at desc
  )`;

export async function fleetSummary() {
  const [r] = await platformDb().execute<Record<string, number>>(sql`
    ${LATEST_LIVE}
    select
      (select count(*) from live)::int as live,
      (select count(*) from live l where not exists (select 1 from latest c where c.version_id = l.version_id))::int as unchecked,
      (select count(*) from latest where status = 'passed' and suite_version = ${SUITE_VERSION})::int as passed,
      (select count(*) from latest where status = 'passed' and suite_version < ${SUITE_VERSION})::int as passed_old_suite,
      (select count(*) from latest where status = 'failed')::int as failed,
      (select count(*) from latest where status = 'needs_review')::int as review,
      (select count(*) from latest where status in ('queued', 'running'))::int as in_progress,
      (select count(*) from live where guardrails_version = ${GUARDRAILS_VERSION})::int as guard_current,
      (select count(*) from live where guardrails_version is not null and guardrails_version < ${GUARDRAILS_VERSION})::int as guard_old,
      (select count(*) from live where guardrails_version is null)::int as guard_none`);
  return r!;
}

export async function failuresByCase() {
  return platformDb().execute<{ id: string; severity: string; agents: number }>(sql`
    ${LATEST_LIVE}
    select r->>'id' as id, max(r->>'severity') as severity, count(*)::int as agents
    from latest l, jsonb_array_elements(l.results) r
    where r->>'verdict' = 'failed'
    group by 1 order by 3 desc, 1 limit 30`);
}

export async function unsafeLiveAgents() {
  return platformDb().execute<{ tenant_id: string; org_name: string; org_slug: string; agent_id: string; agent_name: string; number: number; guardrails_version: number | null; critical_failed: number; failed_cases: string | null; finished_at: string }>(sql`
    ${LATEST_LIVE}
    select l.tenant_id, l.org_name, l.org_slug, l.agent_id, l.agent_name, l.number, l.guardrails_version, c.critical_failed,
           (select string_agg(r->>'id', ', ') from jsonb_array_elements(c.results) r where r->>'verdict' = 'failed') as failed_cases,
           c.finished_at
    from live l join latest c on c.version_id = l.version_id
    where c.status = 'failed'
    order by c.critical_failed desc, c.finished_at desc limit 100`);
}

export async function reviewQueue() {
  return platformDb().execute<{ tenant_id: string; id: string; org_name: string; agent_name: string; number: number; reason: string; results: unknown; finished_at: string }>(sql`
    select c.tenant_id, c.id, o.name as org_name, a.name as agent_name, v.number, c.reason::text, c.results, c.finished_at
    from agent_safety_checks c
    join organizations o on o.id = c.tenant_id
    join agents a on a.tenant_id = c.tenant_id and a.id = c.agent_id
    join agent_versions v on v.tenant_id = c.tenant_id and v.id = c.version_id
    where c.status = 'needs_review'
    order by c.finished_at limit 50`);
}

export async function queueHealth() {
  const [r] = await platformDb().execute<{ queued: number; running: number; oldest_minutes: number | null; done_24h: number; errors_24h: number; cached_24h: number }>(sql`
    select count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'running')::int as running,
           (extract(epoch from now() - min(created_at) filter (where status = 'queued')) / 60)::int as oldest_minutes,
           count(*) filter (where finished_at > now() - interval '24 hours' and status in ('passed', 'failed', 'needs_review') and cached_from is null)::int as done_24h,
           count(*) filter (where finished_at > now() - interval '24 hours' and status = 'error')::int as errors_24h,
           count(*) filter (where finished_at > now() - interval '24 hours' and cached_from is not null)::int as cached_24h
    from agent_safety_checks`);
  return r!;
}
