import { describe, expect, it, vi } from "vitest";
import { runFailoverForTenant, selectPrimarySite, type FailoverDeps, type FailoverSite, type FailoverTenant } from "./failover";
import type { CutoverResult } from "@/lib/dinstar/site-cutover";

// Pure selection + orchestration tests only — cutoverToSite and the AMI
// client are always mocked via injected FailoverDeps, never real
// infrastructure, per this task's brief.

function site(overrides: Partial<FailoverSite> & { id: string }): FailoverSite {
  return {
    priority: 100,
    enabled: true,
    status: "UP",
    lastHandshakeAt: new Date(),
    lastFailoverAt: null,
    tunnelIp: "10.8.0.2",
    gatewayLanIp: "192.168.11.1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function tenant(overrides: Partial<FailoverTenant> = {}): FailoverTenant {
  return { id: "tenant1", activeGatewaySiteId: null, failoverEnabled: true, ...overrides };
}

function makeDeps(overrides: Partial<FailoverDeps> = {}): FailoverDeps {
  return {
    cutoverToSite: vi.fn().mockResolvedValue({ ok: true, settingUpdated: true, provision: { verified: true } } as CutoverResult),
    hasActiveTrunkCall: vi.fn().mockResolvedValue(false),
    recordSuccessfulFailover: vi.fn().mockResolvedValue(undefined),
    recordFailedFailover: vi.fn().mockResolvedValue(undefined),
    sendFailoverAlert: vi.fn().mockResolvedValue(undefined),
    now: () => new Date("2026-09-07T12:00:00Z"),
    ...overrides,
  };
}

const NOW = new Date("2026-09-07T12:00:00Z");
const FRESH = new Date(NOW.getTime() - 60_000); // 1 minute ago
const STALE = new Date(NOW.getTime() - 5 * 60_000); // 5 minutes ago

describe("selectPrimarySite", () => {
  it("picks the lowest-priority enabled UP-and-fresh site among several candidates", () => {
    const sites = [
      site({ id: "a", priority: 50, lastHandshakeAt: FRESH }),
      site({ id: "b", priority: 10, lastHandshakeAt: FRESH }),
      site({ id: "c", priority: 20, lastHandshakeAt: FRESH }),
    ];
    expect(selectPrimarySite(sites, NOW)?.id).toBe("b");
  });

  it("breaks priority ties by createdAt ascending", () => {
    const sites = [
      site({ id: "newer", priority: 10, lastHandshakeAt: FRESH, createdAt: new Date("2026-02-01") }),
      site({ id: "older", priority: 10, lastHandshakeAt: FRESH, createdAt: new Date("2026-01-01") }),
    ];
    expect(selectPrimarySite(sites, NOW)?.id).toBe("older");
  });

  it("treats a stale handshake as not-a-candidate even if status is UP", () => {
    const sites = [site({ id: "a", priority: 10, status: "UP", lastHandshakeAt: STALE })];
    expect(selectPrimarySite(sites, NOW)).toBeNull();
  });

  it("ignores disabled sites", () => {
    const sites = [site({ id: "a", priority: 10, enabled: false, lastHandshakeAt: FRESH })];
    expect(selectPrimarySite(sites, NOW)).toBeNull();
  });

  it("returns null when no site qualifies at all", () => {
    const sites = [site({ id: "a", status: "DOWN", lastHandshakeAt: FRESH })];
    expect(selectPrimarySite(sites, NOW)).toBeNull();
  });
});

describe("runFailoverForTenant", () => {
  it("no candidate at all is a no-op", async () => {
    const deps = makeDeps();
    const sites = [site({ id: "a", status: "DOWN" })];
    const result = await runFailoverForTenant(tenant(), sites, "actor1", deps);
    expect(result).toEqual({ type: "no_candidate" });
    expect(deps.cutoverToSite).not.toHaveBeenCalled();
  });

  it("does nothing when the primary is already the active site", async () => {
    const deps = makeDeps();
    const sites = [site({ id: "a", priority: 10, lastHandshakeAt: FRESH })];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "a" }), sites, "actor1", deps);
    expect(result).toEqual({ type: "already_active", primaryId: "a" });
    expect(deps.cutoverToSite).not.toHaveBeenCalled();
  });

  it("never calls cutoverToSite when failoverEnabled is false", async () => {
    const deps = makeDeps();
    const sites = [site({ id: "a", priority: 10, lastHandshakeAt: FRESH })];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b", failoverEnabled: false }), sites, "actor1", deps);
    expect(result).toEqual({ type: "failover_disabled", primaryId: "a" });
    expect(deps.cutoverToSite).not.toHaveBeenCalled();
  });

  it("suppresses a failover within the 10-minute cooldown window", async () => {
    const deps = makeDeps();
    const sites = [
      site({ id: "a", priority: 10, lastHandshakeAt: FRESH, lastFailoverAt: new Date(NOW.getTime() - 5 * 60_000) }),
    ];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), sites, "actor1", deps);
    expect(result).toEqual({ type: "cooldown", primaryId: "a" });
    expect(deps.cutoverToSite).not.toHaveBeenCalled();
  });

  it("allows a failover once the cooldown window has passed", async () => {
    const deps = makeDeps();
    const sites = [
      site({ id: "a", priority: 10, lastHandshakeAt: FRESH, lastFailoverAt: new Date(NOW.getTime() - 11 * 60_000) }),
    ];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), sites, "actor1", deps);
    expect(result.type).toBe("cutover_succeeded");
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1);
  });

  it("suppresses a failover while a call is in progress on the trunk (AMI mocked)", async () => {
    const deps = makeDeps({ hasActiveTrunkCall: vi.fn().mockResolvedValue(true) });
    const sites = [site({ id: "a", priority: 10, lastHandshakeAt: FRESH })];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), sites, "actor1", deps);
    expect(result).toEqual({ type: "call_in_progress", primaryId: "a" });
    expect(deps.cutoverToSite).not.toHaveBeenCalled();
  });

  it("calls cutoverToSite and records success + sends an alert when every guard passes", async () => {
    const deps = makeDeps();
    const sites = [site({ id: "a", priority: 10, lastHandshakeAt: FRESH })];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), sites, "actor1", deps);
    expect(result).toEqual({ type: "cutover_succeeded", primaryId: "a", fromSiteId: "b" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1);
    expect(deps.recordSuccessfulFailover).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant1", actorId: "actor1", fromSiteId: "b", toSiteId: "a", verified: true })
    );
    expect(deps.sendFailoverAlert).toHaveBeenCalledTimes(1);
    expect(deps.recordFailedFailover).not.toHaveBeenCalled();
  });

  it("records a failure and does not send the success alert when cutoverToSite fails", async () => {
    const deps = makeDeps({
      cutoverToSite: vi.fn().mockResolvedValue({ ok: false, settingUpdated: false, error: "boom" } as CutoverResult),
    });
    const sites = [site({ id: "a", priority: 10, lastHandshakeAt: FRESH })];
    const result = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), sites, "actor1", deps);
    expect(result).toEqual({ type: "cutover_failed", primaryId: "a", error: "boom" });
    expect(deps.recordFailedFailover).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant1", actorId: "actor1", toSiteId: "a", error: "boom" })
    );
    expect(deps.recordSuccessfulFailover).not.toHaveBeenCalled();
    expect(deps.sendFailoverAlert).not.toHaveBeenCalled();
  });

  it("fail-back is never automatic: the original (better-priority) site being merely UP-in-status without a fresh handshake never triggers a second cutover once a lower-priority site is already active", async () => {
    const deps = makeDeps();
    // Round 1: site "a" (priority 10) is the only fresh candidate and
    // becomes primary; site "b" (priority 5, better-ranked) is stale.
    const staleB = site({ id: "b", priority: 5, status: "UP", lastHandshakeAt: STALE });
    const freshA = site({ id: "a", priority: 10, lastHandshakeAt: FRESH });
    const firstRun = await runFailoverForTenant(tenant({ activeGatewaySiteId: null }), [staleB, freshA], "actor1", deps);
    expect(firstRun).toEqual({ type: "cutover_succeeded", primaryId: "a", fromSiteId: null });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1);

    // Round 2: "b" is still stale (has not itself come back with a fresh
    // handshake — no dedicated "did the old primary recover" check exists
    // in this module at all, deliberately, per plan §3.2 point 4). "a" is
    // now the tenant's active site. selectPrimarySite() still returns "a"
    // (the only fresh candidate), so this is just `already_active` — no
    // fail-back mechanism fired, and no second cutover happened.
    const secondRun = await runFailoverForTenant(
      tenant({ activeGatewaySiteId: "a" }),
      [staleB, site({ id: "a", priority: 10, lastHandshakeAt: FRESH })],
      "actor1",
      deps
    );
    expect(secondRun).toEqual({ type: "already_active", primaryId: "a" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1); // still just the one from round 1
  });

  it("fail-back is not automatic even when the original primary genuinely recovers: A fails, cutover to B, A comes back fresh on the next tick, no second cutover fires and the tenant stays on B", async () => {
    const deps = makeDeps();

    // Tick 1: A (priority 1, the tenant's current active site) has gone
    // stale/unhealthy. B (priority 2) is healthy. Trunk should move to B.
    const staleA1 = site({ id: "a", priority: 1, status: "UP", lastHandshakeAt: STALE });
    const freshB1 = site({ id: "b", priority: 2, lastHandshakeAt: FRESH });
    const tick1 = await runFailoverForTenant(tenant({ activeGatewaySiteId: "a" }), [staleA1, freshB1], "actor1", deps);
    expect(tick1).toEqual({ type: "cutover_succeeded", primaryId: "b", fromSiteId: "a" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1);

    // Tick 2: A is fresh/healthy again (its handshake recovered), B is
    // still active per the tenant record and still healthy too. Even
    // though A is the better-priority site, the trunk must NOT move back
    // automatically — only a human "Cut over now" click may do that.
    const freshA2 = site({ id: "a", priority: 1, status: "UP", lastHandshakeAt: FRESH });
    const freshB2 = site({ id: "b", priority: 2, lastHandshakeAt: FRESH, lastFailoverAt: new Date(NOW.getTime() - 20 * 60_000) });
    const tick2 = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), [freshA2, freshB2], "actor1", deps);
    expect(tick2).toEqual({ type: "already_active", primaryId: "b" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1); // still just the tick-1 cutover
  });

  it("cooldown is scoped per tenant, not per candidate site: two sites flapping in sequence within the cooldown window produce only one cutover total", async () => {
    const deps = makeDeps();

    // Tick 1: active site "a" is down, "b" is the only healthy candidate.
    // Cutover to b succeeds and stamps b.lastFailoverAt.
    const downA1 = site({ id: "a", priority: 1, status: "DOWN", lastHandshakeAt: null });
    const freshB1 = site({ id: "b", priority: 2, lastHandshakeAt: FRESH });
    const tick1 = await runFailoverForTenant(tenant({ activeGatewaySiteId: "a" }), [downA1, freshB1], "actor1", deps);
    expect(tick1).toEqual({ type: "cutover_succeeded", primaryId: "b", fromSiteId: "a" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1);

    // Tick 2 (5 minutes later, still inside the 10-minute window): the
    // active site "b" has now itself gone unhealthy, and a THIRD site
    // "c" is healthy. Naively, c's own `lastFailoverAt` is null (it has
    // never itself been a cutover target), so a per-site cooldown check
    // would let this through. The tenant-scoped cooldown must still block
    // it, because b's cutover (from tick 1) happened within the window.
    const downB2 = site({ id: "b", priority: 2, status: "DOWN", lastHandshakeAt: null, lastFailoverAt: new Date(NOW.getTime() - 5 * 60_000) });
    const freshC2 = site({ id: "c", priority: 3, lastHandshakeAt: FRESH, lastFailoverAt: null });
    const tick2 = await runFailoverForTenant(tenant({ activeGatewaySiteId: "b" }), [downB2, freshC2], "actor1", deps);
    expect(tick2).toEqual({ type: "cooldown", primaryId: "c" });
    expect(deps.cutoverToSite).toHaveBeenCalledTimes(1); // still just the one from tick 1
  });
});
