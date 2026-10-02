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

const VALUES: Record<string, string> = {
  department_name: "Uttarakhand Cyber Crime Police Department",
  freeze_step: "Please stay on the line. I am taking this as an urgent money complaint so our team can act to hold the money straight away.",
  evidence_channel: "the officer who calls them back will collect them",
  handover_wording: "I am marking this as urgent for an officer, who will call you back on this number right away.",
  next_step_wording: "An officer of the Uttarakhand Cyber Crime Police Department will call you back on this number.",
};
// The department's instruction: the greeting names the helpline and the recording, without the AI line.
const GREETING =
  "नमस्ते, यह उत्तराखंड साइबर क्राइम पुलिस विभाग की हेल्पलाइन है। यह कॉल रिकॉर्ड हो रही है। आप हिंदी, English या नेपालीमा बात कर सकते हैं। बताइए क्या हुआ है, और अगर पैसे कटे हैं तो सबसे पहले वही बताइए।";
const FACTS =
  "YOU ARE the complaint desk of the Uttarakhand Cyber Crime Police Department (in Hindi: उत्तराखंड साइबर क्राइम पुलिस विभाग). You answer citizens who ring its cyber crime helpline, take their complaint in the department's format, one question at a time, and pass it to the department's officers. Whenever you name the department, say Uttarakhand Cyber Crime Police Department (in Hindi: उत्तराखंड साइबर क्राइम पुलिस विभाग).";
const EXTRACTION_PROMPT =
  "Extract the cyber crime complaint from this call; null for anything not said. Always output ENGLISH, translating anything said in Hindi, Nepali, Telugu or any other language. Names and addresses in English letters, using the SPELLING the caller gave letter by letter. NEVER guess a name: if a name was not clearly said or spelled and confirmed, output null. Never use a name that only the assistant said.";

/** The start prompt, the end prompt and the per-call fields for a program version. */
export function cyAgentParts(p: CyProgram) {
  const fill = (s: string) => s.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (w, k: string) => VALUES[k] ?? w);
  const r = render({ basePrompt: "", endPrompt: "", extraction: [], extractionPrompt: "" }, { greeting: GREETING, facts: FACTS, taskPrompt: fill(p.task_prompt) }, CYBER_INTAKE_DOMAIN);
  const prompt = r.inboundPrompt.trimEnd();
  const left = prompt.match(/\{\{[a-z_]+\}\}/g);
  if (left) throw new Error(`The program leaves blanks unfilled: ${left.join(", ")}`);
  const endPrompt = `The complaint is complete. In the caller's language, thank them, tell them: ${VALUES.next_step_wording} Then say goodbye politely and end the call. Do not ask any more questions.`;
  // Saved on the Start step too: a caller who hangs up mid-complaint still leaves what they said.
  const extraction = { extraction_enabled: true, extraction_prompt: EXTRACTION_PROMPT, extraction_variables: p.extraction };
  return { prompt, endPrompt, extraction };
}

/** The workflow with only its start and end steps' prompts and saved fields replaced. */
export function withCyConversation(def: DograhDefinition, parts: ReturnType<typeof cyAgentParts>): DograhDefinition {
  const starts = def.nodes.filter((n) => n.type === "startCall");
  if (starts.length !== 1) throw new Error(`Expected one Start step in the agent, found ${starts.length}; it was not changed.`);
  return {
    ...def,
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
 * Puts a definition live on the workflow: a draft, then publish, then a read back to
 * confirm. Returns what was live before, for the backup file.
 */
export async function publishDefinition(client: DograhClient, workflowId: number, next: (current: DograhDefinition) => DograhDefinition) {
  const wf = await client.getWorkflow(workflowId);
  const before = structuredClone(wf);
  const definition = next(wf.workflow_definition);
  await client.createDraft(workflowId);
  await client.putWorkflow({ id: workflowId, name: wf.name, workflow_definition: definition, template_context_variables: wf.template_context_variables ?? {} });
  await client.publish(workflowId);
  const after = await client.getWorkflow(workflowId);
  const live = after.workflow_definition.nodes.find((n) => n.type === "startCall")?.data?.prompt;
  const wanted = definition.nodes.find((n) => n.type === "startCall")?.data?.prompt;
  if (live !== wanted) throw new Error("The engine did not keep the new conversation; check the agent in the Dograh dashboard.");
  return { before, name: wf.name };
}
