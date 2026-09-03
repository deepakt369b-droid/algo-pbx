"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import type { GatewaySite } from "./site-table";

interface GenerateCertResult {
  ok: boolean;
  error?: string;
}

// Matches src/lib/dinstar/vpn-push.ts's real VpnPushResult shape exactly —
// flat booleans per step plus one shared `error` describing whichever step
// first failed, not a nested per-step result. Credentials are never taken
// from this form: pushVpnConfig() always resolves DINSTAR_WEBUI_USERNAME/
// PASSWORD from settings itself (never hardcoded, never logged) — there is
// no per-request override in the real API, so this wizard doesn't offer one.
interface PushVpnConfigResult {
  loggedIn: boolean;
  pushed: boolean;
  verifiedByReadback: boolean;
  verifiedByPing: boolean | null;
  error?: string;
}

type Step = "create" | "cert" | "deploy" | "done";

// Add-site wizard for /admin/connectivity — same Step-union pattern as
// src/components/telephony/gateway-tab.tsx's Dinstar setup wizard (create
// -> generate-cert -> deploy (download-or-push, both offered together) ->
// done), same manual-fallback-always-visible-alongside-automation
// requirement. Calls Node D's routes as a plain HTTP client — this
// component doesn't know or need to know how cert generation or the VPN
// push actually happen on the wire.
export function AddSiteWizard({ onCreated }: { onCreated: (site: GatewaySite) => void }) {
  const [step, setStep] = useState<Step>("create");

  const [name, setName] = useState("");
  const [gatewayLanIp, setGatewayLanIp] = useState("192.168.11.1");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [site, setSite] = useState<GatewaySite | null>(null);

  const [certBusy, setCertBusy] = useState(false);
  const [certResult, setCertResult] = useState<GenerateCertResult | null>(null);
  const [certError, setCertError] = useState<string | null>(null);

  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState<PushVpnConfigResult | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const nameValid = /^[A-Za-z0-9_-]{1,64}$/.test(name);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const data = await apiFetch<{ site: GatewaySite }>("/api/admin/gateway-sites", {
        method: "POST",
        body: { name, gatewayLanIp },
      });
      setSite(data.site);
      onCreated(data.site);
      setStep("cert");
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create the site.");
    } finally {
      setCreating(false);
    }
  };

  const generateCert = async () => {
    if (!site) return;
    setCertBusy(true);
    setCertError(null);
    try {
      const data = await apiFetch<GenerateCertResult>(`/api/admin/gateway-sites/${site.id}/generate-cert`, { method: "POST" });
      setCertResult(data);
      if (data.ok) setStep("deploy");
      else setCertError(data.error ?? "Certificate generation did not complete.");
    } catch (err) {
      setCertError(err instanceof ApiError ? err.message : "Could not reach the certificate bridge.");
    } finally {
      setCertBusy(false);
    }
  };

  const pushConfig = async () => {
    if (!site) return;
    setPushBusy(true);
    setPushError(null);
    try {
      const data = await apiFetch<PushVpnConfigResult>(`/api/admin/gateway-sites/${site.id}/push-vpn-config`, {
        method: "POST",
      });
      setPushResult(data);
      if (data.verifiedByReadback) setStep("done");
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : "Could not push the configuration to the gateway.");
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex gap-2 text-xs text-tertiary">
        {(["create", "cert", "deploy", "done"] as Step[]).map((s, i) => (
          <span key={s} className={step === s ? "text-cyan" : ""}>
            {i > 0 && " → "}
            {s}
          </span>
        ))}
      </div>

      {step === "create" && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">1. Name the site</h2>
          <p className="text-xs text-tertiary">
            The name becomes the OpenVPN client certificate&apos;s identity — letters, digits, hyphens, and
            underscores only, no spaces.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="uae-office"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          {name.length > 0 && !nameValid && (
            <p className="text-xs text-danger">Only letters, digits, hyphens, and underscores (max 64 chars).</p>
          )}
          <label className="flex flex-col gap-1 text-xs text-tertiary">
            Gateway LAN IP
            <input
              value={gatewayLanIp}
              onChange={(e) => setGatewayLanIp(e.target.value)}
              placeholder="192.168.11.1"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
          </label>
          <button
            onClick={create}
            disabled={creating || !nameValid || !gatewayLanIp.trim()}
            className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create site"}
          </button>
          {createError && <p className="text-xs text-danger">{createError}</p>}
        </div>
      )}

      {step === "cert" && site && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">2. Generate the client certificate</h2>
          <p className="text-xs text-tertiary">
            Requests a client certificate for &quot;{site.name}&quot; from the OpenVPN server&apos;s own PKI — no
            private key material ever passes through this app&apos;s database.
          </p>
          <button
            onClick={generateCert}
            disabled={certBusy}
            className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {certBusy ? "Generating…" : "Generate certificate"}
          </button>
          {certError && <p className="text-xs text-danger">{certError}</p>}
          {certResult && !certResult.ok && (
            <p className="text-xs text-warning">
              Not ready yet — the certificate bridge may still be processing. Try again in a few seconds, or check
              the bridge container&apos;s logs (<code>docker logs algo-openvpn-bridge</code>) if this persists.
            </p>
          )}
        </div>
      )}

      {step === "deploy" && site && (
        <div className="glass-card flex w-full max-w-md flex-col gap-4 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">3. Deploy to the gateway</h2>

          <div className="flex flex-col gap-2 border-b border-border pb-4">
            <p className="text-xs font-medium text-secondary">Option A — download and upload manually</p>
            <p className="text-xs text-tertiary">
              Download the <code>.ovpn</code> file, then on the gateway: <strong>Network Configuration → VPN
              Parameter</strong> → choose the file → check <strong>OpenVPN Enable</strong> → <strong>Save</strong>.
            </p>
            <a
              href={`/api/admin/gateway-sites/${site.id}/download-cert`}
              className="rounded-lg border border-border px-4 py-2 text-center text-sm text-secondary hover:border-cyan hover:text-primary"
            >
              Download {site.name}.ovpn
            </a>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-secondary">Option B — push automatically</p>
            <p className="text-xs text-tertiary">
              Logs into the gateway&apos;s own admin web UI using the saved <code>DINSTAR_WEBUI_USERNAME</code>/
              <code>PASSWORD</code> settings and submits the VPN form directly.
            </p>
            <button
              onClick={pushConfig}
              disabled={pushBusy}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {pushBusy ? "Pushing…" : "Push automatically"}
            </button>
            {pushError && <p className="text-xs text-danger">{pushError}</p>}
            {pushResult && (
              <ul className="flex flex-col gap-1 text-xs">
                <li className={pushResult.loggedIn ? "text-success" : "text-danger"}>
                  Login: {pushResult.loggedIn ? "ok" : "failed"}
                </li>
                <li className={pushResult.pushed ? "text-success" : "text-danger"}>
                  Push: {pushResult.pushed ? "ok" : "failed"}
                </li>
                <li className={pushResult.verifiedByReadback ? "text-success" : "text-danger"}>
                  Verified on gateway: {pushResult.verifiedByReadback ? "ok" : "not confirmed"}
                </li>
                {pushResult.error && <li className="text-danger">{pushResult.error}</li>}
              </ul>
            )}
            {pushResult && !pushResult.verifiedByReadback && (
              <p className="text-xs text-warning">
                If the push doesn&apos;t verify, the gateway&apos;s own <strong>Download Log</strong> button (same
                VPN Parameter page) is the first thing to check — it&apos;s the only visibility into why an old
                embedded OpenVPN client rejected the handshake.
              </p>
            )}
          </div>

          <button onClick={() => setStep("done")} className="text-xs text-tertiary hover:text-primary">
            Skip — I&apos;ll finish this manually
          </button>
        </div>
      )}

      {step === "done" && site && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">4. Done</h2>
          <p className="text-xs text-success">
            &quot;{site.name}&quot; is set up. The connectivity poller will report its live tunnel status here
            within about a minute.
          </p>
          <p className="text-xs text-tertiary">
            The trunk itself stays on Tailscale until the cutover is run — see the runbook below for the full,
            supervised cutover checklist. Nothing here has touched the live call path yet.
          </p>
        </div>
      )}
    </div>
  );
}
