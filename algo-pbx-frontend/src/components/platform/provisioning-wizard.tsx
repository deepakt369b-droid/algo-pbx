"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Circle, Lock, AlertTriangle, UserCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { PROVISIONING_STEPS, type ProvisioningStepId } from "@/lib/platform/provisioning-machine";
import type { ManualCertCommand } from "@/lib/platform/manual-cert-command";

// The provisioning wizard.
//
// Rendered entirely from the step machine, so the list of steps, their order,
// and which one is blocked all come from the same source the API enforces.
// The wizard cannot show a step as available that the server would refuse.
//
// The certificate step is presented as a DELIBERATE GATE, not a failure. The
// distinction matters: an operator who reads "blocked" as "broken" goes
// looking for a bug, or worse, looks for a way around it — and the way around
// this one is handing the CA passphrase to an automated process. So the copy
// says why it is manual, prints the exact command, and offers only "I have
// run this".

type Verdict =
  | { ok: true; step: { id: ProvisioningStepId; label: string; description: string; gate: string } }
  | { ok: false; blocked: true; step: { id: ProvisioningStepId; label: string }; reason: string }
  | { ok: false; done: true };

export function ProvisioningWizard({
  tenantId,
  completed,
  lastError,
  verdict,
  certCommand,
  certPresent,
  isOwner,
  gatewayLanIpKnown,
}: {
  tenantId: string;
  completed: string[];
  lastError: { step: string; message: string } | null;
  verdict: Verdict;
  certCommand: ManualCertCommand;
  certPresent: boolean;
  isOwner: boolean;
  gatewayLanIpKnown: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lanIp, setLanIp] = useState("");
  const [copied, setCopied] = useState(false);

  const done = new Set(completed);
  const currentId = "step" in verdict ? verdict.step.id : null;
  const atCertGate = currentId === "issue_cert";

  async function advance(confirmManualCert = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/provisioning/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmManualCert, ...(lanIp ? { gatewayLanIp: lanIp } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
      if (!res.ok) throw new Error(json?.reason ?? json?.error ?? "The step failed.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The step failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {"done" in verdict && (
        <Card className="border-success/40">
          <CardContent className="p-5">
            <p className="text-[15px] font-semibold text-success">Provisioning complete.</p>
          </CardContent>
        </Card>
      )}

      {/* --- The human certificate gate ---------------------------------- */}
      {atCertGate && (
        <Card className="border-accent/40">
          <CardContent className="space-y-3 p-5" data-testid="cert-gate">
            <div className="flex items-start gap-3">
              <UserCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <div>
                <h2 className="text-[15px] font-semibold text-primary">
                  Certificate signing — manual by design
                </h2>
                <p className="text-[12px] text-secondary">{certCommand.intro}</p>
              </div>
            </div>

            <div className="relative">
              <pre
                data-testid="cert-command"
                className="overflow-x-auto rounded-[var(--radius)] bg-surface-subtle p-3 font-mono text-[12px] text-primary"
              >
                {certCommand.commands.join("\n")}
              </pre>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(certCommand.commands.join("\n"));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="absolute right-2 top-2 rounded-[var(--radius)] border bg-surface px-2 py-1 text-[11px] text-secondary hover:text-primary [border-color:rgb(var(--hairline))]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <ul className="space-y-1">
              {certCommand.warnings.map((w) => (
                <li key={w} className="flex gap-2 text-[11px] text-secondary">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  <span>{w}</span>
                </li>
              ))}
            </ul>

            <p className="text-[11px] text-tertiary">
              Expected afterwards: <span className="font-mono">{certCommand.expectedArtifact}</span>
            </p>

            {certPresent ? (
              <div className="space-y-2">
                <p className="text-[12px] text-success" data-testid="cert-found">
                  Certificate found on the host.
                </p>
                {isOwner && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => advance(true)}
                    data-testid="confirm-cert"
                  >
                    {busy ? "Working…" : "I have run this — continue"}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-warning" data-testid="cert-missing">
                The certificate does not exist yet. Run the command above, then reload this page.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* --- A blocked step other than the cert gate ---------------------- */}
      {"blocked" in verdict && !atCertGate && (
        <Card className="border-warning/40">
          <CardContent className="space-y-2 p-5" data-testid="blocked-step">
            <div className="flex items-start gap-3">
              <Lock size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <div>
                <h2 className="text-[15px] font-semibold text-primary">
                  Blocked at: {verdict.step.label}
                </h2>
                <p className="text-[12px] text-secondary" data-testid="blocked-reason">
                  {verdict.reason}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* --- The next runnable step -------------------------------------- */}
      {verdict.ok && (
        <Card>
          <CardContent className="space-y-3 p-5" data-testid="next-step">
            <div>
              <h2 className="text-[15px] font-semibold text-primary">Next: {verdict.step.label}</h2>
              <p className="text-[12px] text-secondary">{verdict.step.description}</p>
            </div>

            {verdict.step.id === "create_gateway_site" && !gatewayLanIpKnown && (
              <div className="space-y-1.5">
                <Label htmlFor="lan-ip">Gateway LAN IP (optional)</Label>
                <Input
                  id="lan-ip"
                  value={lanIp}
                  onChange={(e) => setLanIp(e.target.value)}
                  placeholder="192.168.1.50"
                  data-testid="gateway-lan-ip"
                />
                <p className="text-[11px] text-tertiary">
                  Only the customer knows this. Left blank it is recorded as unknown rather than
                  guessed — a wrong address here breaks the VPN push later without an obvious cause.
                </p>
              </div>
            )}

            {isOwner ? (
              <Button size="sm" disabled={busy} onClick={() => advance()} data-testid="advance-step">
                {busy ? "Working…" : "Run this step"}
              </Button>
            ) : (
              <p className="text-[12px] text-tertiary">Only a platform owner can advance provisioning.</p>
            )}
          </CardContent>
        </Card>
      )}

      {(error || lastError) && (
        <p role="alert" className="text-[13px] text-danger" data-testid="wizard-error">
          {error ?? `${lastError?.step}: ${lastError?.message}`}
        </p>
      )}

      {/* --- Full pipeline, always visible -------------------------------- */}
      <Card>
        <CardContent className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold text-primary">Pipeline</h2>
          <ol className="space-y-1" data-testid="pipeline-steps">
            {PROVISIONING_STEPS.map((s) => {
              const isDone = done.has(s.id);
              const isCurrent = s.id === currentId;
              return (
                <li
                  key={s.id}
                  data-step={s.id}
                  data-state={isDone ? "done" : isCurrent ? "current" : "pending"}
                  className={`flex items-start gap-3 rounded-[var(--radius)] p-2 ${
                    isCurrent ? "bg-accent-subtle" : ""
                  }`}
                >
                  {isDone ? (
                    <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <Circle size={15} className="mt-0.5 shrink-0 text-tertiary" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[13px] ${isDone ? "text-secondary" : "text-primary"} ${isCurrent ? "font-medium" : ""}`}
                    >
                      {s.label}
                      {s.gate === "human" && (
                        <span className="ml-2 rounded-full bg-surface-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-tertiary">
                          human gate
                        </span>
                      )}
                    </span>
                    {isCurrent && (
                      <span className="block text-[11px] text-secondary">{s.description}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
