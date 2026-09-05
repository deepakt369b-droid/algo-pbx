"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
              evidence="Configure a target in the provisioning flow to start delivery."
              tone="info"
            />
          )}
        </CardContent>
      </Card>
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
