/**
 * In-memory Dograh for tests. Reproduces the semantics that matter:
 * - PUT writes the DRAFT; inbound calls run the PUBLISHED definition;
 * - publish fails with 400 when there is no draft;
 * - create-draft fails with 400 when a draft already exists;
 * - version history lists published and archived versions.
 * Never talks to the real Dograh.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DograhDefinition, DograhRun } from "../dograh";

interface Wf {
  id: number;
  name: string;
  uuid: string;
  published: DograhDefinition;
  draft: DograhDefinition | null;
  tcv: Record<string, unknown>;
  versions: Array<{ id: number; version_number: number; status: string; created_at: string; published_at: string | null; workflow_json: DograhDefinition }>;
}

export interface FakeDograh {
  url: string;
  workflows: Map<number, Wf>;
  runs: Map<number, DograhRun[]>;
  failPublish: Set<number>;
  /** Workflows whose run listing fails (500), like an archived or broken agent. */
  failRuns: Set<number>;
  /** When true, transcript and recording downloads are refused (403), like a locked media store. */
  refuseArtifacts: boolean;
  triggered: Array<{ uuid: string; body: unknown }>;
  requests: string[];
  /** What a caller dialling in hears: the published start prompt. */
  inboundHears(id: number): string;
  close(): Promise<void>;
}

export const baseDefinition = (prompt: string): DograhDefinition => ({
  nodes: [
    { id: "1", type: "startCall", data: { prompt, greeting: "" } },
    { id: "2", type: "endCall", data: { prompt: "bye" } },
  ],
  edges: [{ source: "1", target: "2" }],
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : null;
}

export async function startFakeDograh(opts: { apiKey?: string; email?: string; password?: string } = {}): Promise<FakeDograh> {
  const apiKey = opts.apiKey ?? "test-key";
  const workflows = new Map<number, Wf>();
  const runs = new Map<number, DograhRun[]>();
  const failPublish = new Set<number>();
  const failRuns = new Set<number>();
  const state = { refuseArtifacts: false };
  const triggered: FakeDograh["triggered"] = [];
  const requests: string[] = [];
  let versionSeq = 100;
  let runSeq = 5000;

  const server: Server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname.replace(/^\/api\/v1/, "");
    let m0: RegExpMatchArray | null;
    requests.push(`${req.method} ${p}`);
    try {
      if (req.method === "GET" && (m0 = p.match(/^\/public\/download\/workflow\/([^/]+)\/(transcript|recording)$/))) {
        if (state.refuseArtifacts) return send(403, { detail: "forbidden" });
        res.writeHead(200, { "Content-Type": m0[2] === "transcript" ? "text/plain" : "audio/wav" });
        return res.end(m0[2] === "transcript" ? `transcript for ${m0[1]}` : "RIFF");
      }
      if (req.method === "POST" && p === "/auth/login") {
        const b = (await body(req)) as { email: string; password: string };
        return b.email === opts.email && b.password === opts.password ? send(200, { token: "session-token" }) : send(401, { detail: "bad credentials" });
      }
      const authed = req.headers["x-api-key"] === apiKey || req.headers.authorization === "Bearer session-token";
      if (!authed) return send(401, { detail: "unauthorized" });

      let m: RegExpMatchArray | null;
      if (req.method === "GET" && p === "/organizations/context") return send(200, { organization_id: 1 });
      if (req.method === "GET" && p === "/workflow/fetch")
        return send(200, [...workflows.values()].map((w) => ({ id: w.id, name: w.name, status: "active", workflow_uuid: w.uuid })));
      if (req.method === "GET" && (m = p.match(/^\/workflow\/fetch\/(\d+)$/))) {
        const w = workflows.get(Number(m[1]));
        if (!w) return send(404, { detail: "not found" });
        return send(200, { id: w.id, name: w.name, workflow_uuid: w.uuid, workflow_definition: clone(w.draft ?? w.published), template_context_variables: w.tcv, version_status: w.draft ? "draft" : "published" });
      }
      if (req.method === "POST" && (m = p.match(/^\/workflow\/(\d+)\/create-draft$/))) {
        const w = workflows.get(Number(m[1]))!;
        if (w.draft) return send(400, { detail: "Draft already exists" });
        w.draft = clone(w.published);
        return send(200, { ok: true });
      }
      if (req.method === "PUT" && (m = p.match(/^\/workflow\/(\d+)$/))) {
        const w = workflows.get(Number(m[1]))!;
        const b = (await body(req)) as { workflow_definition: DograhDefinition; template_context_variables?: Record<string, unknown> };
        w.draft = clone(b.workflow_definition);
        w.tcv = b.template_context_variables ?? w.tcv;
        return send(200, { ok: true });
      }
      if (req.method === "POST" && (m = p.match(/^\/workflow\/(\d+)\/publish$/))) {
        const w = workflows.get(Number(m[1]))!;
        if (failPublish.has(w.id)) return send(500, { detail: "simulated publish failure" });
        if (!w.draft) return send(400, { detail: "No draft to publish" });
        for (const v of w.versions) if (v.status === "published") v.status = "archived";
        w.published = w.draft;
        w.draft = null;
        w.versions.unshift({ id: ++versionSeq, version_number: w.versions.length + 1, status: "published", created_at: new Date().toISOString(), published_at: new Date().toISOString(), workflow_json: clone(w.published) });
        return send(200, { ok: true });
      }
      if (req.method === "GET" && (m = p.match(/^\/workflow\/(\d+)\/versions$/))) {
        const w = workflows.get(Number(m[1]))!;
        return send(200, w.versions.slice(0, Number(url.searchParams.get("limit") ?? 50)));
      }
      if (req.method === "GET" && (m = p.match(/^\/workflow\/(\d+)\/runs$/))) {
        if (failRuns.has(Number(m[1]))) return send(500, { detail: "workflow unavailable" });
        const all = runs.get(Number(m[1])) ?? [];
        const page = Number(url.searchParams.get("page") ?? 1);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const sorted = [...all].sort((a, b) => b.id - a.id);
        return send(200, { runs: sorted.slice((page - 1) * limit, page * limit), total_count: all.length, page, limit, total_pages: Math.ceil(all.length / limit) });
      }
      if (req.method === "GET" && (m = p.match(/^\/workflow\/(\d+)\/runs\/(\d+)$/))) {
        const r = (runs.get(Number(m[1])) ?? []).find((x) => x.id === Number(m![2]));
        return r ? send(200, r) : send(404, { detail: "not found" });
      }
      if (req.method === "GET" && p === "/organizations/telephony-configs")
        return send(200, { configurations: [{ id: 3, name: "Vobiz", provider: "vobiz", is_default_outbound: true, phone_number_count: 1 }] });
      if (req.method === "GET" && (m = p.match(/^\/organizations\/telephony-configs\/(\d+)\/phone-numbers$/)))
        return send(200, { phone_numbers: [{ id: 6, telephony_configuration_id: 3, address: "+914012345678", address_normalized: "914012345678", address_type: "pstn", label: "Main", inbound_workflow_id: 2, is_active: true, is_default_caller_id: true }] });
      if (req.method === "POST" && (m = p.match(/^\/public\/agent\/workflow\/([^/]+)$/))) {
        if (req.headers["x-api-key"] !== apiKey) return send(401, { detail: "api key required" });
        const b = await body(req);
        triggered.push({ uuid: decodeURIComponent(m[1]!), body: b });
        return send(200, { status: "queued", workflow_run_id: ++runSeq, workflow_run_name: `run-${runSeq}` });
      }
      return send(404, { detail: `no route ${req.method} ${p}` });
    } catch (e) {
      return send(500, { detail: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    workflows,
    runs,
    failPublish,
    failRuns,
    get refuseArtifacts() {
      return state.refuseArtifacts;
    },
    set refuseArtifacts(v: boolean) {
      state.refuseArtifacts = v;
    },
    triggered,
    requests,
    inboundHears: (id) => String(workflows.get(id)!.published.nodes.find((n) => n.type === "startCall")!.data!.prompt),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function addWorkflow(f: FakeDograh, id: number, name: string, prompt: string) {
  const def = baseDefinition(prompt);
  f.workflows.set(id, {
    id,
    name,
    uuid: `uuid-${id}`,
    published: def,
    draft: null,
    tcv: {},
    versions: [{ id: id * 10, version_number: 1, status: "published", created_at: new Date().toISOString(), published_at: new Date().toISOString(), workflow_json: clone(def) }],
  });
}
