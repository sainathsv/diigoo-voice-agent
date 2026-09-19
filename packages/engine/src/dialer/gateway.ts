import { randomUUID } from "node:crypto";
import type { DograhClient } from "@jenai/voice";
import type { Outcome } from "./policy";

export interface DialRequest {
  tenantId: string;
  targetId: string;
  phone: string;
  context: Record<string, unknown>;
  outboundWorkflowUuid: string | null;
  voiceConfigId: number | null;
  /** The dialer's clock (tests and simulations run on a fixed clock). */
  at?: Date;
}

export interface DialGateway {
  readonly name: "simulated" | "dograh";
  dial(req: DialRequest): Promise<{ externalRunId: string }>;
}

/**
 * Development and demo gateway: never touches a phone network. Each dial
 * resolves after a short delay to a realistic mix of outcomes, so the whole
 * campaign flow (retries, caps, windows) can be exercised safely.
 */
export class SimulatedGateway implements DialGateway {
  readonly name = "simulated" as const;
  private pending = new Map<string, { resolveAt: number; outcome: Outcome; durationS: number }>();

  constructor(private readonly delayMs = 4_000, private readonly pick: () => Outcome = defaultPick) {}

  async dial(req: DialRequest) {
    const id = `sim-${randomUUID()}`;
    const outcome = this.pick();
    this.pending.set(id, { resolveAt: (req.at?.getTime() ?? Date.now()) + this.delayMs, outcome, durationS: outcome === "answered" ? 60 + Math.floor(Math.random() * 120) : 0 });
    return { externalRunId: id };
  }

  /** Outcomes whose simulated call has "ended". */
  poll(now = Date.now()): Array<{ externalRunId: string; outcome: Outcome; durationS: number }> {
    const out: Array<{ externalRunId: string; outcome: Outcome; durationS: number }> = [];
    for (const [id, p] of this.pending) {
      if (p.resolveAt <= now) {
        out.push({ externalRunId: id, outcome: p.outcome, durationS: p.durationS });
        this.pending.delete(id);
      }
    }
    return out;
  }
}

function defaultPick(): Outcome {
  const r = Math.random();
  if (r < 0.45) return "answered";
  if (r < 0.75) return "no_answer";
  if (r < 0.85) return "busy";
  if (r < 0.93) return "unreachable";
  return "callback";
}

/** Real calls through the voice engine's public agent API (published version, per-call context). */
export class DograhGateway implements DialGateway {
  readonly name = "dograh" as const;
  constructor(private readonly client: DograhClient) {}
  async dial(req: DialRequest) {
    if (!req.outboundWorkflowUuid) throw new Error("The agent has no outbound workflow UUID; re-import it.");
    const r = await this.client.triggerCall(req.outboundWorkflowUuid, { phone: req.phone, context: req.context, telephonyConfigId: req.voiceConfigId });
    return { externalRunId: String(r.workflow_run_id) };
  }
}
