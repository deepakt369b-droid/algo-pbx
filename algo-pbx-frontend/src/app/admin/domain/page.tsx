"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail" | "unknown";
  detail: string;
  hint?: string;
  checkedAt: string;
}

const STATUS_STYLE: Record<HealthCheck["status"], { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-green-400", text: "text-green-400", label: "OK" },
  warn: { dot: "bg-yellow-400", text: "text-yellow-400", label: "Warning" },
  fail: { dot: "bg-red-400", text: "text-red-400", label: "Failing" },
  unknown: { dot: "bg-slate-500", text: "text-slate-500", label: "Unknown" },
};

const REFRESH_INTERVAL_MS = 15000;

// A persistent checklist, not a modal stepper — operators alt-tab to
// GoDaddy/Cloudflare mid-flow and need to come back without losing state,
// so every step's current status lives server-side (AppSetting + live
// checks), not in component state. This is the "why is this stuck"
// answer this whole page exists to replace: the old flow's only feedback
// was "go read `docker logs algo-caddy`".
export default function DomainWizardPage() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [overall, setOverall] = useState<HealthCheck["status"]>("unknown");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [detectedIp, setDetectedIp] = useState<string | null>(null);
  const [manualIp, setManualIp] = useState("");
  const [writingRecord, setWritingRecord] = useState(false);
  const [recordMessage, setRecordMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadStatus = async () => {
    setRefreshing(true);
    try {
      const data = await apiFetch<{ checks: HealthCheck[]; overall: HealthCheck["status"] }>("/api/admin/domain/status");
      setChecks(data.checks);
      setOverall(data.overall);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.message : "Could not load domain status.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadStatus();
    apiFetch<{ ip: string }>("/api/admin/domain/ip")
      .then((d) => setDetectedIp(d.ip))
      .catch(() => setDetectedIp(null));
    const interval = setInterval(loadStatus, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const saveDomain = async () => {
    if (!domain.trim()) return;
    setSavingDomain(true);
    setSaveMessage(null);
    try {
      await apiFetch("/api/admin/settings", { method: "PATCH", body: { key: "VM_PUBLIC_DOMAIN", value: domain.trim() } });
      setSaveMessage("Domain saved.");
      await loadStatus();
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : "Could not save domain.");
    } finally {
      setSavingDomain(false);
    }
  };

  const saveToken = async () => {
    if (!token.trim()) return;
    setSavingToken(true);
    setSaveMessage(null);
    try {
      await apiFetch("/api/admin/settings", { method: "PATCH", body: { key: "CLOUDFLARE_API_TOKEN", value: token.trim() } });
      setToken("");
      setSaveMessage("Token saved.");
      await loadStatus();
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : "Could not save token.");
    } finally {
      setSavingToken(false);
    }
  };

  const writeARecord = async () => {
    const ip = manualIp.trim() || detectedIp;
    if (!ip) return;
    setWritingRecord(true);
    setRecordMessage(null);
    try {
      const data = await apiFetch<{ message: string }>("/api/admin/domain/a-record", { method: "POST", body: { ip } });
      setRecordMessage({ ok: true, text: data.message });
      await loadStatus();
    } catch (err) {
      setRecordMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not write the A record." });
    } finally {
      setWritingRecord(false);
    }
  };

  const applyDomain = async () => {
    setApplying(true);
    setApplyMessage(null);
    try {
      const data = await apiFetch<{ message: string }>("/api/admin/settings/domain/apply", { method: "POST" });
      setApplyMessage({ ok: true, text: data.message });
      setTimeout(loadStatus, 5000);
    } catch (err) {
      setApplyMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not connect the domain." });
    } finally {
      setApplying(false);
    }
  };

  const overallStyle = STATUS_STYLE[overall];

  return (
    <div className="flex w-full flex-col items-center gap-6 pb-12">
      <h1 className="text-xl font-semibold text-slate-100">Connect Domain</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Cloudflare has no OAuth grant that lets this app obtain a DNS-edit token on your behalf — every ACME DNS
        client (certbot, acme.sh, Caddy) has the same limitation, which is why step 3 below is a manual token paste
        rather than a one-click connect. Everything else here is automated.
      </p>

      <div className={`glass-card flex w-full max-w-2xl items-center justify-between p-4 ${overallStyle.text}`}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={`h-2.5 w-2.5 rounded-full ${overallStyle.dot}`} />
          Overall: {overallStyle.label}
        </span>
        <button onClick={loadStatus} disabled={refreshing} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50">
          {refreshing ? "Checking…" : "Re-check all"}
        </button>
      </div>
      {statusError && (
        <div className="w-full max-w-2xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {statusError}
        </div>
      )}

      {/* Step 1 — domain */}
      <div className="glass-card flex w-full max-w-2xl flex-col gap-2 p-4">
        <h2 className="text-sm font-medium text-slate-200">1. Domain</h2>
        <div className="flex gap-2">
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="pbx.example.com"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <button
            onClick={saveDomain}
            disabled={savingDomain || !domain.trim()}
            className="rounded-lg bg-cyan px-3 py-2 text-xs font-medium text-background disabled:opacity-30"
          >
            Save
          </button>
        </div>
      </div>

      {/* Step 2 — nameservers */}
      <div className="glass-card flex w-full max-w-2xl flex-col gap-2 p-4">
        <h2 className="text-sm font-medium text-slate-200">2. Nameservers at Cloudflare</h2>
        <p className="text-xs text-slate-500">
          In Cloudflare, &quot;Add a site&quot; for this domain if you haven&apos;t already, then update the
          nameservers at your registrar (GoDaddy: Domain Settings → Nameservers) to the two Cloudflare assigns. This
          step can&apos;t be automated — Cloudflare only assigns nameservers once the zone exists, and your
          registrar login isn&apos;t something this app should ever touch. The status card above shows live once
          propagation completes (can take minutes to a few hours).
        </p>
      </div>

      {/* Step 3 — token */}
      <div className="glass-card flex w-full max-w-2xl flex-col gap-2 p-4">
        <h2 className="text-sm font-medium text-slate-200">3. Cloudflare API token</h2>
        <a
          href="https://dash.cloudflare.com/profile/api-tokens"
          target="_blank"
          rel="noreferrer"
          className="self-start rounded-lg bg-blue px-4 py-2 text-xs font-medium text-white"
        >
          Open Cloudflare API Tokens →
        </a>
        <p className="text-xs text-slate-500">
          Create Token → use the <strong>&quot;Edit zone DNS&quot;</strong> template → under Zone Resources choose
          <strong> Specific zone → {domain || "your domain"}</strong> → Continue to summary → Create Token → copy
          it (Cloudflare shows it once) and paste below.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste token"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <button
            onClick={saveToken}
            disabled={savingToken || !token.trim()}
            className="rounded-lg bg-cyan px-3 py-2 text-xs font-medium text-background disabled:opacity-30"
          >
            Save
          </button>
        </div>
        {saveMessage && <p className="text-xs text-slate-400">{saveMessage}</p>}
      </div>

      {/* Step 4 — A record */}
      <div className="glass-card flex w-full max-w-2xl flex-col gap-2 p-4">
        <h2 className="text-sm font-medium text-slate-200">4. A record</h2>
        <p className="text-xs text-slate-500">
          Detected outbound IP: <span className="text-slate-300">{detectedIp ?? "detecting…"}</span>. If this VM is
          only reachable on your local network right now, type its LAN address instead — grey-cloud (not proxied)
          is required either way, since Cloudflare&apos;s proxy does not forward the WSS/TURN ports this stack needs.
        </p>
        <div className="flex gap-2">
          <input
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
            placeholder={detectedIp ?? "192.168.x.x or a public IP"}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <button
            onClick={writeARecord}
            disabled={writingRecord || (!manualIp.trim() && !detectedIp)}
            className="rounded-lg bg-cyan px-3 py-2 text-xs font-medium text-background disabled:opacity-30"
          >
            {writingRecord ? "Writing…" : "Create / update A record"}
          </button>
        </div>
        {recordMessage && (
          <p className={`text-xs ${recordMessage.ok ? "text-green-400" : "text-red-400"}`}>{recordMessage.text}</p>
        )}
      </div>

      {/* Step 5 — verify + apply */}
      <div className="glass-card flex w-full max-w-2xl flex-col gap-3 p-4">
        <h2 className="text-sm font-medium text-slate-200">5. Verify and connect</h2>
        <div className="flex flex-col gap-2">
          {checks.map((c) => {
            const style = STATUS_STYLE[c.status];
            return (
              <div key={c.id} className="flex flex-col gap-0.5 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs font-medium text-slate-200">
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                    {c.label}
                  </span>
                  <span className={`text-xs ${style.text}`}>{style.label}</span>
                </div>
                <p className="text-xs text-slate-500">{c.detail}</p>
                {c.hint && (c.status === "warn" || c.status === "fail") && <p className="text-xs text-slate-400">{c.hint}</p>}
              </div>
            );
          })}
        </div>
        <button
          onClick={applyDomain}
          disabled={applying}
          className="self-start rounded-lg bg-blue px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {applying ? "Connecting…" : "Connect domain"}
        </button>
        {applyMessage && <p className={`text-xs ${applyMessage.ok ? "text-green-400" : "text-red-400"}`}>{applyMessage.text}</p>}
        {domain && (
          <p className="text-xs text-slate-500">
            Once the certificate shows OK above,{" "}
            <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">
              open https://{domain} yourself
            </a>{" "}
            — that is the real, final check: DNS/token/cert status here can all be green while the network path
            (port-forwarding, router, VM networking) is still separately blocked.
          </p>
        )}
      </div>
    </div>
  );
}
