import { and, desc, eq, sql } from "drizzle-orm";
import { agentTemplates, agentVersions, agents, withTenant, type Agent, type AgentTemplate, type AgentVersion, type Tx } from "@jenai/db";
import { lintVersion, parseBuiltPrompt, promptHash, publishBoth, render, startPrompt, type DograhClient, type PublishResult } from "@jenai/voice";
import { voiceClient } from "./voice-conn";
import { requestSafetyCheck, safetyGate } from "./safety/checks";

export const DEFAULT_TEMPLATE = { key: "clinic_receptionist", version: 1 };

export async function templateOf(tx: Tx, a: Pick<Agent, "templateKey" | "templateVersion">): Promise<AgentTemplate> {
  const [t] = await tx.select().from(agentTemplates).where(and(eq(agentTemplates.key, a.templateKey), eq(agentTemplates.version, a.templateVersion)));
  if (!t) throw new Error(`Template ${a.templateKey} v${a.templateVersion} is missing`);
  return t;
}

async function publishedPrompt(client: DograhClient, workflowId: number | null): Promise<string> {
  if (!workflowId) return "";
  const versions = await client.listVersions(workflowId, 5);
  return startPrompt(versions.find((v) => v.status === "published")?.workflow_json);
}

export interface ImportInput {
  name: string;
  branchId: string | null;
  purpose: Agent["purpose"];
  domain: string;
  inboundWorkflowId: number | null;
  outboundWorkflowId: number | null;
}

/**
 * Bring a live Dograh agent under management without changing it: records
 * what callers hear today as version 1 ("imported"). Facts and greeting are
 * recovered when the prompt was built from the shared template.
 */
export async function importAgent(tenantId: string, input: ImportInput, actorUserId: string | null) {
  return withTenant(tenantId, async (tx) => {
    const v = await voiceClient(tx, tenantId);
    if (!v) throw new Error("Connect this client's voice engine first.");
    const tpl = await templateOf(tx, { templateKey: DEFAULT_TEMPLATE.key, templateVersion: DEFAULT_TEMPLATE.version });
    const [inPrompt, outPrompt, list] = await Promise.all([
      publishedPrompt(v.client, input.inboundWorkflowId),
      publishedPrompt(v.client, input.outboundWorkflowId),
      v.client.listWorkflows(),
    ]);
    const uuid = list.find((w) => w.id === input.outboundWorkflowId)?.workflow_uuid ?? null;
    const parsed = parseBuiltPrompt(inPrompt, tpl.basePrompt);
    const [agent] = await tx
      .insert(agents)
      .values({
        tenantId,
        branchId: input.branchId,
        name: input.name,
        purpose: input.purpose,
        templateKey: tpl.key,
        templateVersion: tpl.version,
        domain: input.domain,
        inboundWorkflowId: input.inboundWorkflowId,
        outboundWorkflowId: input.outboundWorkflowId,
        outboundWorkflowUuid: uuid,
      })
      .returning();
    const [ver] = await tx
      .insert(agentVersions)
      .values({
        tenantId,
        agentId: agent!.id,
        number: 1,
        state: "imported",
        greeting: parsed?.greeting ?? "",
        facts: parsed?.facts ?? inPrompt,
        inboundPrompt: inPrompt,
        outboundPrompt: outPrompt,
        promptHash: promptHash(inPrompt, outPrompt, tpl.endPrompt),
        changeNote: parsed
          ? "Imported from the live engine (built from the shared template)"
          : "Imported from the live engine (hand-written prompt; rebuild on the shared template before publishing)",
        createdBy: actorUserId,
      })
      .returning();
    await tx.update(agents).set({ liveVersionId: ver!.id }).where(eq(agents.id, agent!.id));
    return { agent: agent!, version: ver!, recognised: !!parsed, samePromptBothWays: inPrompt.slice(0, 200) === outPrompt.slice(0, 200) };
  });
}

export async function createVersion(
  tx: Tx,
  tenantId: string,
  agentId: string,
  input: { greeting: string; facts: string; outboundOpening?: string | null; personaName?: string | null; changeNote?: string | null },
  actorUserId: string | null,
): Promise<AgentVersion> {
  const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`coalesce(max(${agentVersions.number}), 0)::int` }).from(agentVersions).where(eq(agentVersions.agentId, agentId));
  const [v] = await tx
    .insert(agentVersions)
    .values({ tenantId, agentId, number: n + 1, state: "draft", greeting: input.greeting.trim(), facts: input.facts.trim(), outboundOpening: input.outboundOpening?.trim() || null, personaName: input.personaName?.trim() || null, changeNote: input.changeNote?.trim() || null, createdBy: actorUserId })
    .returning();
  return v!;
}

export class PublishBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishBlocked";
  }
}

/**
 * Publish a version to inbound AND outbound together (Blueprint Part 9).
 * Runs outside a long transaction: state goes draft -> publishing -> live|failed.
 * Refuses unless the client's voice connection is in managed mode, so nothing
 * reaches live callers until Diigoo switches that client over.
 */
export async function publishVersion(tenantId: string, versionId: string, actorUserId: string | null): Promise<{ version: AgentVersion; result: PublishResult }> {
  const prep = await withTenant(tenantId, async (tx) => {
    const [ver] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId)).for("update");
    if (!ver) throw new PublishBlocked("Version not found.");
    if (!["draft", "pending_approval", "failed", "superseded"].includes(ver.state)) throw new PublishBlocked(`This version is ${ver.state}; it cannot be published.`);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, ver.agentId));
    const issues = lintVersion(ver).filter((i) => i.level === "error");
    if (issues.length) throw new PublishBlocked(issues.map((i) => i.message).join(" "));
    const v = await voiceClient(tx, tenantId);
    if (!v) throw new PublishBlocked("This client has no voice engine connection.");
    if (v.conn.mode !== "managed") throw new PublishBlocked("Publishing to live calls is switched off for this client (read-only). Diigoo turns it on when the client moves to the new platform.");
    const tpl = await templateOf(tx, agent!);
    const r = render(tpl, ver, agent!.domain);
    // AI safety gate: these exact prompts must have passed the red-team suite.
    const gate = await safetyGate(tx, versionId, r.hash);
    if (!gate.ok) {
      if (!gate.check || gate.check.promptHash !== r.hash || gate.check.status === "error") {
        await requestSafetyCheck(tx, { tenantId, versionId, reason: "publish", requestedBy: actorUserId });
      }
      // Returned, not thrown: throwing here would roll back the check just queued.
      return { kind: "blocked" as const, message: gate.check ? gate.message : "Safety check started (about 2 minutes). Publish again when it has passed." };
    }
    await tx.update(agentVersions).set({ state: "publishing", inboundPrompt: r.inboundPrompt, outboundPrompt: r.outboundPrompt, promptHash: r.hash, guardrailsVersion: r.guardrailsVersion }).where(eq(agentVersions.id, versionId));
    return { kind: "ready" as const, agent: agent!, rendered: r, client: v.client };
  });
  if (prep.kind === "blocked") throw new PublishBlocked(prep.message);

  const result = await publishBoth(prep.client, { inboundWorkflowId: prep.agent.inboundWorkflowId, outboundWorkflowId: prep.agent.outboundWorkflowId }, prep.rendered);

  const version = await withTenant(tenantId, async (tx) => {
    if (result.ok) {
      if (prep.agent.liveVersionId && prep.agent.liveVersionId !== versionId) {
        await tx.update(agentVersions).set({ state: "superseded" }).where(eq(agentVersions.id, prep.agent.liveVersionId));
      }
      await tx.update(agents).set({ liveVersionId: versionId, updatedAt: new Date() }).where(eq(agents.id, prep.agent.id));
    }
    const [v] = await tx
      .update(agentVersions)
      .set({ state: result.ok ? "live" : "failed", publishedBy: actorUserId, publishedAt: result.ok ? new Date() : null, publishResult: result as never })
      .where(eq(agentVersions.id, versionId))
      .returning();
    return v!;
  });
  return { version, result };
}

export interface DriftReport {
  inSync: boolean;
  inboundMatches: boolean;
  outboundMatches: boolean;
  checkedAt: Date;
}

/** Compares what callers hear right now with the version JENAI believes is live. */
export async function checkDrift(tenantId: string, agentId: string): Promise<DriftReport> {
  return withTenant(tenantId, async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
    if (!agent?.liveVersionId) throw new Error("No live version recorded.");
    const [live] = await tx.select().from(agentVersions).where(eq(agentVersions.id, agent.liveVersionId));
    const v = await voiceClient(tx, tenantId);
    if (!v) throw new Error("No voice connection.");
    const [inb, outb] = await Promise.all([publishedPrompt(v.client, agent.inboundWorkflowId), publishedPrompt(v.client, agent.outboundWorkflowId)]);
    const inboundMatches = !agent.inboundWorkflowId || inb === live!.inboundPrompt;
    const outboundMatches = !agent.outboundWorkflowId || outb === live!.outboundPrompt;
    return { inSync: inboundMatches && outboundMatches, inboundMatches, outboundMatches, checkedAt: new Date() };
  });
}

export async function listAgentVersions(tx: Tx, agentId: string) {
  return tx.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.number));
}
