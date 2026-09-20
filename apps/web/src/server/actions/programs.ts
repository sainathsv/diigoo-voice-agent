"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, withTenant } from "@jenai/db";
import { ProgramSetupError, campaignFromProgram, setUpProgram } from "@jenai/engine";
import { actorFields, requireWorkspace, workspaceAction } from "../access";
import { requestMeta } from "../session";

const go = (slug: string, path: string, msg: { ok?: string; error?: string }): never => {
  const q = new URLSearchParams(msg.error ? { error: msg.error } : { ok: msg.ok ?? "Saved" });
  redirect(`/w/${slug}/${path}${path.includes("?") ? "&" : "?"}${q}`);
};

async function meta(ctx: Awaited<ReturnType<typeof requireWorkspace>>) {
  return { ...actorFields(ctx), tenantId: ctx.org.id, ...(await requestMeta()) };
}

/** Switch a program on: JENAI drafts the agent, the script and the rules from the client's answers. */
export async function startProgram(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "agents:edit");
  const programKey = String(fd.get("programKey") ?? "");
  const branchId = (fd.get("branchId") as string) || null;
  const values: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("f_") && typeof v === "string") values[k.slice(2)] = v;
  try {
    const r = await setUpProgram(ctx.org.id, { programKey, branchId, values, callerNumberId: (fd.get("callerNumberId") as string) || null }, ctx.user.userId);
    await withTenant(ctx.org.id, async (tx) =>
      audit(tx, { ...(await meta(ctx)), action: "program.started", targetType: "client_program", targetId: r.program.id, summary: `Set up the ${r.program.name} calling program`, diff: { programKey, branchId } }),
    );
    if (r.issues.length) go(slug, `agents/${r.program.agentId}?v=${r.versionId}`, { error: `Draft ready, but fix this before it can go live: ${r.issues.join(" ")}` });
    go(slug, `agents/${r.program.agentId}?v=${r.versionId}`, { ok: "Program set up. Check the script below, then send it for approval." });
  } catch (e) {
    if (e instanceof ProgramSetupError) go(slug, "programs", { error: e.message });
    throw e;
  }
}

/** Start a calling round for a program: the campaign inherits its rules. */
export async function startProgramCampaign(fd: FormData) {
  const slug = String(fd.get("slug"));
  const ctx = await workspaceAction(slug, "campaigns:create");
  const p = z.object({ clientProgramId: z.uuid(), name: z.string().trim().max(80).optional(), callerNumberId: z.union([z.uuid(), z.literal("")]).optional() }).safeParse(Object.fromEntries(fd));
  if (!p.success) go(slug, "programs", { error: "Choose the program and the number to call from." });
  try {
    const { campaign } = await withTenant(ctx.org.id, async (tx) => {
      const r = await campaignFromProgram(tx, ctx.org.id, { clientProgramId: p.data!.clientProgramId, name: p.data!.name, callerNumberId: p.data!.callerNumberId || null, createdBy: ctx.user.userId });
      await audit(tx, { ...(await meta(ctx)), action: "campaign.created", targetType: "campaign", targetId: r.campaign.id, summary: `Created ${r.campaign.name} from the ${r.program.name} program` });
      return r;
    });
    go(slug, `campaigns/${campaign.id}`, { ok: "Calling round created. Add who to call, then send it for approval." });
  } catch (e) {
    if (e instanceof ProgramSetupError) go(slug, "programs", { error: e.message });
    throw e;
  }
}
