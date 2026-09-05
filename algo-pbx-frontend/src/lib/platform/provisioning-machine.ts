// The tenant provisioning pipeline, as a pure state machine.
//
// The step order is the approved plan §4's sequence, unchanged. What this
// module adds is the two GATES the plan insists on, expressed as data rather
// than as remembered discipline:
//
//   1. `issue_cert` is a HUMAN gate. The CA key is passphrase-protected, so
//      bridge-watch.sh refuses unattended signing and prints a manual
//      easyrsa command instead. The plan is explicit: "This plan does not
//      attempt to work around it", and notes the gate "is arguably correct
//      for the root of tenant isolation anyway". So the wizard pauses here
//      and offers no automated signing action of any kind.
//
//   2. Everything AFTER cert issuance is blocked until the tenant's gateway
//      has completed a real OpenVPN handshake (the G2 prerequisite). Writing
//      ccd entries, firewall rules and telephony config for a tunnel that has
//      never come up produces configuration nobody has ever validated, on the
//      exact path tenant isolation depends on.
//
//   3. `write_ccd` and `firewall_rules` additionally require the per-tenant
//      subnet scheme to be switched on. It ships OFF: the deployed reality is
//      a single 10.8.0.0/24, and the plan says "finish G2 on the current
//      single-/24 first, then widen. Do not stack an untested subnet redesign
//      on top of an unproven tunnel." The owner-only flag exists so the code
//      is ready the moment G2 passes, without another build.
//
// Pure: no DB, no filesystem. The caller supplies observed prerequisites.

export type ProvisioningStepId =
  | "validate_slug"
  | "create_tenant"
  | "allocate_subnet"
  | "create_gateway_site"
  | "allocate_subdomain"
  | "compliance_checklist"
  | "issue_cert"
  | "write_ccd"
  | "firewall_rules"
  | "generate_ovpn"
  | "telephony_namespace"
  | "invite_tenant_admin";

export interface ProvisioningStepSpec {
  id: ProvisioningStepId;
  label: string;
  description: string;
  /** "human" steps never execute automatically — the wizard renders
   * instructions and waits for the operator to confirm they did it. */
  gate: "auto" | "human";
}

/** Ordered. Index in this array is the step's position in the pipeline. */
export const PROVISIONING_STEPS: readonly ProvisioningStepSpec[] = [
  {
    id: "validate_slug",
    label: "Validate slug",
    description:
      "Lowercase, DNS-safe, SAFE_NAME_RE-compatible, not reserved, and unique. Immutable afterwards — it becomes the subdomain, the cert CN and the ccd filename.",
    gate: "auto",
  },
  {
    id: "create_tenant",
    label: "Create tenant",
    description: "Insert the Tenant row with its plan, seats and billing defaults.",
    gate: "auto",
  },
  {
    id: "allocate_subnet",
    label: "Allocate tunnel subnet index",
    description:
      "Assign the next index (never reused, even after offboarding) giving the tenant 10.8.<n>.0/24 and the t<n>- telephony namespace.",
    gate: "auto",
  },
  {
    id: "create_gateway_site",
    label: "Create gateway site",
    description:
      "Create GatewaySite cust-<slug>-gw-1. This one name is simultaneously the cert CN, the ccd filename and GatewaySite.name — they cannot drift.",
    gate: "auto",
  },
  {
    id: "allocate_subdomain",
    label: "Verify workspace subdomain",
    description:
      "Confirm <slug>.algopbx.com resolves under the existing one-time wildcard DNS record. No per-tenant DNS record is created — if this fails, the wildcard record itself is missing.",
    gate: "auto",
  },
  {
    id: "compliance_checklist",
    label: "Record compliance checklist",
    description:
      "File type-approval, carrier letter, AUP, PDPL terms and recording disclosure. Incomplete does not block provisioning, but raises a persistent warning.",
    gate: "auto",
  },
  {
    id: "issue_cert",
    label: "Issue gateway certificate",
    description:
      "The CA key is passphrase-protected, so signing is deliberately manual. Run the printed easyrsa command on the host, then confirm here.",
    gate: "human",
  },
  {
    id: "write_ccd",
    label: "Write ccd entry",
    description:
      "Pin the gateway's tunnel IP and route its subnet. Requires the per-tenant subnet scheme, which is off by default.",
    gate: "auto",
  },
  {
    id: "firewall_rules",
    label: "Add firewall rules",
    description: "Permit the tenant's /24 and isolate it from every other tenant's.",
    gate: "auto",
  },
  {
    id: "generate_ovpn",
    label: "Generate .ovpn bundle",
    description: "Produce the client profile ready to push to the tenant's Dinstar gateway.",
    gate: "auto",
  },
  {
    id: "telephony_namespace",
    label: "Generate telephony namespace",
    description:
      "PJSIP endpoints t<n>-<ext>, queues t<n>-<queue>, dialplan contexts from-agent-t<n> / from-dinstar-t<n>.",
    gate: "auto",
  },
  {
    id: "invite_tenant_admin",
    label: "Invite tenant admin",
    description: "Send the first tenant ADMIN their invite so they can set up their own users.",
    gate: "auto",
  },
];

/** Steps that may not run until the gateway has completed a handshake. Every
 * step at or after `write_ccd` — i.e. everything that writes configuration
 * onto the tunnel path itself. */
const CERT_INDEX = PROVISIONING_STEPS.findIndex((s) => s.id === "issue_cert");
const FIRST_POST_TUNNEL_INDEX = CERT_INDEX + 1;

/** Steps additionally gated on the per-tenant subnet scheme being enabled. */
const SUBNET_SCHEME_STEPS: readonly ProvisioningStepId[] = ["write_ccd", "firewall_rules"];

export interface ProvisioningState {
  /** Completed step ids, in completion order. */
  completed: ProvisioningStepId[];
  /** Set when a step failed, so the wizard can show why rather than looking
   * merely stalled. */
  lastError?: { step: ProvisioningStepId; message: string } | null;
}

export interface ProvisioningPrereqs {
  /** GatewaySite.lastHandshakeAt — null means the tunnel has never come up. */
  tunnelHandshakeAt: Date | null;
  /** The owner-only AppSetting gating the 10.8.0.0/16 widening. */
  perTenantSubnetEnabled: boolean;
  /** Whether the manually-signed client certificate is now present on disk. */
  certPresent: boolean;
}

export type AdvanceVerdict =
  | { ok: true; step: ProvisioningStepSpec }
  | { ok: false; blocked: true; step: ProvisioningStepSpec; reason: string }
  | { ok: false; done: true };

export function stepSpec(id: ProvisioningStepId): ProvisioningStepSpec {
  const spec = PROVISIONING_STEPS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown provisioning step: ${id}`);
  return spec;
}

/** The next step not yet completed, or null when the pipeline is finished.
 * Order is the array's order — a completed set with holes still advances to
 * the earliest incomplete step, so a partially-failed run resumes correctly. */
export function nextStep(state: ProvisioningState): ProvisioningStepSpec | null {
  const done = new Set(state.completed);
  return PROVISIONING_STEPS.find((s) => !done.has(s.id)) ?? null;
}

export function isComplete(state: ProvisioningState): boolean {
  return nextStep(state) === null;
}

export function progress(state: ProvisioningState): { completed: number; total: number } {
  const done = new Set(state.completed);
  return {
    completed: PROVISIONING_STEPS.filter((s) => done.has(s.id)).length,
    total: PROVISIONING_STEPS.length,
  };
}

/**
 * Decides whether the pipeline may advance, and if not, says exactly why in
 * language an operator can act on. The reason strings are rendered verbatim
 * in the wizard — a blocked step that does not explain itself is
 * indistinguishable from a bug.
 */
export function canAdvance(state: ProvisioningState, prereqs: ProvisioningPrereqs): AdvanceVerdict {
  const step = nextStep(state);
  if (!step) return { ok: false, done: true };

  const index = PROVISIONING_STEPS.indexOf(step);

  // Gate 1 — the human cert gate. Never auto-executes; the wizard shows the
  // manual command and waits. Once the cert exists, this step completes by
  // operator confirmation, not by us signing anything.
  if (step.id === "issue_cert" && !prereqs.certPresent) {
    return {
      ok: false,
      blocked: true,
      step,
      reason:
        "The CA key is passphrase-protected, so certificates are signed by hand on purpose. " +
        "Run the command shown below on the OpenVPN host, then confirm here. " +
        "Automated signing stays disabled until CA signing flow v2 ships.",
    };
  }

  // Gate 2 — the G2 tunnel prerequisite.
  if (index >= FIRST_POST_TUNNEL_INDEX && prereqs.tunnelHandshakeAt === null) {
    return {
      ok: false,
      blocked: true,
      step,
      reason:
        "No OpenVPN handshake has ever been observed for this gateway. Provisioning beyond " +
        "certificate issuance is disabled until the tunnel comes up — writing ccd entries, " +
        "firewall rules and telephony config for an unproven tunnel produces configuration " +
        "nobody has validated, on the exact path tenant isolation depends on. See handoff.md G2.",
    };
  }

  // Gate 3 — the per-tenant subnet scheme, off by default.
  if (SUBNET_SCHEME_STEPS.includes(step.id) && !prereqs.perTenantSubnetEnabled) {
    return {
      ok: false,
      blocked: true,
      step,
      reason:
        "Per-tenant subnets are switched off. The deployed OpenVPN server is a single " +
        "10.8.0.0/24; this step needs it widened to 10.8.0.0/16 with per-tenant ccd/iroute. " +
        "The approved plan says to finish G2 on the current /24 first and not stack an untested " +
        "subnet redesign on an unproven tunnel. A platform owner can enable it in Platform Settings " +
        "once G2 has passed.",
    };
  }

  return { ok: true, step };
}

/** Marks a step complete, ignoring duplicates so a retried confirmation is
 * idempotent rather than corrupting the order. */
export function completeStep(state: ProvisioningState, id: ProvisioningStepId): ProvisioningState {
  stepSpec(id);
  if (state.completed.includes(id)) return { ...state, lastError: null };
  return { completed: [...state.completed, id], lastError: null };
}

export function failStep(
  state: ProvisioningState,
  id: ProvisioningStepId,
  message: string
): ProvisioningState {
  stepSpec(id);
  return { ...state, lastError: { step: id, message } };
}

export function emptyProvisioningState(): ProvisioningState {
  return { completed: [], lastError: null };
}
