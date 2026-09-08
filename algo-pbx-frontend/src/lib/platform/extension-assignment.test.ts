import { describe, it, expect } from "vitest";
import { canAssignExtension, canUnassignExtension } from "./extension-assignment";

describe("canAssignExtension", () => {
  it("allows assignment when the user is free and tenants match", () => {
    expect(
      canAssignExtension({
        extensionTenantId: "t1",
        userTenantId: "t1",
        userExistingExtensionId: null,
        targetExtensionId: "ext1",
      })
    ).toEqual({ ok: true });
  });

  it("allows re-assigning a user to the extension they already hold (no-op)", () => {
    expect(
      canAssignExtension({
        extensionTenantId: "t1",
        userTenantId: "t1",
        userExistingExtensionId: "ext1",
        targetExtensionId: "ext1",
      })
    ).toEqual({ ok: true });
  });

  it("rejects a cross-tenant assignment", () => {
    const verdict = canAssignExtension({
      extensionTenantId: "t1",
      userTenantId: "t2",
      userExistingExtensionId: null,
      targetExtensionId: "ext1",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/same tenant/);
  });

  it("rejects assigning a user who already holds a different extension", () => {
    const verdict = canAssignExtension({
      extensionTenantId: "t1",
      userTenantId: "t1",
      userExistingExtensionId: "ext-other",
      targetExtensionId: "ext1",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/already holds a different extension/);
  });
});

describe("canUnassignExtension", () => {
  it("allows unassigning when a user is assigned", () => {
    expect(canUnassignExtension({ hasAssignedUser: true })).toEqual({ ok: true });
  });

  it("rejects unassigning when nobody is assigned", () => {
    const verdict = canUnassignExtension({ hasAssignedUser: false });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toMatch(/no assigned user/);
  });
});
