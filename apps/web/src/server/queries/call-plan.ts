import "server-only";
import { branchesFor, type AccessContext } from "@jenai/authz";
import { PLAN_VIEW_PAGE, dbErrorCode, planView, replanTenant, type PlanView, type PlanViewRow, type PlanViewSource } from "@jenai/engine";

export const CALL_PLAN_PAGE = PLAN_VIEW_PAGE;
export type CallPlanView = PlanView & {
  /** The plan is older than an hour and could not be worked out again just now: times may have moved on. */
  stale: boolean;
  /** This server's worker reads CRMs on a timer (JENAI_PULL). Web and worker share one environment file. */
  readingOnTimer: boolean;
};
export type CallPlanRow = PlanViewRow;
export type CallPlanSource = PlanViewSource;

/** A plan older than this is worked out again before it is shown. */
const STALE_MS = 60 * 60_000;

/**
 * The call plan page's data, limited to the branches where the viewer may see
 * leads and contacts. Filters come from the URL; planView drops unknown values.
 * A plan over an hour old (no worker refreshed it) is worked out again first,
 * so the page never shows yesterday's "call now" as today's.
 */
export async function loadCallPlan(tenantId: string, access: AccessContext, f: { journey?: string; verdict?: string; page?: number }): Promise<CallPlanView> {
  const opts = { ...f, branchIds: branchesFor(access, "contacts:view") };
  let view = await planView(tenantId, opts);
  let stale = !!view.computedAt && Date.now() - view.computedAt.getTime() > STALE_MS;
  if (stale) {
    try {
      // Advisory-locked per client, so a worker refreshing it at the same moment is waited for, not doubled.
      await replanTenant(tenantId);
      view = await planView(tenantId, opts);
      stale = false;
    } catch (e) {
      console.error(JSON.stringify({ event: "call_plan.stale_replan_failed", code: dbErrorCode(e) }));
    }
  }
  return { ...view, stale, readingOnTimer: process.env.JENAI_PULL === "true" };
}
