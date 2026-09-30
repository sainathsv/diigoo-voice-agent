import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentVersions,
  agents,
  campaigns,
  clientPrograms,
  organizations,
  programTemplates,
  withTenant,
  type ClientProgram,
  type ProgramTemplate,
  type ProgramVariable,
  type Tx,
} from "@jenai/db";
import { CYBER_INTAKE_DOMAIN, lintVersion } from "@jenai/voice";
import { createVersion, templateOf, DEFAULT_TEMPLATE } from "./agents";
import { verticalOf } from "./safety/cases";

/**
 * Call programs: the ready-made jobs a client can switch on (recall patients,
 * chase property tax, remind about an appointment). JENAI owns the catalogue;
 * a client fills in a few facts and gets an agent, a script, the right legal
 * class, calling hours, outcomes and its own safety cases.
 *
 * One client runs many programs side by side, each with its own agent so each
 * can be versioned, checked and published on its own.
 */

/** CY Police's private complaint line; the only program whose agents may record complaint evidence. */
export const CY_POLICE_PROGRAM = "police.cy_cybercrime_complaint";

/** Programs on offer to one client: their industry's pack, the general one, and any written only for them. */
export async function catalogueFor(tx: Tx, tenantId: string): Promise<ProgramTemplate[]> {
  const [org] = await tx.select({ vertical: organizations.vertical, slug: organizations.slug }).from(organizations).where(eq(organizations.id, tenantId));
  const v = verticalOf(org?.vertical);
  return tx
    .select()
    .from(programTemplates)
    .where(
      and(
        eq(programTemplates.status, "active"),
        or(
          and(isNull(programTemplates.tenantSlugs), inArray(programTemplates.vertical, v === "general" ? ["general"] : [v, "general"])),
          sql`${org?.slug ?? ""} = any(${programTemplates.tenantSlugs})`,
        ),
      ),
    )
    .orderBy(asc(programTemplates.vertical), asc(programTemplates.name));
}

/** A private program may only be set up by the workspaces it was written for. */
async function assertOfferedTo(tx: Tx, tenantId: string, p: ProgramTemplate): Promise<void> {
  if (!p.tenantSlugs) return;
  const [org] = await tx.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, tenantId));
  if (!org || !p.tenantSlugs.includes(org.slug)) throw new ProgramSetupError(`Program ${p.key} is not in the catalogue.`);
}

export async function programTemplateOf(tx: Tx, key: string, version: number): Promise<ProgramTemplate> {
  const [p] = await tx.select().from(programTemplates).where(and(eq(programTemplates.key, key), eq(programTemplates.version, version)));
  if (!p) throw new Error(`Program ${key} v${version} is not in the catalogue.`);
  return p;
}

export async function latestProgramVersion(tx: Tx, key: string): Promise<ProgramTemplate> {
  const [p] = await tx.select().from(programTemplates).where(eq(programTemplates.key, key)).orderBy(desc(programTemplates.version)).limit(1);
  if (!p) throw new Error(`Program ${key} is not in the catalogue.`);
  return p;
}

export class ProgramSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramSetupError";
  }
}

/** Fills {{fields}} in a program's wording with the client's answers. */
export function fillFields(text: string, values: Record<string, string>, variables: readonly ProgramVariable[]): string {
  const varNames = new Set(variables.map((v) => v.name));
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (varNames.has(key) || key === "caller_name" || key === "call_purpose") return whole; // filled per call
    return values[key] ?? whole;
  });
}

function missingFields(p: ProgramTemplate, values: Record<string, string>): string[] {
  return p.clientFields.filter((f) => f.required && !String(values[f.name] ?? "").trim()).map((f) => f.label);
}

/** The business facts this client's agents already use, so a program starts from what they wrote once. */
async function businessFacts(tx: Tx, tenantId: string, branchId: string | null): Promise<string> {
  const rows = await tx
    .select({ facts: agentVersions.facts, branch: agents.branchId, live: agents.liveVersionId, id: agentVersions.id })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(and(eq(agentVersions.tenantId, tenantId), isNull(agents.clientProgramId)))
    .orderBy(desc(agentVersions.createdAt))
    .limit(50);
  // Closest first: this branch's live agent, then the whole-workspace one, then anything written.
  const rank = (r: (typeof rows)[number]) =>
    (r.branch === branchId ? 0 : r.branch === null ? 1 : 2) * 2 + (r.live === r.id ? 0 : 1);
  const best = [...rows].sort((a, b) => rank(a) - rank(b))[0];
  return best?.facts?.trim() ?? "";
}

export interface SetUpInput {
  programKey: string;
  branchId?: string | null;
  name?: string;
  values: Record<string, string>;
  callerNumberId?: string | null;
  facts?: string;
}

/**
 * Switch a program on for a client: records their answers and drafts the agent
 * that will make these calls. The draft still goes through the normal path
 * (lint, AI safety check, approval, publish) before any caller hears it.
 */
export async function setUpProgram(tenantId: string, input: SetUpInput, actorUserId: string | null): Promise<{ program: ClientProgram; versionId: string; issues: string[] }> {
  return withTenant(tenantId, async (tx) => {
    const p = await latestProgramVersion(tx, input.programKey);
    await assertOfferedTo(tx, tenantId, p);
    const branchId = input.branchId ?? null;
    const missing = missingFields(p, input.values);
    if (missing.length) throw new ProgramSetupError(`Fill in: ${missing.join(", ")}.`);

    const [existing] = await tx
      .select()
      .from(clientPrograms)
      .where(and(eq(clientPrograms.programKey, p.key), branchId ? eq(clientPrograms.branchId, branchId) : isNull(clientPrograms.branchId)));

    const facts = (input.facts ?? (await businessFacts(tx, tenantId, branchId))).trim();
    if (facts.length < 80) {
      throw new ProgramSetupError("Add your business facts first (services, timings, address, what the agent may and may not say). The receptionist agent's facts are reused here.");
    }
    const values = Object.fromEntries(Object.entries(input.values).map(([k, v]) => [k, String(v).trim()]));
    const opening = fillFields(p.opening, values, p.variables);
    const taskPrompt = fillFields(p.taskPrompt, values, p.variables);
    const name = input.name?.trim() || p.name;

    const program =
      existing ??
      (
        await tx
          .insert(clientPrograms)
          .values({ tenantId, branchId, programKey: p.key, programVersion: p.version, name, values, callerNumberId: input.callerNumberId ?? null, createdBy: actorUserId })
          .returning()
      )[0]!;
    if (existing) {
      await tx
        .update(clientPrograms)
        .set({ programVersion: p.version, name, values, callerNumberId: input.callerNumberId ?? existing.callerNumberId, updatedAt: new Date() })
        .where(eq(clientPrograms.id, existing.id));
    }

    let agentId = program.agentId;
    if (!agentId) {
      const [agent] = await tx
        .insert(agents)
        .values({
          tenantId,
          branchId,
          name,
          purpose: p.purpose === "promotional" ? "outbound_sales" : p.direction === "inbound" ? "receptionist" : "reminders",
          templateKey: DEFAULT_TEMPLATE.key,
          templateVersion: DEFAULT_TEMPLATE.version,
          domain: p.key === CY_POLICE_PROGRAM ? CYBER_INTAKE_DOMAIN : p.vertical === "health" ? "clinic" : p.vertical === "government" ? "civic" : "business",
          clientProgramId: program.id,
        })
        .returning();
      agentId = agent!.id;
      await tx.update(clientPrograms).set({ agentId, updatedAt: new Date() }).where(eq(clientPrograms.id, program.id));
    }

    // The greeting is what an inbound caller would hear; outbound calls use the opening.
    const greeting = p.direction === "inbound" ? opening : `${values.clinic_name ?? values.office_name ?? values.business_name ?? name}. I am the AI assistant. How can I help you?`;
    const version = await createVersion(
      tx,
      tenantId,
      agentId,
      { greeting, facts, outboundOpening: opening, changeNote: `Set up from the ${p.name} program (v${p.version})` },
      actorUserId,
    );
    await tx.update(agentVersions).set({ taskPrompt }).where(eq(agentVersions.id, version.id));

    const issues = lintVersion({ greeting, facts, outboundOpening: opening, taskPrompt }, p.variables.map((v) => v.name))
      .filter((i) => i.level === "error")
      .map((i) => i.message);
    const [fresh] = await tx.select().from(clientPrograms).where(eq(clientPrograms.id, program.id));
    return { program: fresh!, versionId: version.id, issues };
  });
}

/** Required per-person data that a target row is missing (checked at import, not at dial time). */
export function missingVariables(p: Pick<ProgramTemplate, "variables">, context: Record<string, unknown>, name?: string | null): string[] {
  return p.variables
    .filter((v) => v.required && v.name !== "caller_name" && !String(context[v.name] ?? "").trim())
    .map((v) => v.label)
    .concat(p.variables.some((v) => v.required && v.name === "caller_name") && !String(name ?? "").trim() ? ["Name"] : []);
}

export interface CampaignFromProgram {
  clientProgramId: string;
  name?: string;
  callerNumberId?: string | null;
  branchId?: string | null;
  createdBy: string | null;
}

/**
 * A campaign that inherits the program's legal class, calling hours, attempts
 * and caps. The compliance gate then enforces the rest per call (DND, caller
 * ID series, consent).
 */
export async function campaignFromProgram(tx: Tx, tenantId: string, input: CampaignFromProgram) {
  const [cp] = await tx.select().from(clientPrograms).where(eq(clientPrograms.id, input.clientProgramId));
  if (!cp) throw new ProgramSetupError("That program is not set up for this workspace.");
  if (!cp.agentId) throw new ProgramSetupError("This program has no agent yet.");
  const p = await programTemplateOf(tx, cp.programKey, cp.programVersion);
  const numberId = input.callerNumberId ?? cp.callerNumberId;
  if (!numberId) throw new ProgramSetupError("Choose the number these calls should come from.");
  const d = p.defaults;
  const [c] = await tx
    .insert(campaigns)
    .values({
      tenantId,
      branchId: input.branchId ?? cp.branchId,
      agentId: cp.agentId,
      clientProgramId: cp.id,
      callerNumberId: numberId,
      name: input.name?.trim() || `${cp.name} ${new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`,
      purpose: p.purpose,
      callPurposeText: p.goal.slice(0, 120),
      windows: d.windows ?? { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "19:00" },
      maxAttempts: d.maxAttempts ?? 3,
      dailyCapPerContact: d.dailyCapPerContact ?? 1,
      maxConcurrency: d.maxConcurrency ?? 2,
      createdBy: input.createdBy,
    })
    .returning();
  return { campaign: c!, program: p };
}

/** What the analyser should pull out of a call made by this program. */
export async function programExtraction(tx: Tx, tenantId: string, agentId: string) {
  const [row] = await tx
    .select({ extraction: programTemplates.extraction, outcomes: programTemplates.outcomes, key: programTemplates.key })
    .from(agents)
    .innerJoin(clientPrograms, eq(clientPrograms.id, agents.clientProgramId))
    .innerJoin(programTemplates, and(eq(programTemplates.key, clientPrograms.programKey), eq(programTemplates.version, clientPrograms.programVersion)))
    .where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)));
  return row ?? null;
}

/** Placeholder names a program fills per call, for the publish lint. */
export async function programVariables(tx: Tx, tenantId: string, clientProgramId: string | null): Promise<string[]> {
  if (!clientProgramId) return [];
  const [row] = await tx
    .select({ variables: programTemplates.variables })
    .from(clientPrograms)
    .innerJoin(programTemplates, and(eq(programTemplates.key, clientPrograms.programKey), eq(programTemplates.version, clientPrograms.programVersion)))
    .where(and(eq(clientPrograms.tenantId, tenantId), eq(clientPrograms.id, clientProgramId)));
  return (row?.variables ?? []).map((v) => v.name);
}
