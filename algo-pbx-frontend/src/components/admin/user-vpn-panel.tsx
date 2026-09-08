"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { apiFetch, ApiError } from "@/lib/client/api";

// Per-user VPN profile panel (owner-page enchanted-sphinx plan, W3).
// Tenant-admin console ONLY — imported by src/app/admin/users/[id]/page.tsx
// alone, never by anything under src/app/agent/**. Uses a plain inline
// confirm rather than ConfirmActionDialog — that component is the
// owner-console's destructive-action primitive
// (src/components/platform-shell/confirm-action-dialog.tsx) and is not
// wired into this plane.

type Transport = "WIREGUARD" | "HEADSCALE" | "TAILSCALE" | "OPENVPN";

interface VpnProfile {
  id: string;
  transport: Transport;
  label: string | null;
  tunnelIp: string | null;
  publicKey: string | null;
  status: "UNKNOWN" | "UP" | "DEGRADED" | "DOWN";
  lastHandshakeAt: string | null;
  lastReachableAt: string | null;
  revokedAt: string | null;
  hasConfig: boolean;
}

const TRANSPORT_OPTIONS: SelectOption<Transport>[] = [
  { value: "WIREGUARD", label: "WireGuard (generated config)" },
  { value: "HEADSCALE", label: "Headscale (generated config)" },
  { value: "TAILSCALE", label: "Tailscale (own auth flow)" },
  { value: "OPENVPN", label: "OpenVPN (own PKI flow)" },
];

const STATUS_TONE: Record<VpnProfile["status"], "neutral" | "success" | "warning" | "danger"> = {
  UNKNOWN: "neutral",
  UP: "success",
  DEGRADED: "warning",
  DOWN: "danger",
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function UserVpnPanel({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<VpnProfile | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [transport, setTransport] = useState<Transport>("WIREGUARD");
  const [label, setLabel] = useState("");
  const [serverPublicKey, setServerPublicKey] = useState("");
  const [serverEndpoint, setServerEndpoint] = useState("");

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ config: string; filename: string } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  function load() {
    setLoadError(null);
    apiFetch<{ profile: VpnProfile | null }>(`/api/admin/users/${userId}/vpn`)
      .then((json) => setProfile(json.profile))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load the VPN profile."));
  }

  useEffect(load, [userId]);

  async function generate() {
    setBusy(true);
    setActionError(null);
    setRevealed(null);
    try {
      const json = await apiFetch<{ config: string | null; filename: string | null; note?: string }>(
        `/api/admin/users/${userId}/vpn`,
        {
          method: "POST",
          body: {
            transport,
            label: label.trim() || undefined,
            serverPublicKey: serverPublicKey.trim() || undefined,
            serverEndpoint: serverEndpoint.trim() || undefined,
          },
        }
      );
      if (json.config && json.filename) {
        setRevealed({ config: json.config, filename: json.filename });
      } else if (json.note) {
        setActionError(json.note);
      }
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not generate a VPN profile.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`/api/admin/users/${userId}/vpn`, { method: "DELETE" });
      setRevealed(null);
      setConfirmingRevoke(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not revoke this VPN profile.");
    } finally {
      setBusy(false);
    }
  }

  function downloadRevealed() {
    if (!revealed) return;
    const blob = new Blob([revealed.config], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = revealed.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const needsServerFields = transport === "WIREGUARD" || transport === "HEADSCALE";

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <h2 className="text-[15px] font-semibold text-primary">VPN profile</h2>

        {loadError && (
          <p role="alert" className="text-[12px] text-danger">
            {loadError}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-[12px] text-danger">
            {actionError}
          </p>
        )}

        {profile === undefined ? (
          <p className="text-[12px] text-tertiary">Loading…</p>
        ) : profile && !profile.revokedAt ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{profile.transport}</Badge>
              <Badge tone={STATUS_TONE[profile.status]}>{profile.status}</Badge>
              {profile.label && <span className="text-[12px] text-secondary">{profile.label}</span>}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-tertiary">Tunnel IP</dt>
              <dd className="font-mono text-primary">{profile.tunnelIp ?? "—"}</dd>
              <dt className="text-tertiary">Last handshake</dt>
              <dd className="text-primary">{fmtDateTime(profile.lastHandshakeAt)}</dd>
              <dt className="text-tertiary">Last reachable</dt>
              <dd className="text-primary">{fmtDateTime(profile.lastReachableAt)}</dd>
            </dl>

            {revealed && (
              <div className="space-y-2 rounded-[var(--radius)] border border-warning/30 bg-warning/10 p-3">
                <p className="text-[12px] font-medium text-warning">
                  Shown once — copy or download it now. It will not be shown again by reloading this page.
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-[11px] text-primary">
                  {revealed.config}
                </pre>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigator.clipboard.writeText(revealed.config)}
                  >
                    Copy
                  </Button>
                  <Button size="sm" variant="secondary" onClick={downloadRevealed}>
                    Download
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" disabled={busy} onClick={generate}>
                Rotate
              </Button>
              {confirmingRevoke ? (
                <>
                  <span className="text-[12px] text-danger">Revoke this profile?</span>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={revoke}>
                    Confirm revoke
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingRevoke(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setConfirmingRevoke(true)}>
                  Revoke
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-tertiary">
            {profile?.revokedAt ? "This user's previous profile was revoked." : "No VPN profile yet."}
          </p>
        )}

        <div className="space-y-3 border-t pt-3 [border-color:rgb(var(--hairline))]">
          <h3 className="text-[13px] font-medium text-primary">
            {profile && !profile.revokedAt ? "Rotate with a different transport" : "Generate a profile"}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Transport</Label>
              <Select value={transport} onChange={setTransport} options={TRANSPORT_OPTIONS} aria-label="Transport" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vpn-label">Label (optional)</Label>
              <Input id="vpn-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. this user's name" />
            </div>
            {needsServerFields && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="vpn-server-key">Server public key</Label>
                  <Input
                    id="vpn-server-key"
                    value={serverPublicKey}
                    onChange={(e) => setServerPublicKey(e.target.value)}
                    placeholder="Leave blank to reuse this tenant's existing value"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="vpn-server-endpoint">Server endpoint</Label>
                  <Input
                    id="vpn-server-endpoint"
                    value={serverEndpoint}
                    onChange={(e) => setServerEndpoint(e.target.value)}
                    placeholder="host:port — leave blank to reuse"
                  />
                </div>
              </>
            )}
          </div>
          <Button size="sm" disabled={busy} onClick={generate}>
            {busy ? "Working…" : "Generate profile"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
