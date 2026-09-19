import { applyToDefinition, startPrompt, type Rendered } from "./render";
import { DograhError, type DograhClient, type DograhDefinition } from "./dograh";

export interface DirectionResult {
  direction: "inbound" | "outbound";
  workflowId: number;
  ok: boolean;
  publishedVersion?: number;
  verified?: boolean;
  rolledBack?: boolean;
  error?: string;
}
export interface PublishResult {
  ok: boolean;
  results: DirectionResult[];
}

/**
 * Publish one agent version to BOTH workflows as a single change.
 *
 * For each direction: ensure a draft exists, write the rendered prompt into
 * the draft, publish, then read the version history back and verify that the
 * published definition carries exactly our prompt. Inbound runs from the
 * PUBLISHED definition, so an unpublished edit is the drift bug this prevents.
 *
 * If the second direction fails, the first is rolled back to the definition
 * that was live before, so callers never get one version inbound and another
 * outbound.
 */
export async function publishBoth(
  client: DograhClient,
  target: { inboundWorkflowId: number | null; outboundWorkflowId: number | null },
  rendered: Rendered,
): Promise<PublishResult> {
  const plan: Array<{ direction: "inbound" | "outbound"; id: number }> = [];
  if (target.inboundWorkflowId) plan.push({ direction: "inbound", id: target.inboundWorkflowId });
  if (target.outboundWorkflowId) plan.push({ direction: "outbound", id: target.outboundWorkflowId });
  if (!plan.length) return { ok: false, results: [] };

  const done: Array<{ id: number; direction: "inbound" | "outbound"; before: DograhDefinition; name: string; tcv: Record<string, unknown> }> = [];
  const results: DirectionResult[] = [];

  for (const step of plan) {
    try {
      await client.createDraft(step.id);
      const wf = await client.getWorkflow(step.id);
      const before = (await livePublished(client, step.id)) ?? wf.workflow_definition;
      const def = applyToDefinition(wf.workflow_definition, rendered, step.direction);
      await client.putWorkflow({ id: wf.id, name: wf.name, workflow_definition: def, template_context_variables: wf.template_context_variables });
      await client.publish(step.id);
      const verify = await client.listVersions(step.id, 5);
      const pub = verify.find((v) => v.status === "published");
      const expected = step.direction === "inbound" ? rendered.inboundPrompt : rendered.outboundPrompt;
      const verified = !!pub && startPrompt(pub.workflow_json) === expected;
      if (!verified) throw new Error("Published definition does not match what was sent (verification failed).");
      done.push({ id: step.id, direction: step.direction, before, name: wf.name, tcv: wf.template_context_variables ?? {} });
      results.push({ direction: step.direction, workflowId: step.id, ok: true, publishedVersion: pub!.version_number, verified: true });
    } catch (e) {
      results.push({ direction: step.direction, workflowId: step.id, ok: false, error: e instanceof DograhError ? e.message : (e as Error).message });
      // Undo the directions that already went live.
      for (const d of done) {
        const r = results.find((x) => x.workflowId === d.id)!;
        try {
          await client.createDraft(d.id);
          await client.putWorkflow({ id: d.id, name: d.name, workflow_definition: d.before, template_context_variables: d.tcv });
          await client.publish(d.id);
          r.rolledBack = true;
          r.ok = false;
        } catch (re) {
          r.error = `Rollback failed: ${(re as Error).message}`;
        }
      }
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

async function livePublished(client: DograhClient, id: number): Promise<DograhDefinition | null> {
  const versions = await client.listVersions(id, 5);
  return versions.find((v) => v.status === "published")?.workflow_json ?? null;
}
