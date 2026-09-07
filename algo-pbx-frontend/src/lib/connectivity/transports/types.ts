import type { GatewaySite, SiteTransport } from "@prisma/client";
import type { SiteCriticalAlertType } from "@/lib/dinstar/gateway-alerts";

// The transport registry's shared contract (W2 — connectivity plan §3.2).
// Turns the connectivity-check route's inline `switch` into "a fifth
// transport is a file, not a patch": each file under this directory
// exports one `TransportModule`, and `registry.ts` maps
// `SiteTransport -> TransportModule` for `checkSite()` to dispatch
// through.

/** Mirrors the connectivity-check route's own `CheckResult` shape (kept
 * distinct rather than importing that route's local interface — routes
 * are not meant to be imported from, this is the module boundary
 * `checkSite()` now sits behind). `status`/`lastHandshakeAt`/
 * `lastReachableAt` are exactly what `GatewaySite` gets updated with;
 * `alertType` is what `maybeSendAlert()`/audit-log writing key off of.
 * `note` is optional additional context for states with no dedicated
 * column to hold it (e.g. Headscale's "not checked, no API key
 * configured") — surfaced only in the connectivity-check response payload
 * and never persisted. */
export interface ProbeResult {
  status: "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";
  lastHandshakeAt: Date | null;
  lastReachableAt: Date | null;
  alertType: SiteCriticalAlertType | null;
  note?: string;
}

/** Extra per-run context a probe may need that isn't a column on
 * `GatewaySite` itself — the OpenVPN status-log contents (read once per
 * poller run, not per site) and the run's `now`. Optional: a transport
 * that needs neither (Tailscale, WireGuard) can ignore it entirely, which
 * is why `probe()`'s signature keeps this as a second, optional
 * parameter rather than forcing every site row to carry it. */
export interface ProbeContext {
  /** Raw contents of the OpenVPN status-version-2 log, or null if it
   * could not be read this run. Only OPENVPN's probe uses this. */
  statusLogContent: string | null;
  now: Date;
}

/** One transport's full behavior: what a stored `configEncrypted` blob
 * must look like for this transport, and how to check whether a site is
 * currently reachable. `kind` is redundant with the registry's own key
 * (useful for a transport module handed around without its map key, e.g.
 * in a test). */
export interface TransportModule {
  kind: SiteTransport;
  /** Structural validation of a transport-specific config blob BEFORE it
   * is encrypted and stored in `GatewaySite.configEncrypted` — e.g.
   * WireGuard's `[Interface]`/`[Peer]` shape. Transports needing no
   * stored config (Tailscale, OpenVPN — whose config lives in the
   * OpenVPN bridge's own PKI, not this app) accept `undefined`/`null` as
   * valid. Pure — no I/O, no throwing; failures are reported via the
   * returned `{ok:false, error}`, never an exception, so a bad paste in
   * the UI is a form error, not a 500. */
  validateConfig(config: unknown): { ok: boolean; error?: string };
  /** Checks the site's current reachability. Never throws — any internal
   * failure (network error, missing settings, HTTP error from a remote
   * API) must be caught internally and reported as `status: "UNKNOWN"`,
   * matching this repo's existing "never silently report UP/DOWN without
   * a real check behind it" convention (see the pre-registry
   * `checkHeadscaleNodeOnline()` comment this replaces). */
  probe(site: GatewaySite, ctx: ProbeContext): Promise<ProbeResult>;
}
