import "server-only";
import { branchesFor, type AccessContext } from "@jenai/authz";
import { PLAN_VIEW_PAGE, planView, type PlanView, type PlanViewRow, type PlanViewSource } from "@jenai/engine";

export const CALL_PLAN_PAGE = PLAN_VIEW_PAGE;
export type CallPlanView = PlanView;
export type CallPlanRow = PlanViewRow;
export type CallPlanSource = PlanViewSource;

/**
 * The call plan page's data, limited to the branches where the viewer may see
 * leads and contacts. Filters come from the URL; planView drops unknown values.
 */
export async function loadCallPlan(tenantId: string, access: AccessContext, f: { journey?: string; verdict?: string; page?: number }): Promise<CallPlanView> {
  return planView(tenantId, { ...f, branchIds: branchesFor(access, "contacts:view") });
}
