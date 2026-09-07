"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { DependencyNotice, UnmeasuredStat } from "@/components/platform-shell/dependency-notice";
import { type SerialisedTenantDetail, type PlatformRole, fmtDateTime } from "./types";

// Gateway, connectivity and recording storage.
//
// The "Push VPN config" action reuses the existing deterministic push
// (login -> multipart upload -> MANDATORY read-back verification). The
// read-back is the whole point and is reported separately from the upload:
// this device has been observed accepting a configuration POST and not
// applying it, so "the upload returned 200" is not evidence of anything. A
// push that uploads but fails read-back is reported as a FAILURE here, not a
// success with a footnote.

const SITE_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  UP: "success",
  DEGRADED: "warning",
  DOWN: "danger",
  UNKNOWN: "neutral",
};

interface PushResult {
  ok: boolean;
  loggedIn?: boolean;
  pushed?: boolean;
  verifiedByReadback?: boolean;
  error?: string;
}

export function GatewayTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const router = useRouter();
  const { tenant, deliveries } = detail;
  const [pushing, setPushing] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, PushResult>>({});
  const isOwner = role === "PLATFORM_OWNER";

  async function push(siteId: string) {
    setPushing(siteId);
    try {
      const res = await fetch(`/api/platform/tenants/${tenant.id}/gateway/push-vpn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId }),
      });
      const json = (await res.json().catch(() => null)) as PushResult | null;
      setResult((r) => ({
        ...r,
        [siteId]: json ?? { ok: false, error: "No response from the push endpoint." },
      }));
      router.refresh();
    } catch (err) {
      setResult((r) => ({
        ...r,
        [siteId]: { ok: false, error: err instanceof Error ? err.message : "Push failed." },
      }));
    } finally {
      setPushing(null);
    }
  }

  const target = tenant.recordingStorageTarget;
  const deliveryPipelineRunning = Boolean(target?.enabled);

  // --- Recording storage config form (wires the previously-dead
  // PUT/PATCH /api/platform/tenants/[id]/recording-target route) ---
  //
  // TargetConfigSchema (src/lib/recordings/delivery/targets.ts) only has two
  // real members: CUSTOMER_S3 and CUSTOMER_SFTP. There is no "PLATFORM_LOCAL"
  // config to PUT — it is what NO row means, not a row this route can create.
  // So the kind select below offers S3/SFTP for configuration; "platform
  // local" is shown as the current state when no target exists, not as a
  // selectable target to switch back to (the route has no delete action to
  // do that with — out of this task's scope).
  type TargetKind = "CUSTOMER_S3" | "CUSTOMER_SFTP";
  const [targetKind, setTargetKind] = useState<TargetKind>(
    (target?.kind === "CUSTOMER_SFTP" ? "CUSTOMER_SFTP" : "CUSTOMER_S3") as TargetKind
  );
  const [s3, setS3] = useState({ bucket: "", region: "", accessKeyId: "", secretAccessKey: "", endpoint: "", prefix: "" });
  const [sftp, setSftp] = useState({ host: "", port: 22, username: "", password: "", remotePath: "/" });
  const [savingTarget, setSavingTarget] = useState(false);
  const [confirmingTarget, setConfirmingTarget] = useState(false);
  const [confirmingEnable, setConfirmingEnable] = useState<boolean | null>(null);
  const [targetNotice, setTargetNotice] = useState<string | null>(null);

  async function saveTarget(reason: string) {
    setSavingTarget(true);
    try {
      const config =
        targetKind === "CUSTOMER_S3"
          ? {
              kind: "CUSTOMER_S3" as const,
              bucket: s3.bucket,
              region: s3.region,
              accessKeyId: s3.accessKeyId,
              secretAccessKey: s3.secretAccessKey,
              ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
              prefix: s3.prefix,
            }
          : {
              kind: "CUSTOMER_SFTP" as const,
              host: sftp.host,
              port: sftp.port,
              username: sftp.username,
              password: sftp.password,
              remotePath: sftp.remotePath,
            };

      const res = await fetch(`/api/platform/tenants/${tenant.id}/recording-target`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, verifyBeforePurge: true, reason }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; notice?: string } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save the target.");
      setTargetNotice(json?.notice ?? "Saved and left disabled. Run enable to test the connection.");
      router.refresh();
    } finally {
      setSavingTarget(false);
    }
  }

  async function setTargetEnabled(enabled: boolean, reason: string) {
    const res = await fetch(`/api/platform/tenants/${tenant.id}/recording-target`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, reason }),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(json?.error ?? "Could not update delivery.");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {tenant.gatewaySites.length === 0 ? (
        <Card>
          <CardContent className="p-5">
            <h2 className="text-[15px] font-semibold text-primary">Gateway sites</h2>
            <p className="mt-1 text-[13px] text-secondary">
              No gateway has been provisioned for this tenant yet. This is not a fault — the
              provisioning wizard creates one at the “create gateway site” step.
            </p>
          </CardContent>
        </Card>
      ) : (
        tenant.gatewaySites.map((site) => {
          const r = result[site.id];
          return (
            <Card key={site.id}>
              <CardContent className="space-y-3 p-5" data-testid="gateway-site" data-site={site.name}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-[15px] font-semibold text-primary">
                      <span className="font-mono">{site.name}</span>
                      <Badge tone={SITE_TONE[site.status]}>{site.status}</Badge>
                    </h2>
                    <p className="text-[12px] text-tertiary">Transport: {site.transport}</p>
                  </div>
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pushing === site.id}
                      onClick={() => push(site.id)}
                      data-testid="action-push-vpn"
                    >
                      {pushing === site.id ? "Pushing…" : "Push VPN config"}
                    </Button>
                  )}
                </div>

                <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                  <div className="flex justify-between gap-3">
                    <dt className="text-tertiary">LAN IP</dt>
                    <dd className="font-mono text-primary">{site.gatewayLanIp}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-tertiary">Tunnel IP</dt>
                    <dd className="font-mono text-primary">{site.tunnelIp ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-tertiary">Last handshake</dt>
                    <dd className={site.lastHandshakeAt ? "text-primary" : "text-warning"}>
                      {site.lastHandshakeAt ? fmtDateTime(site.lastHandshakeAt) : "Never"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-tertiary">Last reachable</dt>
                    <dd className="text-primary">{fmtDateTime(site.lastReachableAt)}</dd>
                  </div>
                </dl>

                {!site.lastHandshakeAt && (
                  <DependencyNotice
                    feature="Provisioning past certificate issuance"
                    blockedOn="This gateway has never completed an OpenVPN handshake."
                    evidence="Until it does, ccd, firewall and telephony steps stay disabled — see handoff.md G2."
                  />
                )}

                {r && (
                  <div
                    data-testid="push-result"
                    data-ok={r.ok && r.verifiedByReadback === true}
                    className={`rounded-[var(--radius)] border p-3 text-[12px] ${
                      r.ok && r.verifiedByReadback
                        ? "border-success/30 bg-success/10 text-success"
                        : "border-danger/30 bg-danger/10 text-danger"
                    }`}
                  >
                    {r.ok && r.verifiedByReadback ? (
                      <p>Pushed and verified by read-back. OpenVPN is enabled on the device.</p>
                    ) : (
                      <div className="space-y-0.5">
                        <p className="font-medium">Push not verified.</p>
                        <p>Logged in: {String(r.loggedIn ?? false)}</p>
                        <p>Upload accepted: {String(r.pushed ?? false)}</p>
                        <p>Read-back verified: {String(r.verifiedByReadback ?? false)}</p>
                        {r.error && <p>{r.error}</p>}
                        <p className="pt-1">
                          An accepted upload without a successful read-back means the device did not
                          apply the config. Treat this as a failure.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {site.events.length > 0 && (
                  <div>
                    <p className="mb-1 text-[12px] font-medium text-primary">Recent gateway events</p>
                    <ul className="space-y-0.5">
                      {site.events.map((e) => (
                        <li key={e.id} className="flex gap-2 text-[11px] text-secondary">
                          <span className="shrink-0 text-tertiary">{fmtDateTime(e.receivedAt)}</span>
                          <span className="truncate">
                            [{e.severity}] {e.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {/* --- Recording storage ------------------------------------------ */}
      <Card>
        <CardContent className="space-y-3 p-5" data-testid="recording-storage">
          <h2 className="text-[15px] font-semibold text-primary">Recording storage</h2>

          <dl className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
            <div className="flex justify-between gap-3">
              <dt className="text-tertiary">Target</dt>
              <dd className="text-primary">{target?.kind ?? "PLATFORM_LOCAL (default)"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-tertiary">Verify before purge</dt>
              <dd className="text-primary">{target ? String(target.verifyBeforePurge) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-tertiary">Last verified</dt>
              <dd className="text-primary">{fmtDateTime(target?.lastVerifiedAt ?? null)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-tertiary">Delivery enabled</dt>
              <dd className="text-primary">{String(deliveryPipelineRunning)}</dd>
            </div>
          </dl>

          {/* A zero from a running worker is good news. The same zero from a
              worker that does not exist is an absence of information — so
              when nothing is running we render dashes, not zeroes. */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {deliveryPipelineRunning ? (
              <>
                <Stat label="Pending" value={deliveries.PENDING ?? 0} />
                <Stat label="In flight" value={deliveries.IN_FLIGHT ?? 0} />
                <Stat label="Delivered" value={deliveries.DELIVERED ?? 0} />
                <Stat label="Failed" value={deliveries.FAILED ?? 0} tone="danger" />
              </>
            ) : (
              <>
                <UnmeasuredStat label="Pending" reason="No delivery target enabled" />
                <UnmeasuredStat label="In flight" reason="No delivery target enabled" />
                <UnmeasuredStat label="Delivered" reason="No delivery target enabled" />
                <UnmeasuredStat label="Failed" reason="No delivery target enabled" />
              </>
            )}
          </div>

          {!deliveryPipelineRunning && (
            <DependencyNotice
              feature="Recording delivery to customer storage"
              blockedOn="No delivery target is enabled for this tenant. Recordings stay on platform-local disk."
              evidence="Configure a target below to start delivery."
              tone="info"
            />
          )}

          {isOwner && (
            <div className="space-y-3 border-t pt-3 [border-color:rgb(var(--hairline))]" data-testid="recording-target-form">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-[13px] font-semibold text-primary">Configure target</h3>
                <Button
                  size="sm"
                  variant={deliveryPipelineRunning ? "secondary" : "danger"}
                  disabled={!target}
                  onClick={() => setConfirmingEnable(!deliveryPipelineRunning)}
                  data-testid="action-toggle-target-enabled"
                >
                  {deliveryPipelineRunning ? "Disable delivery" : "Enable delivery"}
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="target-kind">Kind</Label>
                <Select
                  value={targetKind}
                  onChange={(v) => setTargetKind(v)}
                  options={[
                    { value: "CUSTOMER_S3" as const, label: "Customer S3 (or S3-compatible)" },
                    { value: "CUSTOMER_SFTP" as const, label: "Customer SFTP" },
                  ]}
                  aria-label="Recording storage kind"
                />
                <p className="text-[11px] text-tertiary">
                  PLATFORM_LOCAL (the current default when no target is configured) is not a
                  selectable kind — it is what having no target row means, not something this form
                  writes.
                </p>
              </div>

              {targetKind === "CUSTOMER_S3" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-bucket">Bucket</Label>
                    <Input id="s3-bucket" value={s3.bucket} onChange={(e) => setS3((s) => ({ ...s, bucket: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-region">Region</Label>
                    <Input id="s3-region" value={s3.region} onChange={(e) => setS3((s) => ({ ...s, region: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-access-key">Access key ID</Label>
                    <Input id="s3-access-key" value={s3.accessKeyId} onChange={(e) => setS3((s) => ({ ...s, accessKeyId: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-secret-key">Secret access key</Label>
                    <Input id="s3-secret-key" type="password" value={s3.secretAccessKey} onChange={(e) => setS3((s) => ({ ...s, secretAccessKey: e.target.value }))} autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-endpoint">Endpoint (optional, for R2/MinIO/Wasabi)</Label>
                    <Input id="s3-endpoint" value={s3.endpoint} onChange={(e) => setS3((s) => ({ ...s, endpoint: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="s3-prefix">Key prefix</Label>
                    <Input id="s3-prefix" value={s3.prefix} onChange={(e) => setS3((s) => ({ ...s, prefix: e.target.value }))} />
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="sftp-host">Host</Label>
                    <Input id="sftp-host" value={sftp.host} onChange={(e) => setSftp((s) => ({ ...s, host: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sftp-port">Port</Label>
                    <Input id="sftp-port" type="number" value={sftp.port} onChange={(e) => setSftp((s) => ({ ...s, port: Number(e.target.value) }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sftp-username">Username</Label>
                    <Input id="sftp-username" value={sftp.username} onChange={(e) => setSftp((s) => ({ ...s, username: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sftp-password">Password</Label>
                    <Input id="sftp-password" type="password" value={sftp.password} onChange={(e) => setSftp((s) => ({ ...s, password: e.target.value }))} autoComplete="off" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="sftp-remote-path">Remote path</Label>
                    <Input id="sftp-remote-path" value={sftp.remotePath} onChange={(e) => setSftp((s) => ({ ...s, remotePath: e.target.value }))} />
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={savingTarget}
                  onClick={() => setConfirmingTarget(true)}
                  data-testid="action-save-target"
                >
                  Save configuration
                </Button>
                <p className="text-[11px] text-tertiary">
                  Never enabled by this save — it is stored disabled, then enabling separately runs a
                  live connection test and refuses if it fails.
                </p>
              </div>

              {targetNotice && (
                <p className="text-[12px] text-secondary" data-testid="target-save-notice">
                  {targetNotice}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {confirmingTarget && (
        <ConfirmActionDialog
          open
          onClose={() => setConfirmingTarget(false)}
          title="Save recording storage configuration"
          blastRadius={
            `This stores ${targetKind === "CUSTOMER_S3" ? "S3" : "SFTP"} credentials for ${tenant.name}, ` +
            "encrypted at rest. It is saved DISABLED — no recording is delivered until you separately " +
            "run 'Enable delivery', which tests the connection first and refuses if it fails."
          }
          confirmLabel="Save configuration"
          tone="default"
          onConfirm={async (reason) => {
            await saveTarget(reason);
            setConfirmingTarget(false);
          }}
        />
      )}

      {confirmingEnable !== null && (
        <ConfirmActionDialog
          open
          onClose={() => setConfirmingEnable(null)}
          title={confirmingEnable ? "Enable recording delivery" : "Disable recording delivery"}
          blastRadius={
            confirmingEnable
              ? `This runs a live connection test against ${tenant.name}'s configured target and, if it succeeds, ` +
                "starts delivering recordings there instead of keeping them platform-local only."
              : `This stops delivering ${tenant.name}'s recordings to their configured target. Recordings stay on ` +
                "platform-local disk."
          }
          confirmLabel={confirmingEnable ? "Enable" : "Disable"}
          tone={confirmingEnable ? "default" : "danger"}
          onConfirm={async (reason) => {
            await setTargetEnabled(Boolean(confirmingEnable), reason);
            setConfirmingEnable(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-tertiary">{label}</p>
      <p
        className={`text-xl font-semibold tabular-nums ${tone === "danger" && value > 0 ? "text-danger" : "text-primary"}`}
      >
        {value}
      </p>
    </div>
  );
}
