"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { type SerialisedTenantDetail, type PlatformRole, fmtDateTime } from "./types";

// Tenant user management (plan §1/§3.1: "No tenant-user management — the
// owner cannot see or act on users INSIDE a tenant").
//
// Listing is available to any platform session (owner or support) — the GET
// route is not gated to owner-only, same reasoning as the rest of this
// page's read-only surfaces. Every mutating action (disable, enable, change
// role, reset password) is owner-only and goes through
// ConfirmActionDialog, same as every other consequential action in this
// console — a reason is mandatory and is enforced again server-side.

interface TenantUserRow {
  id: string;
  email: string;
  name: string;
  role: "AGENT" | "SUPERVISOR" | "ADMIN";
  disabled: boolean;
  disabledAt: string | null;
  createdAt: string;
  extensionNumber: string | null;
  lastLoginAt: string | null;
}

type Action =
  | { kind: "disable"; user: TenantUserRow }
  | { kind: "enable"; user: TenantUserRow }
  | { kind: "reset_password"; user: TenantUserRow }
  | { kind: "change_role"; user: TenantUserRow; role: "AGENT" | "SUPERVISOR" | "ADMIN" }
  | null;

const ROLE_OPTIONS = [
  { value: "AGENT" as const, label: "Agent" },
  { value: "SUPERVISOR" as const, label: "Supervisor" },
  { value: "ADMIN" as const, label: "Admin" },
];

export function UsersTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const { tenant } = detail;
  const isOwner = role === "PLATFORM_OWNER";
  const [users, setUsers] = useState<TenantUserRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [pendingRole, setPendingRole] = useState<Record<string, "AGENT" | "SUPERVISOR" | "ADMIN">>({});

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenant.id}/users`);
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(err?.error ?? "Could not load users.");
      }
      const json = (await res.json()) as { users: TenantUserRow[] };
      setUsers(json.users);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load users.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function submit(reason: string) {
    if (!action) return;
    const body: Record<string, unknown> =
      action.kind === "change_role"
        ? { action: "change_role", role: action.role, reason }
        : { action: action.kind, reason };

    const res = await fetch(`/api/platform/tenants/${tenant.id}/users/${action.user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) throw new Error(json?.error ?? "The action failed. Nothing was changed.");
    await load();
  }

  const copy: Record<
    Exclude<Action, null>["kind"],
    { title: string; blast: string; confirm: string }
  > = {
    disable: {
      title: "Disable user",
      blast:
        action?.kind === "disable"
          ? `This ends ${action.user.email}'s login on their next request and removes their extension from the support queue, if they have one.`
          : "",
      confirm: "Disable user",
    },
    enable: {
      title: "Enable user",
      blast:
        action?.kind === "enable"
          ? `This restores ${action.user.email}'s login and re-adds their extension to the support queue, if they have one.`
          : "",
      confirm: "Enable user",
    },
    reset_password: {
      title: "Reset password",
      blast:
        action?.kind === "reset_password"
          ? `This sends ${action.user.email} a single-use, 24-hour password reset link. It does not change their password directly — they set a new one themselves.`
          : "",
      confirm: "Send reset link",
    },
    change_role: {
      title: "Change role",
      blast:
        action?.kind === "change_role"
          ? `This changes ${action.user.email}'s role from ${action.user.role} to ${action.role}.`
          : "",
      confirm: "Change role",
    },
  };

  return (
    <div className="space-y-4" data-testid="users-tab">
      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-primary">Tenant users</h2>
            <span className="text-[12px] text-tertiary">{users?.length ?? "…"} total</span>
          </div>

          {loadError && (
            <p role="alert" className="mb-2 text-[12px] text-danger">
              {loadError}
            </p>
          )}

          {!users ? (
            <p className="py-2 text-[13px] text-tertiary">Loading…</p>
          ) : users.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary">No users in this tenant yet.</p>
          ) : (
            <ul className="space-y-2" data-testid="tenant-user-list">
              {users.map((u) => (
                <li
                  key={u.id}
                  data-testid="tenant-user-row"
                  data-disabled={u.disabled}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-primary">
                      {u.name}
                      <span className="font-normal text-tertiary">{u.email}</span>
                      <Badge tone="neutral">{u.role}</Badge>
                      {u.disabled ? (
                        <Badge tone="danger">Disabled</Badge>
                      ) : (
                        <Badge tone="success">Active</Badge>
                      )}
                      {u.extensionNumber && (
                        <span className="font-mono text-[11px] text-tertiary">ext {u.extensionNumber}</span>
                      )}
                    </p>
                    <p className="text-[11px] text-tertiary">
                      Created {fmtDateTime(u.createdAt)}
                      {u.disabled && u.disabledAt ? ` · disabled ${fmtDateTime(u.disabledAt)}` : ""}
                    </p>
                  </div>

                  {isOwner && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        aria-label={`Change role for ${u.email}`}
                        value={pendingRole[u.id] ?? u.role}
                        onChange={(v) => setPendingRole((p) => ({ ...p, [u.id]: v }))}
                        options={ROLE_OPTIONS}
                        className="w-36"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={(pendingRole[u.id] ?? u.role) === u.role}
                        onClick={() =>
                          setAction({ kind: "change_role", user: u, role: pendingRole[u.id] ?? u.role })
                        }
                        data-testid="action-change-role"
                      >
                        Apply role
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAction({ kind: "reset_password", user: u })}
                        data-testid="action-reset-password"
                      >
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant={u.disabled ? "secondary" : "danger"}
                        onClick={() => setAction({ kind: u.disabled ? "enable" : "disable", user: u })}
                        data-testid={u.disabled ? "action-enable-user" : "action-disable-user"}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!isOwner && (
            <p className="mt-3 text-[11px] text-tertiary">
              Only a platform owner can disable, enable, reset a password, or change a role.
            </p>
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
          tone={action.kind === "disable" ? "danger" : "default"}
          onConfirm={submit}
        />
      )}
    </div>
  );
}
