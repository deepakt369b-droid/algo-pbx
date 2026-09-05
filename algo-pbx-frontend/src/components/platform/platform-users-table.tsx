"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import {
  platformUserDisableBlastRadius,
  platformOwnerCreateBlastRadius,
} from "@/lib/platform/blast-radius";
import {
  canDisable,
  canChangeRole,
  type PlatformUserView,
} from "@/lib/platform/user-guardrails";

// The platform user list and its actions.
//
// Guardrails are evaluated here too — with the same pure functions the API
// uses — but only so the UI can EXPLAIN why an action is unavailable before
// the operator clicks. The API is the enforcement; this is the courtesy. A
// disabled button with a tooltip saying "this is the last owner; create
// another first" is far more useful than a 409 after the fact.
//
// The one-time password is shown exactly once, in a panel that says so. It is
// never re-fetchable, because it is never stored.

interface Row {
  id: string;
  email: string;
  name: string;
  role: "PLATFORM_OWNER" | "PLATFORM_SUPPORT";
  disabled: boolean;
  disabledAt: string | null;
  lastLoginAt: string | null;
  totpConfirmedAt: string | null;
  mustChangePassword: boolean;
  createdAt: string;
}

type Pending =
  | { kind: "disable"; user: Row }
  | { kind: "enable"; user: Row }
  | { kind: "role"; user: Row; to: "PLATFORM_OWNER" | "PLATFORM_SUPPORT" }
  | { kind: "totp"; user: Row }
  | { kind: "create" }
  | null;

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

export function PlatformUsersTable({
  users,
  currentUserId,
  currentRole,
  enabledOwners,
}: {
  users: Row[];
  currentUserId: string;
  currentRole: "PLATFORM_OWNER" | "PLATFORM_SUPPORT";
  enabledOwners: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-user form state.
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"PLATFORM_OWNER" | "PLATFORM_SUPPORT">("PLATFORM_SUPPORT");

  const isOwner = currentRole === "PLATFORM_OWNER";
  const views: PlatformUserView[] = users.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    disabled: u.disabled,
  }));

  async function submit(reason: string) {
    setError(null);
    if (!pending) return;

    if (pending.kind === "create") {
      const res = await fetch("/api/platform/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          role,
          reason,
          ...(role === "PLATFORM_OWNER" ? { confirmEmail: email } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { oneTimePassword?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not create the account.");
      setIssued({ email, password: json?.oneTimePassword ?? "" });
      setEmail("");
      setName("");
      setRole("PLATFORM_SUPPORT");
      router.refresh();
      return;
    }

    const body: Record<string, unknown> = { reason };
    if (pending.kind === "disable") body.action = "disable";
    if (pending.kind === "enable") body.action = "enable";
    if (pending.kind === "totp") body.action = "reset_totp";
    if (pending.kind === "role") {
      body.action = "change_role";
      body.role = pending.to;
      if (pending.to === "PLATFORM_OWNER") body.confirmEmail = pending.user.email;
    }

    const res = await fetch(`/api/platform/users/${pending.user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(json?.error ?? "The action failed.");
    }
    router.refresh();
  }

  const dialog = (() => {
    if (!pending) return null;
    if (pending.kind === "create") {
      return {
        title: "Create platform user",
        blast:
          role === "PLATFORM_OWNER"
            ? platformOwnerCreateBlastRadius(email || "this account")
            : `Creates ${email || "a new account"} as PLATFORM_SUPPORT. They will see every tenant's existence and status, but cannot read any tenant's data without a time-boxed support grant.`,
        confirm: "Create account",
        typed: role === "PLATFORM_OWNER" ? email : undefined,
        label: "email",
      };
    }
    if (pending.kind === "disable") {
      return {
        title: "Disable platform user",
        blast: platformUserDisableBlastRadius(pending.user.email),
        confirm: "Disable account",
      };
    }
    if (pending.kind === "enable") {
      return {
        title: "Enable platform user",
        blast: `Restores console access for ${pending.user.email}. They will still need their password and TOTP.`,
        confirm: "Enable account",
      };
    }
    if (pending.kind === "totp") {
      return {
        title: "Reset TOTP",
        blast: `Clears ${pending.user.email}'s authenticator enrolment. They must enrol a new one at their next login before reaching the console. Use this when someone has lost their device.`,
        confirm: "Reset TOTP",
      };
    }
    return {
      title: pending.to === "PLATFORM_OWNER" ? "Promote to owner" : "Demote to support",
      blast:
        pending.to === "PLATFORM_OWNER"
          ? platformOwnerCreateBlastRadius(pending.user.email)
          : `Removes ${pending.user.email}'s ability to provision, bill, offboard, or cut a dialplan. They keep read access and can still request support grants.`,
      confirm: pending.to === "PLATFORM_OWNER" ? "Promote to owner" : "Demote",
      typed: pending.to === "PLATFORM_OWNER" ? pending.user.email : undefined,
      label: "email",
    };
  })();

  return (
    <div className="space-y-4">
      {issued && (
        <Card className="border-accent/40">
          <CardContent className="space-y-2 p-5" data-testid="one-time-password">
            <h2 className="text-[15px] font-semibold text-primary">
              One-time password for {issued.email}
            </h2>
            <code className="block break-all rounded-[var(--radius)] bg-surface-subtle p-3 font-mono text-[13px] text-primary">
              {issued.password}
            </code>
            <p className="text-[12px] text-warning">
              Shown once. It is not stored in plaintext and cannot be retrieved again — if it is
              lost, reissue the account rather than hunting for it.
            </p>
            <p className="text-[12px] text-secondary">
              They must change it and enrol TOTP at first login before reaching anything.
            </p>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              I have saved it
            </Button>
          </CardContent>
        </Card>
      )}

      {isOwner && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <h2 className="text-[15px] font-semibold text-primary">Create account</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-email">Email</Label>
                <Input
                  id="new-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="new-user-email"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-name">Name</Label>
                <Input
                  id="new-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="new-user-name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-role">Role</Label>
                <select
                  id="new-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as typeof role)}
                  data-testid="new-user-role"
                  className="h-9 w-full rounded-[var(--radius)] border bg-surface px-2 text-[13px] text-primary [border-color:rgb(var(--hairline))]"
                >
                  <option value="PLATFORM_SUPPORT">PLATFORM_SUPPORT</option>
                  <option value="PLATFORM_OWNER">PLATFORM_OWNER</option>
                </select>
              </div>
            </div>
            <Button
              size="sm"
              disabled={!email || !name}
              onClick={() => setPending({ kind: "create" })}
              data-testid="action-create-user"
            >
              Create account
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-left text-[13px]" data-testid="platform-users-table">
            <thead className="border-b text-[11px] uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">TOTP</th>
                <th className="px-4 py-3 font-medium">Last login</th>
                <th className="px-4 py-3 font-medium">State</th>
                {isOwner && <th className="px-4 py-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === currentUserId;
                const disableVerdict = canDisable(
                  { id: u.id, email: u.email, role: u.role, disabled: u.disabled },
                  views,
                  currentUserId
                );
                const demoteVerdict = canChangeRole(
                  { id: u.id, email: u.email, role: u.role, disabled: u.disabled },
                  u.role === "PLATFORM_OWNER" ? "PLATFORM_SUPPORT" : "PLATFORM_OWNER",
                  views,
                  currentUserId
                );

                return (
                  <tr
                    key={u.id}
                    data-testid="platform-user-row"
                    data-email={u.email}
                    data-role={u.role}
                    className="border-b last:border-0 [border-color:rgb(var(--hairline))]"
                  >
                    <td className="px-4 py-3">
                      <span className="text-primary">{u.email}</span>
                      <span className="block text-[11px] text-tertiary">
                        {u.name}
                        {self && " · you"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={u.role === "PLATFORM_OWNER" ? "accent" : "neutral"}>
                        {u.role === "PLATFORM_OWNER" ? "Owner" : "Support"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {u.totpConfirmedAt ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <ShieldCheck size={13} /> Enrolled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <ShieldAlert size={13} /> Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-secondary">{fmt(u.lastLoginAt)}</td>
                    <td className="px-4 py-3">
                      {u.disabled ? (
                        <Badge tone="danger">Disabled</Badge>
                      ) : u.mustChangePassword ? (
                        <Badge tone="warning">Setup pending</Badge>
                      ) : (
                        <Badge tone="success">Enabled</Badge>
                      )}
                    </td>
                    {isOwner && (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {u.disabled ? (
                            <Button size="sm" variant="secondary" onClick={() => setPending({ kind: "enable", user: u })}>
                              Enable
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!disableVerdict.ok}
                              title={disableVerdict.ok ? undefined : disableVerdict.reason}
                              onClick={() => setPending({ kind: "disable", user: u })}
                              data-testid="action-disable-user"
                            >
                              Disable
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!demoteVerdict.ok}
                            title={demoteVerdict.ok ? undefined : demoteVerdict.reason}
                            onClick={() =>
                              setPending({
                                kind: "role",
                                user: u,
                                to: u.role === "PLATFORM_OWNER" ? "PLATFORM_SUPPORT" : "PLATFORM_OWNER",
                              })
                            }
                            data-testid="action-change-role"
                          >
                            {u.role === "PLATFORM_OWNER" ? "Demote" : "Promote"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={u.disabled}
                            onClick={() => setPending({ kind: "totp", user: u })}
                            data-testid="action-reset-totp"
                          >
                            Reset TOTP
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-[11px] text-tertiary" data-testid="owner-count">
        {enabledOwners} enabled platform owner{enabledOwners === 1 ? "" : "s"}. The last one cannot
        be disabled or demoted — losing it would leave nobody able to provision, bill or offboard.
      </p>

      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      {pending && dialog && (
        <ConfirmActionDialog
          open
          onClose={() => setPending(null)}
          title={dialog.title}
          blastRadius={dialog.blast}
          confirmLabel={dialog.confirm}
          requireTypedConfirmation={dialog.typed}
          typedConfirmationLabel={dialog.label ?? "confirmation"}
          tone={pending.kind === "enable" ? "default" : "danger"}
          onConfirm={submit}
        />
      )}
    </div>
  );
}
