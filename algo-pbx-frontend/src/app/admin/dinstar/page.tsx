"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "@/lib/client/api";

interface DiscoveredHost {
  ip: string;
  fingerprint: "dinstar" | "unknown-http";
  authStyle: "basic" | "query" | "unknown";
}
type ProbeFailureReason = "timeout" | "refused" | "no-route" | "unknown";
interface DiscoveryResult {
  hosts: DiscoveredHost[];
  scannedCount: number;
  reasonCounts: Record<ProbeFailureReason, number>;
}

// Actionable copy per failure mode, shown when a scan finds nothing —
// replaces a flat "no devices found" that gave a non-technical operator
// no way to tell "nothing's there" from "the network is broken".
function reasonHint(reasonCounts: Record<ProbeFailureReason, number>, scannedCount: number): string | null {
  if (scannedCount === 0) return null;
  const dominant = (Object.entries(reasonCounts) as [ProbeFailureReason, number][]).sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] === 0) return null;
  const [reason, count] = dominant;
  const frac = `${count}/${scannedCount}`;
  switch (reason) {
    case "timeout":
      return `${frac} hosts timed out — most likely the Tailscale subnet route to the office isn't approved yet, or is approved but not reaching this host. Check "tailscale status" and the route-approval step in DEPLOYMENT.md before assuming there's no gateway here.`;
    case "no-route":
      return `${frac} hosts were unreachable (no route) — this host has no network path to that range at all. Check the Tailscale subnet route is up, not just approved.`;
    case "refused":
      return `${frac} hosts actively refused the connection — the network path works, but nothing Dinstar-shaped is listening on port 80 at those addresses. Double-check the CIDR.`;
    default:
      return `${frac} hosts failed for an unclassified reason — try again, or enter the IP manually.`;
  }
}
interface DinstarPort {
  port: number;
  type: string | null;
  simPresent: boolean;
}
interface ProbeResult {
  reachable: boolean;
  authenticated: boolean;
  authStyle: "basic" | "query" | null;
  ports: DinstarPort[];
  error?: string;
}
interface ApplyResult {
  probe: ProbeResult;
  asterisk: { attempted: boolean; written?: boolean; reloaded?: boolean; verified?: boolean; error?: string };
}

type Step = "find" | "signin" | "confirm" | "link" | "done";

// Dinstar setup wizard — full automation with a manual override at every
// step, for the non-technical operator this was named for. Five steps:
// find the device (subnet scan) -> sign in (credential probe, both known
// auth styles tried) -> confirm SIM ports -> link to Asterisk (rewrite +
// reload pjsip_dinstar.conf, then VERIFY the reload actually took, not
// just assume it did) -> done. Each step has a manual-entry fallback.
export default function DinstarWizardPage() {
  const [step, setStep] = useState<Step>("find");

  // Default matches this office's actual Dinstar segment (192.168.11.0/24,
  // wired directly to the PBX host for local testing) — a stale
  // 192.168.1.0/24 default here was the actual root cause of "Dinstar scan
  // finds nothing" (the gateway was never on that subnet), independent of
  // the separate Tailscale-route gap. Real deployments with a different
  // subnet just type over this.
  const [cidr, setCidr] = useState("192.168.11.0/24");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [scanReasonHint, setScanReasonHint] = useState<string | null>(null);
  const [manualHost, setManualHost] = useState(false);

  const [host, setHost] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  // The gateway's OWN local SIP port (not Asterisk's). Defaults to 5060,
  // but the UC2000 refuses a trunk peer whose port equals its own local
  // port, so any office where Asterisk also binds 5060 must move this
  // (this office uses 5061) — see settings/schema.ts's DINSTAR_SIP_PORT.
  const [sipPort, setSipPort] = useState("5060");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [hotline, setHotline] = useState("100");
  const [portsApplying, setPortsApplying] = useState(false);
  const [portsResult, setPortsResult] = useState<{ ok: boolean; ports?: number[] } | null>(null);
  const [portsError, setPortsError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    setScanReasonHint(null);
    try {
      const data = await apiFetch<DiscoveryResult>("/api/admin/dinstar/discover", { method: "POST", body: { cidr } });
      setHosts(data.hosts);
      if (data.hosts.length === 0) {
        setManualHost(true);
        setScanReasonHint(reasonHint(data.reasonCounts, data.scannedCount));
      }
    } catch (err) {
      setScanError(err instanceof ApiError ? err.message : "Scan failed.");
      setManualHost(true);
    } finally {
      setScanning(false);
    }
  };

  const signIn = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const data = await apiFetch<ProbeResult>("/api/admin/dinstar/probe", { method: "POST", body: { host, username, password } });
      setProbeResult(data);
      if (data.authenticated) setStep("confirm");
      else setProbeError(data.error ?? "Authentication failed.");
    } catch (err) {
      setProbeError(err instanceof ApiError ? err.message : "Could not reach the gateway.");
    } finally {
      setProbing(false);
    }
  };

  const applyPortConfig = async () => {
    setPortsApplying(true);
    setPortsError(null);
    try {
      const data = await apiFetch<{ ok: boolean; ports: number[] }>("/api/admin/dinstar/ports", {
        method: "POST",
        body: { username, password, hotline },
      });
      setPortsResult(data);
    } catch (err) {
      setPortsError(err instanceof ApiError ? err.message : "Could not apply the port configuration.");
    } finally {
      setPortsApplying(false);
    }
  };

  const link = async (writeAsteriskConfig: boolean) => {
    setApplying(true);
    setApplyError(null);
    try {
      const data = await apiFetch<ApplyResult>("/api/admin/dinstar/apply", {
        method: "POST",
        body: { host, username, password, writeAsteriskConfig, sipPort },
      });
      setApplyResult(data);
      setStep("done");
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "Could not apply settings.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Dinstar Gateway Setup</h1>
      <p className="max-w-2xl text-center text-xs text-tertiary">
        Finds and configures the Dinstar UC2000 SIM gateway automatically. Every step can be entered
        manually if automation doesn&apos;t find what you need.
      </p>
      <p className="text-xs text-tertiary">
        Gateway syslog events (call errors, port/registration state, SIM issues) are on{" "}
        <Link href="/admin/system" className="text-cyan hover:underline">
          System Readiness
        </Link>
        , under &quot;Gateway events.&quot;
      </p>

      <div className="flex gap-2 text-xs text-tertiary">
        {(["find", "signin", "confirm", "link", "done"] as Step[]).map((s, i) => (
          <span key={s} className={step === s ? "text-cyan" : ""}>
            {i > 0 && " → "}
            {s}
          </span>
        ))}
      </div>

      {step === "find" && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">1. Find the device</h2>
          <p className="text-xs text-tertiary">Scans a local network range for a Dinstar-shaped device. Takes 10-20 seconds.</p>
          <input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder="192.168.1.0/24"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <button onClick={scan} disabled={scanning} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {scanning ? "Scanning…" : "Scan network"}
          </button>
          {scanError && <p className="text-xs text-danger">{scanError}</p>}
          {!scanError && scanReasonHint && <p className="text-xs text-warning">{scanReasonHint}</p>}

          {hosts.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border pt-3">
              {hosts.map((h) => (
                <button
                  key={h.ip}
                  onClick={() => {
                    setHost(h.ip);
                    setStep("signin");
                  }}
                  className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-cyan"
                >
                  {h.ip} {h.fingerprint === "dinstar" ? <span className="text-cyan">(looks like a Dinstar)</span> : <span className="text-tertiary">(unknown device)</span>}
                </button>
              ))}
            </div>
          )}

          <button onClick={() => setManualHost(true)} className="text-xs text-tertiary hover:text-primary">
            I&apos;ll enter the IP manually instead
          </button>
          {manualHost && (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.11.1"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
              />
              <button
                onClick={() => setStep("signin")}
                disabled={!host.trim()}
                className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                Continue with {host || "this address"}
              </button>
            </div>
          )}
        </div>
      )}

      {step === "signin" && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">2. Sign in</h2>
          <p className="text-xs text-tertiary">Device: {host}. Tries both known firmware auth styles automatically.</p>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Admin username"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Admin password"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <button onClick={signIn} disabled={probing || !password} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {probing ? "Signing in…" : "Sign in"}
          </button>
          {probeError && <p className="text-xs text-danger">{probeError}</p>}
          <button onClick={() => setStep("find")} className="text-xs text-tertiary hover:text-primary">
            ← Back
          </button>
        </div>
      )}

      {step === "confirm" && probeResult && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">3. Confirm SIM ports</h2>
          <p className="text-xs text-tertiary">
            Signed in via {probeResult.authStyle} auth. {probeResult.ports.length} port(s) reported.
          </p>
          <ul className="flex flex-col gap-1 text-sm text-primary">
            {probeResult.ports.map((p) => (
              <li key={p.port} className="flex justify-between border-t border-border pt-1 first:border-0 first:pt-0">
                <span>Port {p.port + 1}</span>
                <span className={p.simPresent ? "text-success" : "text-tertiary"}>{p.simPresent ? p.type ?? "SIM present" : "no SIM"}</span>
              </li>
            ))}
          </ul>
          <button onClick={() => setStep("link")} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg">
            Continue
          </button>
          <button onClick={() => setStep("signin")} className="text-xs text-tertiary hover:text-primary">
            ← Back
          </button>
        </div>
      )}

      {step === "link" && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">4. Link to Asterisk</h2>
          <p className="text-xs text-tertiary">
            Save these settings, and optionally rewrite the Asterisk trunk config to point at {host} — no more SSH to change the gateway IP.
          </p>
          <label className="flex flex-col gap-1 text-xs text-tertiary">
            Dinstar&apos;s own local SIP port
            <input
              value={sipPort}
              onChange={(e) => setSipPort(e.target.value)}
              placeholder="5060"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
            />
            <span>
              The gateway&apos;s own local SIP port (not Asterisk&apos;s). Default 5060 — but the UC2000 refuses a trunk peer
              whose port equals its own local port, so if Asterisk also binds 5060 on this host, move the Dinstar&apos;s
              local SIP port (e.g. 5061) and enter it here.
            </span>
          </label>
          <button onClick={() => link(true)} disabled={applying} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {applying ? "Applying…" : "Save settings and update Asterisk"}
          </button>
          <button onClick={() => link(false)} disabled={applying} className="rounded-lg border border-border px-4 py-2 text-sm text-secondary disabled:opacity-50">
            Save settings only (I&apos;ll update Asterisk manually)
          </button>
          {applyError && <p className="text-xs text-danger">{applyError}</p>}
        </div>
      )}

      {step === "done" && applyResult && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">5. Done</h2>
          <p className="text-xs text-success">Settings saved — {host} via {applyResult.probe.authStyle} auth.</p>
          {applyResult.asterisk.attempted && (
            <div className="text-xs">
              {applyResult.asterisk.verified ? (
                <p className="text-success">Asterisk trunk updated and verified.</p>
              ) : (
                <p className="text-warning">{applyResult.asterisk.error ?? "Could not verify the Asterisk update."}</p>
              )}
            </div>
          )}
          <div className="rounded-lg border border-border p-3 text-xs text-secondary">
            <p className="mb-1 font-medium text-secondary">Apply standard SIM config</p>
            <p className="mb-2">
              Writes a hotline to every port with real modem hardware on this gateway, so inserting a SIM
              just works — no manual Dinstar UI steps. This writes to the gateway&apos;s admin web UI directly
              (a different login than the SMS API above) and cannot read current values back first — see{" "}
              <span className="text-secondary">Apply</span> below for what it will overwrite.
            </p>
            <label className="mb-2 flex flex-col gap-1">
              To VOIP Hotline value
              <input
                value={hotline}
                onChange={(e) => setHotline(e.target.value)}
                placeholder="100"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
              />
              <span>Matches extensions.conf&apos;s [from-dinstar] handler — &quot;100&quot; or the literal &quot;s&quot; both work.</span>
            </label>
            <button
              onClick={applyPortConfig}
              disabled={portsApplying || !hotline.trim()}
              className="w-full rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {portsApplying ? "Applying…" : "Apply standard SIM config"}
            </button>
            {portsError && <p className="mt-2 text-danger">{portsError}</p>}
            {portsResult?.ok && (
              <p className="mt-2 text-success">
                Applied to port{portsResult.ports && portsResult.ports.length !== 1 ? "s" : ""}{" "}
                {portsResult.ports?.map((p) => p + 1).join(", ")}. Insert a SIM in any of those ports and it
                should register without any further gateway configuration.
              </p>
            )}
          </div>
          <div className="rounded-lg border border-border p-3 text-xs text-secondary">
            <p className="mb-1 font-medium text-secondary">Still manual — configure on the Dinstar itself:</p>
            <ul className="list-disc pl-4">
              <li>Insert SIM cards and any PIN they require (this device only reads SIM presence at power-on, not on hot-insertion — a reboot may be needed)</li>
              <li>Change the gateway&apos;s admin password if it&apos;s still the factory default</li>
            </ul>
          </div>
          <a href="/admin/settings" className="text-xs text-cyan hover:underline">
            View in Settings
          </a>
        </div>
      )}
    </div>
  );
}
