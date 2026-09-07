"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { COUNTRY_OPTIONS } from "@/lib/countries";
import { fmtDateTime, type SerialisedTenantDetail, type PlatformRole } from "./types";

// Geo lock (plan §3.3, node W6). Owner-only, already gated by
// tenant-detail-tabs.tsx.
//
// This tab does its OWN data fetching (geo-overview + geo-settings GET
// routes) rather than reading it off `detail`/SerialisedTenantDetail — that
// type and its loader (tenant-detail.ts) are explicitly off-limits for this
// wave, and support-tab.tsx already establishes the precedent of an
// owner-only tab fetching its own slice rather than being prop-drilled
// everything up front (its history list follows the same shape). `detail`
// is still used for the tenant id/name and nothing else.

const LOCK_MODE_OPTIONS: SelectOption<"off" | "monitor" | "enforce">[] = [
  { value: "off", label: "Off — no geo checks" },
  { value: "monitor", label: "Monitor — log only, never blocks" },
  { value: "enforce", label: "Enforce — locks after the threshold" },
];

const OUTCOME_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  allowed: "success",
  wrong_country: "danger",
  vpn_suspected: "danger",
  unknown_ip: "warning",
  db_unavailable: "warning",
  monitor_only: "neutral",
};

const COUNTRY_LABEL = new Map(COUNTRY_OPTIONS.map((c) => [c.code, c.label]));

interface GeoSettings {
  geoLockMode: "off" | "monitor" | "enforce";
  geoDefaultCountry: string | null;
  geoBlockVpn: boolean;
  geoFailureThreshold: number;
}

interface GeoExtension {
  id: string;
  number: string;
  geoAllowedCountries: string[];
  geoLockedAt: string | null;
  geoLockedReason: string | null;
  geoFailedAttempts: number;
}

interface GeoEvent {
  id: string;
  createdAt: string;
  ip: string;
  country: string | null;
  asn: number | null;
  asnOrg: string | null;
  outcome: string;
  counted: boolean;
  email: string;
  extensionNumber: string | null;
}

export function GeoTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const router = useRouter();
  const canEdit = role === "PLATFORM_OWNER";
  const tenantId = detail.tenant.id;

  const [settings, setSettings] = useState<GeoSettings | null>(null);
  const [extensions, setExtensions] = useState<GeoExtension[] | null>(null);
  const [events, setEvents] = useState<GeoEvent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState(true);

  const [form, setForm] = useState<GeoSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [editingExtensionId, setEditingExtensionId] = useState<string | null>(null);
  const [draftCountries, setDraftCountries] = useState<string[]>([]);
  const [countryToAdd, setCountryToAdd] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    Promise.all([
      fetch(`/api/platform/tenants/${tenantId}/geo-settings`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
      fetch(`/api/platform/tenants/${tenantId}/geo-overview`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
    ])
      .then(([s, o]) => {
        setSettings(s.settings);
        setForm(s.settings);
        setExtensions(o.extensions);
        setEvents(o.events);
      })
      .catch(() => setLoadError("Could not load geo-lock data for this tenant."));
  }

  useEffect(load, [tenantId]);

  async function saveSettings(reason: string) {
    if (!form) return;
    const res = await fetch(`/api/platform/tenants/${tenantId}/geo-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, reason }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "Could not save geo-lock settings.");
    }
    setSavingSettings(false);
    load();
    router.refresh();
  }

  function startEditingExtension(ext: GeoExtension) {
    setEditingExtensionId(ext.id);
    setDraftCountries(ext.geoAllowedCountries);
    setCountryToAdd(null);
  }

  async function saveExtensionCountries(reason: string) {
    if (!editingExtensionId) return;
    const res = await fetch(`/api/platform/tenants/${tenantId}/extensions/${editingExtensionId}/geo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geoAllowedCountries: draftCountries, reason }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "Could not save this extension's allocated countries.");
    }
    setEditingExtensionId(null);
    load();
  }

  const sortedEvents = useMemo(() => {
    if (!events) return [];
    const copy = [...events];
    copy.sort((a, b) =>
      sortDesc
        ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return copy;
  }, [events, sortDesc]);

  const editingExtension = extensions?.find((e) => e.id === editingExtensionId) ?? null;

  return (
    <div className="space-y-4">
      {loadError && (
        <p role="alert" className="text-[12px] text-danger">
          {loadError}
        </p>
      )}

      {/* --- Tenant-level dials ------------------------------------------ */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Geo-lock mode</h2>
          <p className="text-[12px] text-secondary">
            &ldquo;Monitor&rdquo; only ever records evidence below and never blocks or locks anyone.
            &ldquo;Enforce&rdquo; is the real lock path — an extension locks after{" "}
            {form?.geoFailureThreshold ?? 6} strikes
            and stays locked until a platform owner approves an unlock, here or on the{" "}
            <a href="/platform/geo-locks" className="text-accent underline-offset-2 hover:underline">
              Geo locks
            </a>{" "}
            queue.
          </p>

          {!form ? (
            <p className="text-[12px] text-tertiary">Loading…</p>
          ) : !canEdit ? (
            <p className="text-[12px] text-tertiary">Only a platform owner can change geo-lock settings.</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Mode</Label>
                  <Select
                    value={form.geoLockMode}
                    onChange={(v) => setForm({ ...form, geoLockMode: v })}
                    options={LOCK_MODE_OPTIONS}
                    aria-label="Geo-lock mode"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Default country (advisory)</Label>
                  <Select
                    value={form.geoDefaultCountry}
                    onChange={(v) => setForm({ ...form, geoDefaultCountry: v })}
                    options={COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.label }))}
                    placeholder="Not set"
                    aria-label="Default country"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="geo-threshold">Failure threshold</Label>
                  <Input
                    id="geo-threshold"
                    type="number"
                    min={1}
                    value={form.geoFailureThreshold}
                    onChange={(e) =>
                      setForm({ ...form, geoFailureThreshold: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </div>
                <div className="flex items-end pb-1.5">
                  <Switch
                    checked={form.geoBlockVpn}
                    onChange={(v) => setForm({ ...form, geoBlockVpn: v })}
                    label="Count a datacenter/VPN ASN match as a strike"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <Button
                  size="sm"
                  disabled={!settings || JSON.stringify(settings) === JSON.stringify(form)}
                  onClick={() => setSavingSettings(true)}
                  data-testid="action-save-geo-settings"
                >
                  Save
                </Button>
                {settings && JSON.stringify(settings) !== JSON.stringify(form) && (
                  <p className="text-[11px] text-tertiary">Unsaved changes.</p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* --- Per-extension country allocation ----------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Per-extension country allocation</h2>
          <p className="text-[12px] text-secondary">
            Owner-set only — the tenant admin never edits this. An extension with no countries
            allocated is never enforced, regardless of the tenant&apos;s mode above.
          </p>

          {!extensions ? (
            <p className="text-[12px] text-tertiary">Loading…</p>
          ) : extensions.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary">No extensions on this tenant yet.</p>
          ) : (
            <ul className="space-y-2" data-testid="geo-extension-list">
              {extensions.map((ext) => (
                <li
                  key={ext.id}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="flex items-center gap-2 text-[13px] font-medium text-primary">
                      Ext {ext.number}
                      {ext.geoLockedAt ? (
                        <Badge tone="danger" title={`Locked ${fmtDateTime(ext.geoLockedAt)}`}>
                          Locked
                        </Badge>
                      ) : (
                        <Badge tone="success">Unlocked</Badge>
                      )}
                      {ext.geoFailedAttempts > 0 && (
                        <Badge tone="warning">{ext.geoFailedAttempts} strike{ext.geoFailedAttempts === 1 ? "" : "s"}</Badge>
                      )}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {ext.geoAllowedCountries.length === 0 ? (
                        <span className="text-[12px] text-tertiary">No countries allocated (unenforced)</span>
                      ) : (
                        ext.geoAllowedCountries.map((c) => (
                          <Badge key={c} tone="neutral">
                            {COUNTRY_LABEL.get(c) ?? c}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <Button size="sm" variant="secondary" onClick={() => startEditingExtension(ext)}>
                      Edit countries
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Evidence log --------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-primary">Login evidence (last 50)</h2>
            <button
              type="button"
              onClick={() => setSortDesc((v) => !v)}
              className="text-[11px] text-accent hover:underline"
              data-testid="toggle-event-sort"
            >
              Sort: {sortDesc ? "newest first" : "oldest first"}
            </button>
          </div>
          <p className="text-[12px] text-secondary">
            The evidence an operator reads before approving or denying an unlock — every recorded
            geo-login attempt against this tenant, most recent 50.
          </p>

          {!events ? (
            <p className="text-[12px] text-tertiary">Loading…</p>
          ) : events.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary">No geo-login events recorded for this tenant.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]" data-testid="geo-events-table">
                <thead>
                  <tr className="border-b text-left text-tertiary [border-color:rgb(var(--hairline))]">
                    <th className="py-1.5 pr-3 font-medium">Time</th>
                    <th className="py-1.5 pr-3 font-medium">Extension</th>
                    <th className="py-1.5 pr-3 font-medium">IP</th>
                    <th className="py-1.5 pr-3 font-medium">Country</th>
                    <th className="py-1.5 pr-3 font-medium">ASN</th>
                    <th className="py-1.5 pr-3 font-medium">Outcome</th>
                    <th className="py-1.5 pr-3 font-medium">Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedEvents.map((ev) => (
                    <tr key={ev.id} className="border-b [border-color:rgb(var(--hairline))]">
                      <td className="py-1.5 pr-3 text-primary">{fmtDateTime(ev.createdAt)}</td>
                      <td className="py-1.5 pr-3 text-primary">{ev.extensionNumber ?? "—"}</td>
                      <td className="py-1.5 pr-3 font-mono text-primary">{ev.ip}</td>
                      <td className="py-1.5 pr-3 text-primary">
                        {ev.country ?? "unknown"}
                      </td>
                      <td className="py-1.5 pr-3 text-secondary">
                        {ev.asn ? `AS${ev.asn}${ev.asnOrg ? ` (${ev.asnOrg})` : ""}` : "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge tone={OUTCOME_TONE[ev.outcome] ?? "neutral"}>{ev.outcome}</Badge>
                      </td>
                      <td className="py-1.5 pr-3 text-secondary">{ev.counted ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {savingSettings && form && (
        <ConfirmActionDialog
          open
          onClose={() => setSavingSettings(false)}
          title="Save geo-lock settings"
          blastRadius={`Sets ${detail.tenant.name}'s geo-lock mode to "${form.geoLockMode}"${
            form.geoLockMode === "enforce"
              ? `, locking any allocated extension after ${form.geoFailureThreshold} failed-country attempts.`
              : "."
          }`}
          confirmLabel="Save"
          tone="default"
          onConfirm={saveSettings}
        />
      )}

      {editingExtensionId && editingExtension && (
        <ConfirmActionDialog
          open
          onClose={() => setEditingExtensionId(null)}
          title={`Allocate countries — extension ${editingExtension.number}`}
          blastRadius={`Sets extension ${editingExtension.number}'s allowed countries to exactly the list below. An empty list means this extension is never geo-enforced.`}
          confirmLabel="Save allocation"
          tone="default"
          onConfirm={saveExtensionCountries}
        >
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {draftCountries.length === 0 ? (
                <span className="text-[12px] text-tertiary">No countries allocated yet.</span>
              ) : (
                draftCountries.map((c) => (
                  <Badge key={c} tone="accent" className="cursor-pointer" onClick={() => setDraftCountries(draftCountries.filter((x) => x !== c))}>
                    {COUNTRY_LABEL.get(c) ?? c} ×
                  </Badge>
                ))
              )}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Add a country</Label>
                <Select
                  value={countryToAdd}
                  onChange={setCountryToAdd}
                  options={COUNTRY_OPTIONS.filter((c) => !draftCountries.includes(c.code)).map((c) => ({
                    value: c.code,
                    label: c.label,
                  }))}
                  placeholder="Choose a country"
                  aria-label="Add a country"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!countryToAdd}
                onClick={() => {
                  if (countryToAdd) {
                    setDraftCountries([...draftCountries, countryToAdd]);
                    setCountryToAdd(null);
                  }
                }}
              >
                Add
              </Button>
            </div>
          </div>
        </ConfirmActionDialog>
      )}
    </div>
  );
}
