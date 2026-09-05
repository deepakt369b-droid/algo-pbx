import { describe, it, expect } from "vitest";
import {
  PROVISIONING_STEPS,
  nextStep,
  canAdvance,
  completeStep,
  failStep,
  isComplete,
  progress,
  stepSpec,
  emptyProvisioningState,
  type ProvisioningState,
  type ProvisioningPrereqs,
  type ProvisioningStepId,
} from "./provisioning-machine";

const HANDSHAKE = new Date("2026-09-05T10:00:00.000Z");

function prereqs(overrides: Partial<ProvisioningPrereqs> = {}): ProvisioningPrereqs {
  return {
    tunnelHandshakeAt: HANDSHAKE,
    perTenantSubnetEnabled: true,
    certPresent: true,
    ...overrides,
  };
}

/** A state with every step up to (not including) `id` completed. */
function stateUpTo(id: ProvisioningStepId): ProvisioningState {
  const index = PROVISIONING_STEPS.findIndex((s) => s.id === id);
  return { completed: PROVISIONING_STEPS.slice(0, index).map((s) => s.id), lastError: null };
}

describe("step order matches the approved plan §4 sequence", () => {
  it("starts with slug validation and ends with the tenant admin invite", () => {
    expect(PROVISIONING_STEPS[0].id).toBe("validate_slug");
    expect(PROVISIONING_STEPS[PROVISIONING_STEPS.length - 1].id).toBe("invite_tenant_admin");
  });

  it("places cert issuance before ccd, firewall and .ovpn generation", () => {
    const idx = (id: ProvisioningStepId) => PROVISIONING_STEPS.findIndex((s) => s.id === id);
    expect(idx("issue_cert")).toBeLessThan(idx("write_ccd"));
    expect(idx("issue_cert")).toBeLessThan(idx("firewall_rules"));
    expect(idx("issue_cert")).toBeLessThan(idx("generate_ovpn"));
  });

  it("marks issue_cert — and only issue_cert — as a human gate", () => {
    expect(PROVISIONING_STEPS.filter((s) => s.gate === "human").map((s) => s.id)).toEqual(["issue_cert"]);
  });

  it("has unique step ids", () => {
    const ids = PROVISIONING_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("nextStep / progress", () => {
  it("starts at the first step", () => {
    expect(nextStep(emptyProvisioningState())?.id).toBe("validate_slug");
  });

  it("returns null and reports complete when everything is done", () => {
    const all = { completed: PROVISIONING_STEPS.map((s) => s.id), lastError: null };
    expect(nextStep(all)).toBeNull();
    expect(isComplete(all)).toBe(true);
  });

  it("resumes at the earliest incomplete step after a partial failure", () => {
    // Holes matter: a run that failed midway must not skip ahead.
    const state: ProvisioningState = { completed: ["validate_slug", "allocate_subnet"], lastError: null };
    expect(nextStep(state)?.id).toBe("create_tenant");
  });

  it("counts progress", () => {
    expect(progress(stateUpTo("issue_cert"))).toEqual({ completed: 6, total: PROVISIONING_STEPS.length });
  });
});

// ============================================================================
// Gate 1 — the human cert gate. The plan: "This plan does not attempt to work
// around it."
// ============================================================================
describe("the cert gate is human and cannot be bypassed", () => {
  it("blocks at issue_cert while the certificate is absent", () => {
    const v = canAdvance(stateUpTo("issue_cert"), prereqs({ certPresent: false }));
    expect(v.ok).toBe(false);
    if (v.ok || !("blocked" in v)) throw new Error("expected blocked");
    expect(v.step.id).toBe("issue_cert");
    expect(v.reason).toMatch(/passphrase-protected/);
    expect(v.reason).toMatch(/signed by hand on purpose/);
    expect(v.reason).toMatch(/CA signing flow v2/);
  });

  it("advances past the gate only once the operator has produced the cert", () => {
    const v = canAdvance(stateUpTo("issue_cert"), prereqs({ certPresent: true }));
    expect(v.ok).toBe(true);
  });

  it("never describes the gate as an error or an outage", () => {
    const v = canAdvance(stateUpTo("issue_cert"), prereqs({ certPresent: false }));
    if (v.ok || !("blocked" in v)) throw new Error("expected blocked");
    expect(v.reason).not.toMatch(/fail|error|broken/i);
  });
});

// ============================================================================
// Gate 2 — the G2 tunnel prerequisite.
// ============================================================================
describe("no provisioning past cert issuance without a real handshake", () => {
  it.each<ProvisioningStepId>([
    "write_ccd",
    "firewall_rules",
    "generate_ovpn",
    "telephony_namespace",
    "invite_tenant_admin",
  ])("blocks %s when the tunnel has never handshaked", (id) => {
    const v = canAdvance(stateUpTo(id), prereqs({ tunnelHandshakeAt: null }));
    expect(v.ok).toBe(false);
    if (v.ok || !("blocked" in v)) throw new Error("expected blocked");
    expect(v.reason).toMatch(/No OpenVPN handshake/);
    expect(v.reason).toMatch(/handoff\.md G2/);
  });

  it.each<ProvisioningStepId>([
    "validate_slug",
    "create_tenant",
    "allocate_subnet",
    "create_gateway_site",
    "allocate_subdomain",
    "compliance_checklist",
  ])("still allows the pre-cert step %s with no handshake", (id) => {
    // The whole point: a tenant can be created and allocated today, on the
    // unproven tunnel, without pretending the tunnel works.
    expect(canAdvance(stateUpTo(id), prereqs({ tunnelHandshakeAt: null })).ok).toBe(true);
  });

  it("lets the cert gate itself be reached with no handshake", () => {
    const v = canAdvance(stateUpTo("issue_cert"), prereqs({ tunnelHandshakeAt: null, certPresent: true }));
    expect(v.ok).toBe(true);
  });
});

// ============================================================================
// Gate 3 — the per-tenant subnet scheme, off by default.
// ============================================================================
describe("per-tenant subnet steps are gated on the owner-only flag", () => {
  it.each<ProvisioningStepId>(["write_ccd", "firewall_rules"])("blocks %s when the scheme is off", (id) => {
    const v = canAdvance(stateUpTo(id), prereqs({ perTenantSubnetEnabled: false }));
    expect(v.ok).toBe(false);
    if (v.ok || !("blocked" in v)) throw new Error("expected blocked");
    expect(v.reason).toMatch(/10\.8\.0\.0\/16/);
    expect(v.reason).toMatch(/finish G2 on the current \/24 first/);
    expect(v.reason).toMatch(/Platform Settings/);
  });

  it("allows them once an owner enables the scheme", () => {
    expect(canAdvance(stateUpTo("write_ccd"), prereqs({ perTenantSubnetEnabled: false })).ok).toBe(false);
    expect(canAdvance(stateUpTo("write_ccd"), prereqs({ perTenantSubnetEnabled: true })).ok).toBe(true);
  });

  it("does not gate generate_ovpn on the subnet scheme", () => {
    expect(canAdvance(stateUpTo("generate_ovpn"), prereqs({ perTenantSubnetEnabled: false })).ok).toBe(true);
  });

  it("reports the tunnel block ahead of the subnet block when both apply", () => {
    // The handshake is the more fundamental blocker; naming it first stops an
    // operator flipping the subnet flag hoping it will unstick things.
    const v = canAdvance(
      stateUpTo("write_ccd"),
      prereqs({ tunnelHandshakeAt: null, perTenantSubnetEnabled: false })
    );
    if (v.ok || !("blocked" in v)) throw new Error("expected blocked");
    expect(v.reason).toMatch(/No OpenVPN handshake/);
  });
});

describe("state transitions", () => {
  it("completes a step and clears the last error", () => {
    const failed = failStep(emptyProvisioningState(), "validate_slug", "slug taken");
    expect(failed.lastError).toEqual({ step: "validate_slug", message: "slug taken" });
    const fixed = completeStep(failed, "validate_slug");
    expect(fixed.completed).toEqual(["validate_slug"]);
    expect(fixed.lastError).toBeNull();
  });

  it("is idempotent — a retried confirmation does not duplicate the step", () => {
    const once = completeStep(emptyProvisioningState(), "validate_slug");
    const twice = completeStep(once, "validate_slug");
    expect(twice.completed).toEqual(["validate_slug"]);
  });

  it("does not mutate the previous state", () => {
    const before = emptyProvisioningState();
    completeStep(before, "validate_slug");
    expect(before.completed).toEqual([]);
  });

  it("rejects an unknown step id rather than silently recording it", () => {
    expect(() => completeStep(emptyProvisioningState(), "nope" as ProvisioningStepId)).toThrow(/Unknown/);
    expect(() => stepSpec("nope" as ProvisioningStepId)).toThrow(/Unknown/);
  });

  it("reports done when the pipeline is finished", () => {
    const all = { completed: PROVISIONING_STEPS.map((s) => s.id), lastError: null };
    const v = canAdvance(all, prereqs());
    expect(v).toEqual({ ok: false, done: true });
  });
});
