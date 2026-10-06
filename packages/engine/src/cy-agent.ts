/**
 * The Uttarakhand Cyber Crime Police Department's phone agent (workspace cy-police), from a version of the police.cy_cybercrime_complaint
 * program: the same wording the agent files were built with (department name,
 * greeting without the AI line, the platform's safety rules), put onto the live
 * workflow in place. Only the conversation changes (the start and end prompts and
 * the fields saved per call); the workflow, its phone number and its voice and
 * model settings stay as they are.
 */
import { CYBER_INTAKE_DOMAIN, render, type DograhClient, type DograhDefinition } from "@jenai/voice";

export interface CyProgram {
  version: number;
  task_prompt: string;
  extraction: Array<{ name: string; type: string; prompt: string }>;
}

// The department's instruction (2026-10-03): the call never promises that an officer will call back.
const VALUES: Record<string, string> = {
  department_name: "Uttarakhand Cyber Crime Police Department",
  freeze_step: "Please stay on the line. I am taking this as an urgent money complaint so our team can act to hold the money straight away.",
  evidence_channel: "keep them safe, the police will need them",
  handover_wording: "I am marking your complaint as most urgent for the officers.",
  next_step_wording: "Your complaint has been registered, and the Uttarakhand Cyber Crime Police Department will work on it.",
};
// The department's instruction: the greeting names the helpline and the recording, without the AI line,
// and offers Hindi and English only (2026-10-06).
// A caller with a complaint already registered is asked first whether they call about it ({{status_greeting}}
// comes from the police server's lookup as the call starts); everyone else is asked what happened.
const GREETING =
  "नमस्ते, यह उत्तराखंड साइबर क्राइम पुलिस विभाग की हेल्पलाइन है। यह कॉल रिकॉर्ड हो रही है। {{status_greeting | fallback:आप हिंदी या English में बात कर सकते हैं। बताइए क्या हुआ है, और अगर पैसे कटे हैं तो सबसे पहले वही बताइए।}}";
const FACTS =
  "YOU ARE the complaint desk of the Uttarakhand Cyber Crime Police Department (in Hindi: उत्तराखंड साइबर क्राइम पुलिस विभाग). You answer citizens who ring its cyber crime helpline, take their complaint in the department's format, one question at a time, and pass it to the department's officers. Whenever you name the department, say Uttarakhand Cyber Crime Police Department (in Hindi: उत्तराखंड साइबर क्राइम पुलिस विभाग).";
const EXTRACTION_PROMPT =
  "Today is {{current_time_Asia/Kolkata | fallback:the day of the call}}. Extract the cyber crime complaint from this call; null for anything not said. Always output ENGLISH, translating anything said in Hindi, Nepali, Telugu or any other language. Names and addresses in English letters, using the SPELLING the caller gave letter by letter. NEVER guess a name: if a name was not clearly said or spelled and confirmed, output null. Never use a name that only the assistant said.";

/** The start prompt, the end prompt and the per-call fields for a program version. */
export function cyAgentParts(p: CyProgram) {
  const fill = (s: string) => s.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (w, k: string) => VALUES[k] ?? w);
  const r = render({ basePrompt: "", endPrompt: "", extraction: [], extractionPrompt: "" }, { greeting: GREETING, facts: FACTS, taskPrompt: fill(p.task_prompt) }, CYBER_INTAKE_DOMAIN);
  const prompt = r.inboundPrompt.trimEnd();
  const left = prompt.match(/\{\{[a-z_]+\}\}/g);
  if (left) throw new Error(`The program leaves blanks unfilled: ${left.join(", ")}`);
  const endPrompt = `The call is over. In the caller's language say ONLY a short goodbye, in one sentence ("धन्यवाद, नमस्ते।" / "Thank you, goodbye."). Only if you had not yet told them what happens next, first say it in one sentence: with WhatsApp, that the helpline is sending them a message on WhatsApp now and the complaint continues there; without WhatsApp: ${VALUES.next_step_wording} Never say that anyone will call them back. Do not ask anything.`;
  // Saved on the Start step too: a caller who hangs up mid-complaint still leaves what they said.
  const extraction = { extraction_enabled: true, extraction_prompt: EXTRACTION_PROMPT, extraction_variables: p.extraction };
  return { prompt, endPrompt, extraction };
}

/** When the agent moves to the End step, which hangs up once its goodbye is said. */
const END_WHEN =
  "END THE CALL NOW: right after you have told them what happens on WhatsApp (STEP 5), including the link for money lost 3 or more days ago; after the closing for a caller without WhatsApp; after the status of a complaint already registered when they have nothing to add (STEP 0); after telling them it is not a cyber crime; when the caller is silent, abusive, playing a prank or still not making a complaint after you asked twice; or when the caller says goodbye. Do not wait for the caller to reply first. Background noise is never a reason to end.";

/**
 * The line must stay free for the next caller (people block helplines by staying on the
 * line): every call is cut at 10 minutes, and a caller silent for 10 seconds is asked once
 * whether they are there, then the call ends.
 */
export const CY_CALL_SETTINGS = { max_call_duration: 600, max_user_idle_timeout: 10 };

/** The department's instruction (2026-10-06): a male voice. Charon is Gemini Live's calm male voice. */
export const CY_VOICE = "Charon";

/**
 * The agent's voice, set on this agent only: inside its own complete model settings when it has
 * them (the engine keeps their keys), otherwise as an override of the organization's live voice.
 */
export function withVoice(configs: Record<string, unknown>, voice: string): Record<string, unknown> {
  type Obj = Record<string, unknown>;
  const v2 = configs.model_configuration_v2_override as Obj | undefined;
  const byok = v2?.byok as Obj | undefined;
  const live = byok?.realtime as Obj | undefined;
  const rt = live?.realtime as Obj | undefined;
  if (v2 && byok && live && rt) return { ...configs, model_configuration_v2_override: { ...v2, byok: { ...byok, realtime: { ...live, realtime: { ...rt, voice } } } } };
  const overrides = (configs.model_overrides ?? {}) as Obj;
  return { ...configs, model_overrides: { ...overrides, realtime: { ...((overrides.realtime ?? {}) as Obj), voice } } };
}

type Edge = { source?: string; target?: string; data?: Record<string, unknown>; [k: string]: unknown };

/** The workflow with only its start and end steps' prompts, saved fields and the rule for ending the call replaced. */
export function withCyConversation(def: DograhDefinition, parts: ReturnType<typeof cyAgentParts>): DograhDefinition {
  const starts = def.nodes.filter((n) => n.type === "startCall");
  if (starts.length !== 1) throw new Error(`Expected one Start step in the agent, found ${starts.length}; it was not changed.`);
  const ends = new Set(def.nodes.filter((n) => n.type === "endCall").map((n) => n.id));
  const edges = (def.edges as Edge[]).map((e) => (e.source === starts[0]!.id && ends.has(e.target) ? { ...e, data: { ...(e.data ?? {}), condition: END_WHEN } } : e));
  if (!edges.some((e) => e.data?.condition === END_WHEN)) throw new Error("Expected a step from Start to End in the agent; it was not changed.");
  return {
    ...def,
    edges,
    nodes: def.nodes.map((n) =>
      n.type === "startCall"
        ? { ...n, data: { ...(n.data ?? {}), prompt: parts.prompt, ...parts.extraction } }
        : n.type === "endCall"
          ? { ...n, data: { ...(n.data ?? {}), prompt: parts.endPrompt, ...parts.extraction } }
          : n,
    ),
  };
}

/**
 * As a call comes in, the engine asks this server for the status of a complaint from the
 * number calling (its pre-call lookup), with the token kept as a credential; the script
 * reads it as {{complaint_status}}. Null leaves the Start step as it is.
 */
export function withStatusLookup(def: DograhDefinition, lookup: { url: string; credentialUuid: string } | null): DograhDefinition {
  if (!lookup) return def;
  return {
    ...def,
    nodes: def.nodes.map((n) =>
      n.type === "startCall"
        ? { ...n, data: { ...(n.data ?? {}), pre_call_fetch_mode: "inbound", pre_call_fetch_url: lookup.url, pre_call_fetch_credential_uuid: lookup.credentialUuid } }
        : n,
    ),
  };
}

/**
 * Puts a definition live on the workflow: a draft, then publish, then a read back to
 * confirm. `settings` changes the call settings too (the call length and silence limits).
 * Returns what was live before, for the backup file.
 */
export async function publishDefinition(
  client: DograhClient,
  workflowId: number,
  next: (current: DograhDefinition) => DograhDefinition,
  settings?: (current: Record<string, unknown>) => Record<string, unknown>,
) {
  const wf = await client.getWorkflow(workflowId);
  const before = structuredClone(wf);
  const definition = next(wf.workflow_definition);
  const configurations = settings ? settings(wf.workflow_configurations ?? {}) : null;
  await client.createDraft(workflowId);
  await client.putWorkflow({ id: workflowId, name: wf.name, workflow_definition: definition, template_context_variables: wf.template_context_variables ?? {}, ...(configurations ? { workflow_configurations: configurations } : {}) });
  await client.publish(workflowId);
  const after = await client.getWorkflow(workflowId);
  const live = after.workflow_definition.nodes.find((n) => n.type === "startCall")?.data?.prompt;
  const wanted = definition.nodes.find((n) => n.type === "startCall")?.data?.prompt;
  if (live !== wanted) throw new Error("The engine did not keep the new conversation; check the agent in the Dograh dashboard.");
  if (configurations && after.workflow_configurations?.max_call_duration !== configurations.max_call_duration)
    throw new Error("The engine did not keep the call settings; check the agent in the Dograh dashboard.");
  return { before, name: wf.name };
}
