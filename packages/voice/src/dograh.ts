/**
 * Dograh API client. Pure HTTP: no database, no tenant logic. One instance per
 * client connection. Paths verified against the Dograh source on 2026-09-19.
 */

export type DograhAuth = { kind: "api_key"; apiKey: string } | { kind: "password"; email: string; password: string };

export interface DograhNode {
  id?: string;
  type?: string;
  data?: Record<string, unknown> & { prompt?: string; greeting?: string; name?: string };
  [k: string]: unknown;
}
export interface DograhDefinition {
  nodes: DograhNode[];
  edges: unknown[];
  [k: string]: unknown;
}
export interface DograhWorkflow {
  id: number;
  name: string;
  status?: string;
  workflow_uuid?: string | null;
  workflow_definition: DograhDefinition;
  template_context_variables?: Record<string, unknown> | null;
  version_number?: number | null;
  version_status?: string | null;
}
export interface DograhWorkflowListItem {
  id: number;
  name: string;
  status?: string;
  workflow_uuid?: string | null;
}
export interface DograhVersion {
  id: number;
  version_number: number;
  status: string;
  created_at: string;
  published_at?: string | null;
  workflow_json: DograhDefinition;
}
export interface DograhRun {
  id: number;
  workflow_id: number;
  name?: string | null;
  mode?: string;
  is_completed: boolean;
  created_at: string;
  call_type?: string | null;
  transcript_url?: string | null;
  recording_url?: string | null;
  transcript_public_url?: string | null;
  recording_public_url?: string | null;
  cost_info?: { call_duration_seconds?: number; [k: string]: unknown } | null;
  initial_context?: Record<string, unknown> | null;
  gathered_context?: Record<string, unknown> | null;
  definition_id?: number | null;
}
export interface DograhRunPage {
  runs: DograhRun[];
  total_count: number;
  page: number;
  limit: number;
  total_pages: number;
}
export interface DograhTelephonyConfig {
  id: number;
  name: string;
  provider: string;
  is_default_outbound: boolean;
  phone_number_count?: number;
}
export interface DograhPhoneNumber {
  id: number;
  telephony_configuration_id: number;
  address: string;
  address_normalized: string;
  address_type: string;
  label?: string | null;
  inbound_workflow_id?: number | null;
  is_active: boolean;
  is_default_caller_id: boolean;
}

export class DograhError extends Error {
  constructor(public readonly status: number, public readonly context: string, detail: string) {
    super(`Dograh ${context} failed (${status}): ${detail.slice(0, 300)}`);
    this.name = "DograhError";
  }
}

type Fetch = typeof fetch;

export class DograhClient {
  private token: { value: string; exp: number } | null = null;
  private readonly api: string;

  constructor(
    baseUrl: string,
    private readonly auth: DograhAuth,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 20_000,
    /** Internal object-store address (e.g. http://minio:9000). Only reachable inside the engine's network. */
    private readonly mediaBaseUrl: string | null = null,
  ) {
    this.api = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.auth.kind === "api_key") return { "X-API-Key": this.auth.apiKey };
    if (!this.token || this.token.exp < Date.now()) {
      const r = await this.raw("POST", "/auth/login", { email: this.auth.email, password: this.auth.password }, {}, "login");
      const token = (r as { token?: string }).token;
      if (!token) throw new DograhError(500, "login", "no token in response");
      this.token = { value: token, exp: Date.now() + 45 * 60_000 };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  private async raw(method: string, path: string, body: unknown, headers: Record<string, string>, context: string): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.api}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const text = await res.text();
      if (!res.ok) throw new DograhError(res.status, context, text);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  }

  private async call<T>(method: string, path: string, context: string, body?: unknown): Promise<T> {
    try {
      return (await this.raw(method, path, body, await this.authHeaders(), context)) as T;
    } catch (e) {
      // A stale session token gets one fresh login and retry.
      if (e instanceof DograhError && e.status === 401 && this.auth.kind === "password") {
        this.token = null;
        return (await this.raw(method, path, body, await this.authHeaders(), context)) as T;
      }
      throw e;
    }
  }

  /** Cheap authenticated call used to verify a connection. */
  context() {
    return this.call<Record<string, unknown>>("GET", "/organizations/context", "organization context");
  }
  listWorkflows() {
    return this.call<DograhWorkflowListItem[]>("GET", "/workflow/fetch", "list workflows");
  }
  /** Returns the draft when one exists, else the published definition. */
  getWorkflow(id: number) {
    return this.call<DograhWorkflow>("GET", `/workflow/fetch/${id}`, `fetch workflow ${id}`);
  }
  listVersions(id: number, limit = 5) {
    return this.call<DograhVersion[]>("GET", `/workflow/${id}/versions?limit=${limit}`, `versions of workflow ${id}`);
  }
  /** Writes the DRAFT only. Inbound calls keep using the published version until publish(). */
  putWorkflow(wf: Pick<DograhWorkflow, "id" | "name" | "workflow_definition" | "template_context_variables">) {
    return this.call<unknown>("PUT", `/workflow/${wf.id}`, `save draft of workflow ${wf.id}`, {
      name: wf.name,
      workflow_definition: wf.workflow_definition,
      template_context_variables: wf.template_context_variables ?? {},
    });
  }
  /** Forks the published definition into a draft. Resolves false when a draft already exists. */
  async createDraft(id: number): Promise<boolean> {
    try {
      await this.call<unknown>("POST", `/workflow/${id}/create-draft`, `create draft of workflow ${id}`, {});
      return true;
    } catch (e) {
      if (e instanceof DograhError && (e.status === 400 || e.status === 409)) return false;
      throw e;
    }
  }
  publish(id: number) {
    return this.call<unknown>("POST", `/workflow/${id}/publish`, `publish workflow ${id}`, {});
  }
  listRuns(workflowId: number, page = 1, limit = 50) {
    return this.call<DograhRunPage>("GET", `/workflow/${workflowId}/runs?page=${page}&limit=${limit}&sort_order=desc`, `runs of workflow ${workflowId}`);
  }
  getRun(workflowId: number, runId: number) {
    return this.call<DograhRun>("GET", `/workflow/${workflowId}/runs/${runId}`, `run ${runId}`);
  }
  listTelephonyConfigs() {
    return this.call<{ configurations: DograhTelephonyConfig[] }>("GET", "/organizations/telephony-configs", "telephony configs");
  }
  listPhoneNumbers(configId: number) {
    return this.call<{ phone_numbers: DograhPhoneNumber[] }>("GET", `/organizations/telephony-configs/${configId}/phone-numbers`, `numbers of config ${configId}`);
  }

  /**
   * Place a call against the PUBLISHED agent with per-call context. This is
   * the dialer's dispatch: no workflow rewrite per call, so calls can run in
   * parallel. Needs an organization API key (Dograh rejects session tokens here).
   */
  async triggerCall(workflowUuid: string, input: { phone: string; context: Record<string, unknown>; telephonyConfigId?: number | null }) {
    if (this.auth.kind !== "api_key") throw new DograhError(400, "trigger call", "placing calls needs a Dograh organization API key");
    return (await this.raw(
      "POST",
      `/public/agent/workflow/${encodeURIComponent(workflowUuid)}`,
      { phone_number: input.phone, initial_context: input.context, telephony_configuration_id: input.telephonyConfigId ?? null },
      { "X-API-Key": this.auth.apiKey },
      "trigger call",
    )) as { status: string; workflow_run_id: number; workflow_run_name: string };
  }

  /**
   * Transcripts and recordings: Dograh's tokenised download URL redirects to
   * its object store (/voice-audio/...), which is blocked from the internet on
   * purpose. When a media base URL is configured (platform running next to the
   * engine), the redirect is followed to that internal address instead.
   */
  async fetchArtifact(url: string, range?: string | null): Promise<Response> {
    const headers: Record<string, string> = range ? { Range: range } : {};
    const first = await this.fetchImpl(url, { headers, redirect: "manual", cache: "no-store" });
    if (first.status < 300 || first.status >= 400) return first;
    const loc = first.headers.get("location");
    if (!loc) return first;
    const target = new URL(loc, url);
    if (this.mediaBaseUrl && target.pathname.startsWith("/voice-audio/")) {
      return this.fetchImpl(`${this.mediaBaseUrl.replace(/\/+$/, "")}${target.pathname}`, { headers, cache: "no-store" });
    }
    return this.fetchImpl(target.toString(), { headers, cache: "no-store" });
  }
}
