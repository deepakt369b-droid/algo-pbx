"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, type SelectOption } from "@/components/ui/select";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import {
  extensionAssignBlastRadius,
  extensionUnassignBlastRadius,
  extensionDialPermissionBlastRadius,
} from "@/lib/platform/blast-radius";
import { type SerialisedTenantDetail, type PlatformRole } from "./types";

// Extension management (owner tenant-management modal, W1 — the gap the
// existing Users/Geo tabs didn't cover: WHICH user holds which extension,
// and that extension's dial permission). Owner-only, same reasoning as
// UsersTab/GeoTab: listing is available to any platform session, every
// mutating action goes through ConfirmActionDialog with a mandatory reason.
//
// Does its own data fetching (this tenant's extensions + users), same
// precedent as GeoTab's header comment — `detail`/SerialisedTenantDetail is
// used for the tenant id/name only.

interface ExtensionRow {
  id: string;
  number: string;
  kind: string;
  dialPermission: "LOCAL" | "NATIONAL" | "INTERNATIONAL";
  geoAllowedCountries: string[];
  geoLockedAt: string | null;
  user: { id: string; email: string; name: string } | null;
}

interface TenantUserOption {
  id: string;
  email: string;
  name: string;
}

const DIAL_PERMISSION_OPTIONS: SelectOption<"LOCAL" | "NATIONAL" | "INTERNATIONAL">[] = [
  { value: "LOCAL", label: "Local" },
  { value: "NATIONAL", label: "National" },
  { value: "INTERNATIONAL", label: "International" },
];

type Action =
  | { kind: "assign"; ext: ExtensionRow; userId: string; userEmail: string }
  | { kind: "unassign"; ext: ExtensionRow }
  | { kind: "dial_permission"; ext: ExtensionRow; dialPermission: "LOCAL" | "NATIONAL" | "INTERNATIONAL" }
  | null;

export function ExtensionsTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const tenantId = detail.tenant.id;
  const canEdit = role === "PLATFORM_OWNER";

  const [extensions, setExtensions] = useState<ExtensionRow[] | null>(null);
  const [users, setUsers] = useState<TenantUserOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [assignPick, setAssignPick] = useState<Record<string, string | null>>({});

  function load() {
    setLoadError(null);
    Promise.all([
      fetch(`/api/platform/tenants/${tenantId}/extensions`).then((r) =>
        r.ok ? r.json() : Promise.reject(r)
      ),
      fetch(`/api/platform/tenants/${tenantId}/users`).then((r) => (r.ok ? r.json() : Promise.reject(r))),
    ])
      .then(([ext, usr]) => {
        setExtensions(ext.extensions);
        setUsers(usr.users);
      })
      .catch(() => setLoadError("Could not load extensions for this tenant."));
  }

  useEffect(load, [tenantId]);

  async function submit(reason: string) {
    if (!action) return;
    const body: Record<string, unknown> =
      action.kind === "assign"
        ? { action: "assign_user", userId: action.userId, reason }
        : action.kind === "unassign"
          ? { action: "unassign_user", reason }
          : { action: "set_dial_permission", dialPermission: action.dialPermission, reason };

    const res = await fetch(`/api/platform/tenants/${tenantId}/extensions/${action.ext.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(json?.error ?? "The action failed. Nothing was changed.");
    load();
  }

  const copy: Record<Exclude<Action, null>["kind"], { title: string; blast: string; confirm: string }> = {
    assign: {
      title: "Assign extension",
      blast:
        action?.kind === "assign"
          ? extensionAssignBlastRadius(action.ext.number, action.userEmail)
          : "",
      confirm: "Assign",
    },
    unassign: {
      title: "Unassign extension",
      blast:
        action?.kind === "unassign"
          ? extensionUnassignBlastRadius(action.ext.number, action.ext.user?.email ?? "this user")
          : "",
      confirm: "Unassign",
    },
    dial_permission: {
      title: "Change dial permission",
      blast:
        action?.kind === "dial_permission"
          ? extensionDialPermissionBlastRadius(action.ext.number, action.dialPermission)
          : "",
      confirm: "Save",
    },
  };

  const unassignedUsers = (users ?? []).filter((u) => !extensions?.some((e) => e.user?.id === u.id));

  return (
    <div className="space-y-4">
      {loadError && (
        <p role="alert" className="text-[12px] text-danger">
          {loadError}
        </p>
      )}

      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Extensions</h2>
          <p className="text-[12px] text-secondary">
            Which user holds each extension, and its dial permission. Geo-lock allocation for
            these same extensions is on the Geo tab.
          </p>

          {!extensions ? (
            <p className="text-[12px] text-tertiary">Loading…</p>
          ) : extensions.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary">No extensions on this tenant yet.</p>
          ) : (
            <ul className="space-y-2" data-testid="extensions-list">
              {extensions.map((ext) => (
                <li
                  key={ext.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium text-primary">
                      Ext {ext.number}
                      <Badge tone="neutral">{ext.kind}</Badge>
                      {ext.geoLockedAt && <Badge tone="danger">Geo-locked</Badge>}
                    </p>
                    <p className="text-[12px] text-secondary">
                      {ext.user ? (
                        <>
                          {ext.user.name} <span className="text-tertiary">({ext.user.email})</span>
                        </>
                      ) : (
                        <span className="text-tertiary">Unassigned</span>
                      )}
                    </p>
                  </div>

                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={ext.dialPermission}
                        onChange={(v) => setAction({ kind: "dial_permission", ext, dialPermission: v })}
                        options={DIAL_PERMISSION_OPTIONS}
                        aria-label={`Dial permission for extension ${ext.number}`}
                        className="w-40"
                      />
                      {ext.user ? (
                        <Button size="sm" variant="secondary" onClick={() => setAction({ kind: "unassign", ext })}>
                          Unassign
                        </Button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Select
                            value={assignPick[ext.id] ?? null}
                            onChange={(v) => setAssignPick((p) => ({ ...p, [ext.id]: v }))}
                            options={unassignedUsers.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
                            placeholder="Choose a user"
                            aria-label={`Assign a user to extension ${ext.number}`}
                            className="w-56"
                          />
                          <Button
                            size="sm"
                            disabled={!assignPick[ext.id]}
                            onClick={() => {
                              const userId = assignPick[ext.id];
                              const user = unassignedUsers.find((u) => u.id === userId);
                              if (userId && user) {
                                setAction({ kind: "assign", ext, userId, userEmail: user.email });
                              }
                            }}
                          >
                            Assign
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {action && (
        <ConfirmActionDialog
          open
          onClose={() => setAction(null)}
          title={copy[action.kind].title}
          blastRadius={copy[action.kind].blast}
          confirmLabel={copy[action.kind].confirm}
          tone="default"
          onConfirm={submit}
        />
      )}
    </div>
  );
}
