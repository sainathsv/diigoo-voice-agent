/**
 * The permission catalog. Every check in the app names one of these strings.
 * Grouped by module so the role editor can render a module x level grid.
 *
 * Client permissions apply inside a client organization and may be scoped to
 * branches. Platform permissions apply only to memberships of the platform
 * organization (Diigoo) and are never branch-scoped.
 */

export const CLIENT_MODULES = {
  calls: {
    label: "Calls",
    permissions: {
      "calls:view": "See calls and summaries",
      "calls:view_own": "See calls linked to own patients or customers only",
      "recordings:play": "Play call recordings",
      "transcripts:view_raw": "Read full transcripts (unredacted)",
      "qa:score": "Score calls for quality review",
    },
  },
  contacts: {
    label: "Leads and contacts",
    permissions: {
      "contacts:view": "See leads and contacts",
      "contacts:edit": "Edit leads, tags and follow-ups",
      "contacts:reveal_phone": "See full phone numbers",
      "contacts:import": "Import contacts (with consent attestation)",
      "contacts:export": "Export contacts",
    },
  },
  campaigns: {
    label: "Campaigns",
    permissions: {
      "campaigns:view": "See campaigns",
      "campaigns:create": "Create and edit campaigns",
      "campaigns:approve": "Approve campaigns created by others",
      "campaigns:launch": "Launch or pause campaigns",
    },
  },
  agents: {
    label: "AI agents",
    permissions: {
      "agents:view": "See AI agents and versions",
      "agents:edit": "Edit agent drafts and run test calls",
      "agents:approve": "Approve agent changes made by others",
      "agents:publish": "Publish an agent version to live calls",
      "knowledge:edit": "Edit knowledge base, services and prices",
      "schedule:edit": "Edit hours, holidays and availability",
      "calendar:view": "See the calendar of visits and who they are with",
      "calendar:edit": "Add, move and cancel entries in the calendar",
    },
  },
  numbers: {
    label: "Phone numbers",
    permissions: {
      "numbers:view": "See phone numbers and routing",
      "numbers:manage": "Add numbers and change routing",
    },
  },
  integrations: {
    label: "Integrations",
    permissions: {
      "integrations:manage": "Connect and configure integrations",
      "apikeys:manage": "Create and revoke API keys",
    },
  },
  billing: {
    label: "Billing",
    permissions: {
      "billing:view": "See plan, usage and invoices",
      "billing:manage": "Change plan, top up wallet, payment methods",
    },
  },
  people: {
    label: "Team and access",
    permissions: {
      "users:view": "See team members",
      "users:invite": "Invite team members",
      "users:assign_roles": "Assign roles to team members",
      "roles:manage": "Create and edit custom roles",
      "branches:manage": "Create and edit branches and teams",
      "support_access:grant": "Allow JENAI support to access this workspace",
    },
  },
  reports: {
    label: "Reports",
    permissions: {
      "reports:view": "See dashboards and reports",
      "reports:export": "Export reports",
      "audit:view": "See the activity log",
    },
  },
  organization: {
    label: "Organization",
    permissions: {
      "org:manage": "Edit business profile and settings",
      "org:transfer_ownership": "Transfer ownership",
    },
  },
} as const;

export const PLATFORM_MODULES = {
  clients: {
    label: "Client accounts",
    permissions: {
      "platform:clients.view": "See client accounts, plans and usage",
      "platform:clients.manage": "Create, suspend and change plans of clients",
      "platform:clients.provision": "Run onboarding and go-live steps",
    },
  },
  access: {
    label: "Client data access",
    permissions: {
      "platform:support.request": "Request support access to a client",
      "platform:support.approve": "Approve write access and review grants",
      "platform:breakglass": "Emergency access without client consent (alerted, reviewed)",
    },
  },
  growth: {
    label: "Sales and marketing",
    permissions: {
      "platform:crm.own": "Work own sales pipeline",
      "platform:crm.all": "See the whole sales pipeline",
      "platform:marketing": "Run marketing campaigns and the funnel",
      "platform:discount.propose": "Propose discounts",
      "platform:discount.approve": "Approve discounts",
    },
  },
  operations: {
    label: "Voice operations",
    permissions: {
      "platform:templates.manage": "Manage vertical templates, models and voices",
      "platform:telephony.manage": "Manage carriers, number pool and DLT records",
    },
  },
  finance: {
    label: "Finance",
    permissions: {
      "platform:billing.view": "See billing, invoices and margins",
      "platform:billing.manage": "Manage plans, invoices, credits and refunds",
    },
  },
  admin: {
    label: "Platform admin",
    permissions: {
      "platform:staff.manage": "Manage Diigoo staff and their roles",
      "platform:audit.view": "See the platform-wide activity log",
      "platform:security.view": "See security alerts, sign-in activity and audit-log integrity",
      "platform:security.manage": "Acknowledge, resolve and close security alerts",
    },
  },
} as const;

export type ClientPermission = {
  [K in keyof typeof CLIENT_MODULES]: keyof (typeof CLIENT_MODULES)[K]["permissions"];
}[keyof typeof CLIENT_MODULES];
export type PlatformPermission = {
  [K in keyof typeof PLATFORM_MODULES]: keyof (typeof PLATFORM_MODULES)[K]["permissions"];
}[keyof typeof PLATFORM_MODULES];
export type Permission = ClientPermission | PlatformPermission;

function collect(mods: Record<string, { permissions: Record<string, string> }>): string[] {
  return Object.values(mods).flatMap((m) => Object.keys(m.permissions));
}

export const ALL_CLIENT_PERMISSIONS = collect(CLIENT_MODULES) as ClientPermission[];
export const ALL_PLATFORM_PERMISSIONS = collect(PLATFORM_MODULES) as PlatformPermission[];

const KNOWN = new Set<string>([...ALL_CLIENT_PERMISSIONS, ...ALL_PLATFORM_PERMISSIONS]);
export function isPermission(p: string): p is Permission {
  return KNOWN.has(p);
}
export function isPlatformPermission(p: string): p is PlatformPermission {
  return p.startsWith("platform:") && KNOWN.has(p);
}

export function describePermission(p: Permission): string {
  for (const mods of [CLIENT_MODULES, PLATFORM_MODULES] as const) {
    for (const m of Object.values(mods)) {
      const d = (m.permissions as Record<string, string>)[p];
      if (d) return d;
    }
  }
  return p;
}

/**
 * Permissions that hand out control rather than data. Granting a role that
 * holds any of these raises a security alert (privilege escalation watch).
 */
export const PRIVILEGED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "org:manage", "org:transfer_ownership", "roles:manage", "users:assign_roles",
  "apikeys:manage", "integrations:manage", "support_access:grant", "billing:manage",
  "platform:breakglass", "platform:staff.manage", "platform:support.approve",
  "platform:clients.manage", "platform:billing.manage", "platform:security.manage",
]);

export function privilegedIn(perms: readonly string[]): string[] {
  return perms.filter((p) => PRIVILEGED_PERMISSIONS.has(p as Permission));
}
