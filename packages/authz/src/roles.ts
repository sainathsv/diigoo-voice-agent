import {
  ALL_CLIENT_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  type ClientPermission,
  type PlatformPermission,
} from "./permissions";

export interface RoleTemplate<P extends string> {
  key: string;
  name: string;
  description: string;
  /** Default scope when this role is granted: whole organization, or chosen branches. */
  defaultScope: "org" | "branch";
  permissions: readonly P[];
}

const without = <P extends string>(all: readonly P[], drop: readonly P[]): P[] =>
  all.filter((p) => !drop.includes(p));

/**
 * Default client roles (Blueprint Part 3). Clients can clone and edit these as
 * custom roles; the system templates themselves are read-only.
 */
export const CLIENT_ROLE_TEMPLATES: readonly RoleTemplate<ClientPermission>[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Full control, including billing and transferring ownership. Exactly one per organization.",
    defaultScope: "org",
    permissions: ALL_CLIENT_PERMISSIONS,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Runs the workspace: agents, numbers, integrations, team. Sees billing but cannot change it.",
    defaultScope: "org",
    permissions: without(ALL_CLIENT_PERMISSIONS, ["billing:manage", "org:transfer_ownership", "calls:view_own"]),
  },
  {
    key: "branch_manager",
    name: "Branch manager",
    description: "Runs assigned branches: calls, leads, hours and knowledge. Proposes campaigns and agent changes.",
    defaultScope: "branch",
    permissions: [
      "calls:view", "recordings:play", "qa:score",
      "contacts:view", "contacts:edit", "contacts:reveal_phone",
      "campaigns:view", "campaigns:create",
      "agents:view", "agents:edit", "knowledge:edit", "schedule:edit",
      "numbers:view",
      "users:view", "users:invite", "users:assign_roles",
      "reports:view", "reports:export",
      "calendar:view", "calendar:edit",
    ],
  },
  {
    key: "front_desk",
    name: "Front desk",
    description: "Handles today's calls, callbacks and appointments for assigned branches.",
    defaultScope: "branch",
    permissions: [
      "calls:view", "recordings:play",
      "contacts:view", "contacts:edit", "contacts:reveal_phone",
      "schedule:edit",
      "reports:view",
      "calendar:view", "calendar:edit",
    ],
  },
  {
    key: "marketing",
    name: "Marketing",
    description: "Builds campaigns and segments. Sees masked phone numbers; launches need approval.",
    defaultScope: "org",
    permissions: [
      "calls:view",
      "contacts:view", "contacts:edit", "contacts:import",
      "campaigns:view", "campaigns:create",
      "agents:view",
      "reports:view",
    ],
  },
  {
    key: "qa_supervisor",
    name: "Supervisor / QA",
    description: "Reviews and scores calls, drafts agent improvements. Publishing needs approval.",
    defaultScope: "org",
    permissions: [
      "calls:view", "recordings:play", "transcripts:view_raw", "qa:score",
      "contacts:view",
      "campaigns:view",
      "agents:view", "agents:edit",
      "numbers:view",
      "reports:view",
      "calendar:view",
    ],
  },
  {
    key: "practitioner",
    name: "Doctor / practitioner",
    description: "Sees call summaries for their own patients or customers only.",
    defaultScope: "branch",
    permissions: ["calls:view_own", "contacts:view", "contacts:reveal_phone",
      "calendar:view",
    ],
  },
  {
    key: "analyst",
    name: "Analyst (read-only)",
    description: "Reads dashboards and masked data. No exports, no changes.",
    defaultScope: "org",
    permissions: ["calls:view", "contacts:view", "campaigns:view", "agents:view", "numbers:view", "reports:view",
      "calendar:view",
    ],
  },
  {
    key: "billing_contact",
    name: "Billing contact",
    description: "Receives invoices and sees usage.",
    defaultScope: "org",
    permissions: ["billing:view", "reports:view"],
  },
];

/** Diigoo staff roles (Blueprint Part 3). No role has standing access to client personal data. */
export const PLATFORM_ROLE_TEMPLATES: readonly RoleTemplate<PlatformPermission>[] = [
  {
    key: "super_admin",
    name: "Super admin",
    description: "Founders only. Everything, including break-glass access (always alerted and reviewed).",
    defaultScope: "org",
    permissions: ALL_PLATFORM_PERMISSIONS,
  },
  {
    key: "platform_ops",
    name: "Platform ops",
    description: "Creates, provisions and suspends clients; approves support access; runs templates and telephony.",
    defaultScope: "org",
    permissions: [
      "platform:clients.view", "platform:clients.manage", "platform:clients.provision",
      "platform:support.request", "platform:support.approve",
      "platform:templates.manage", "platform:telephony.manage",
      "platform:billing.view", "platform:audit.view",
      "platform:security.view", "platform:security.manage",
    ],
  },
  {
    key: "sales",
    name: "Sales / BD",
    description: "Own pipeline, demos and trial accounts. Discounts need Finance approval.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:crm.own", "platform:discount.propose"],
  },
  {
    key: "marketing",
    name: "Marketing",
    description: "Runs the funnel and campaigns. Sees anonymised client aggregates only.",
    defaultScope: "org",
    permissions: ["platform:marketing", "platform:crm.all"],
  },
  {
    key: "customer_success",
    name: "Customer success",
    description: "Onboards and supports assigned clients; time-boxed data access with client consent.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:clients.provision", "platform:support.request", "platform:billing.view"],
  },
  {
    key: "support",
    name: "Support",
    description: "Answers tickets; read-only access grants with client consent.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:support.request"],
  },
  {
    key: "finance",
    name: "Finance",
    description: "Plans, invoices, credits, refunds and discount approval.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:billing.view", "platform:billing.manage", "platform:discount.approve"],
  },
  {
    key: "voice_ops",
    name: "Engineering / voice ops",
    description: "Models, voices, carriers and templates. Client data only through grants.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:templates.manage", "platform:telephony.manage", "platform:support.request"],
  },
  {
    key: "auditor",
    name: "Auditor (read-only)",
    description: "Reads everything administrative, including all access grants.",
    defaultScope: "org",
    permissions: ["platform:clients.view", "platform:billing.view", "platform:audit.view", "platform:security.view"],
  },
];

export function findTemplate(side: "client" | "platform", key: string) {
  const list = side === "client" ? CLIENT_ROLE_TEMPLATES : PLATFORM_ROLE_TEMPLATES;
  return (list as readonly RoleTemplate<string>[]).find((r) => r.key === key);
}
