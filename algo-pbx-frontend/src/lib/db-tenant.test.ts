import { describe, expect, it } from "vitest";
import { computeScopedArgs, resolveModelScope } from "@/lib/tenancy/scope-rules";

// Coverage note, read before trusting this file for more than it claims:
//
// This environment has no live Postgres connection (see LLM.md's P2
// section — Postgres is VPS-only, loopback-bound). What follows tests the
// PURE mapping/filter-injection logic in `src/lib/tenancy/scope-rules.ts`
// in complete isolation from Prisma and from a real database — it proves
// the *shape* of the where/data objects `tenantDb()` produces is correct.
//
// It deliberately does NOT and CANNOT cover:
//   - The actual two-tenant collision test the plan (§"Verification")
//     calls "the one that matters": seeding two tenants with colliding
//     extension/contact/queue values through a REAL `tenantDb()` client
//     against a REAL Postgres, and asserting every read only returns the
//     caller's rows. That needs a live DB and belongs in a later,
//     deployment-time wave (see the plan's Verification section and
//     prisma/migrations/20260904120000_add_rls/migration.sql's header).
//   - The RLS path itself: that `SET LOCAL app.tenant_id` really is set
//     before the protected query runs, that it resets between
//     transactions under connection pooling, and that the app's DB role
//     is actually non-superuser/non-BYPASSRLS (Postgres silently no-ops
//     RLS otherwise) — none of that is observable without a real
//     connection. Same file's migration header documents these
//     preconditions in detail.
//   - `db-tenant.ts`'s `$extends` wiring itself (the delegate-name
//     derivation, the transaction wrapper) — that requires a Prisma
//     client instance to exercise meaningfully and is exactly the kind of
//     side-effecting glue this repo's convention (recording-access.ts,
//     queue-status.ts) says to keep thin and let the pure core carry the
//     test weight instead.

describe("resolveModelScope", () => {
  it("classifies a normal tenant-scoped model", () => {
    expect(resolveModelScope("Contact")).toBe("tenant");
    expect(resolveModelScope("CallDetailRecord")).toBe("tenant");
    expect(resolveModelScope("GatewaySite")).toBe("tenant");
  });

  it("classifies AppSetting as nullable-tenant", () => {
    expect(resolveModelScope("AppSetting")).toBe("nullable-tenant");
  });

  it("rejects explicitly platform-global models", () => {
    expect(resolveModelScope("PbxRuntimeFlag")).toBe("reject");
    expect(resolveModelScope("McpApproval")).toBe("reject");
    expect(resolveModelScope("InboundWebhookDelivery")).toBe("reject");
  });

  it("rejects an unknown model rather than defaulting to open access", () => {
    expect(resolveModelScope("SomeBrandNewModelNobodyAddedYet")).toBe("reject");
  });
});

describe("computeScopedArgs — read operations on a normal tenant model", () => {
  it("injects tenantId flat into findUnique's where (extended-where-unique)", () => {
    const result = computeScopedArgs("Contact", "findUnique", { where: { id: "c1" } }, "t1");
    expect(result.where).toEqual({ id: "c1", tenantId: "t1" });
  });

  it("AND-wraps findMany's where so a caller's top-level OR can't be defeated", () => {
    const result = computeScopedArgs(
      "Contact",
      "findMany",
      { where: { OR: [{ numberE164: "+1" }, { numberE164: "+2" }] } },
      "t1"
    );
    expect(result.where).toEqual({
      AND: [{ OR: [{ numberE164: "+1" }, { numberE164: "+2" }] }, { tenantId: "t1" }],
    });
  });

  it("handles a missing where by injecting an empty base", () => {
    const result = computeScopedArgs("Contact", "findMany", {}, "t1");
    expect(result.where).toEqual({ AND: [{}, { tenantId: "t1" }] });
  });

  it("scopes count/aggregate/groupBy the same way as findMany", () => {
    for (const operation of ["count", "aggregate", "groupBy"]) {
      const result = computeScopedArgs(operation === "count" ? "Contact" : "Deal", operation, { where: { x: 1 } }, "t1");
      expect(result.where).toEqual({ AND: [{ x: 1 }, { tenantId: "t1" }] });
    }
  });

  it("scopes updateMany/deleteMany as AND-wrapped filters", () => {
    const upd = computeScopedArgs("Contact", "updateMany", { where: { x: 1 }, data: { y: 2 } }, "t1");
    expect(upd.where).toEqual({ AND: [{ x: 1 }, { tenantId: "t1" }] });
    expect(upd.data).toEqual({ y: 2 });

    const del = computeScopedArgs("Contact", "deleteMany", { where: { x: 1 } }, "t1");
    expect(del.where).toEqual({ AND: [{ x: 1 }, { tenantId: "t1" }] });
  });

  it("flat-merges update/delete's unique where", () => {
    const upd = computeScopedArgs("Contact", "update", { where: { id: "c1" }, data: { name: "x" } }, "t1");
    expect(upd.where).toEqual({ id: "c1", tenantId: "t1" });

    const del = computeScopedArgs("Contact", "delete", { where: { id: "c1" } }, "t1");
    expect(del.where).toEqual({ id: "c1", tenantId: "t1" });
  });
});

describe("computeScopedArgs — write operations on a normal tenant model", () => {
  it("force-injects tenantId into create, overriding any caller-supplied value", () => {
    const result = computeScopedArgs(
      "Contact",
      "create",
      { data: { name: "Acme", tenantId: "attacker-controlled" } },
      "t1"
    );
    expect(result.data).toEqual({ name: "Acme", tenantId: "t1" });
  });

  it("injects tenantId into every row of createMany", () => {
    const result = computeScopedArgs(
      "Contact",
      "createMany",
      { data: [{ name: "A" }, { name: "B", tenantId: "other" }] },
      "t1"
    );
    expect(result.data).toEqual([
      { name: "A", tenantId: "t1" },
      { name: "B", tenantId: "t1" },
    ]);
  });

  it("upsert scopes where+create but leaves update's field data alone", () => {
    const result = computeScopedArgs(
      "Contact",
      "upsert",
      {
        where: { id: "c1" },
        create: { name: "new", tenantId: "attacker" },
        update: { name: "updated" },
      },
      "t1"
    );
    expect(result.where).toEqual({ id: "c1", tenantId: "t1" });
    expect(result.create).toEqual({ name: "new", tenantId: "t1" });
    expect(result.update).toEqual({ name: "updated" });
  });
});

describe("computeScopedArgs — AppSetting's nullable-tenant special case", () => {
  it("read filters relax to (mine OR platform-global) instead of strict equality", () => {
    const result = computeScopedArgs("AppSetting", "findMany", { where: { key: "DINSTAR_LAN_IP" } }, "t1");
    expect(result.where).toEqual({
      AND: [{ key: "DINSTAR_LAN_IP" }, { OR: [{ tenantId: "t1" }, { tenantId: null }] }],
    });
  });

  it("leaves a unique-key (compound tenantId_key) where untouched", () => {
    // The caller already spells out which row it wants — tenant override
    // (tenantId: "t1") or platform default (tenantId: null) — via the
    // compound unique key itself. Rewriting it here would fight the
    // caller instead of protecting them; see scope-rules.ts's doc comment.
    const result = computeScopedArgs(
      "AppSetting",
      "findUnique",
      { where: { tenantId_key: { tenantId: null, key: "RESEND_API_KEY" } } },
      "t1"
    );
    expect(result.where).toEqual({ tenantId_key: { tenantId: null, key: "RESEND_API_KEY" } });
  });

  it("still force-sets tenantId on create/upsert.create — never writes a platform-default row", () => {
    const created = computeScopedArgs(
      "AppSetting",
      "create",
      { data: { key: "CRM_WEBHOOK_SECRET", value: "x", tenantId: null } },
      "t1"
    );
    expect(created.data).toEqual({ key: "CRM_WEBHOOK_SECRET", value: "x", tenantId: "t1" });
  });
});

describe("computeScopedArgs — loud failure cases", () => {
  it("throws for a platform-global model", () => {
    expect(() => computeScopedArgs("PbxRuntimeFlag", "findMany", {}, "t1")).toThrow(/not on the tenant-scoped/);
  });

  it("throws for an unrecognized model", () => {
    expect(() => computeScopedArgs("NotARealModel", "findMany", {}, "t1")).toThrow(/not on the tenant-scoped/);
  });

  it("throws for an empty tenantId rather than silently scoping to nothing/everything", () => {
    expect(() => computeScopedArgs("Contact", "findMany", {}, "")).toThrow(/empty tenantId/);
  });

  it("throws for an operation with no known tenancy rule", () => {
    expect(() => computeScopedArgs("Contact", "someFutureOperation", {}, "t1")).toThrow(/no tenancy rule/);
  });
});
