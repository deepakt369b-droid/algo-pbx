"use client";

import { useEffect, useId, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";

// THE destructive-action primitive for the platform console.
//
// Every consequential action in this console goes through this component, and
// none rolls its own confirm. That is a deliberate constraint, not tidiness:
// the three guarantees below are requirements, and a bespoke dialog is where
// one of them quietly goes missing.
//
//   1. The blast radius is restated in the operator's own terms, using the
//      wording from src/lib/platform/blast-radius.ts. In particular the
//      suspend/telephony distinction ("Calls are NOT affected") must read
//      identically everywhere, or an operator who sees it on one screen and
//      not the next will assume the second one does cut calls.
//   2. A reason is mandatory. It is enforced again at the API layer — this is
//      the humane half, not the security half — because a reason typed six
//      months ago is the only thing that makes an audit row mean anything.
//   3. Irreversible actions additionally require typing an exact confirmation
//      string, so muscle memory cannot carry someone through.
//
// The submit button stays disabled until every requirement is satisfied, and
// the dialog says WHY it is disabled rather than leaving the operator to
// guess which field it is unhappy about.

export interface ConfirmActionDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** From src/lib/platform/blast-radius.ts. Never hand-written at the call
   * site — that is how the mandated wording drifts. */
  blastRadius: string;
  /** When set, the operator must type this string exactly (e.g. the tenant
   * slug). Reserve it for actions that cause an outage or cannot be undone. */
  requireTypedConfirmation?: string;
  /** Label for the typed-confirmation field, e.g. "tenant slug". */
  typedConfirmationLabel?: string;
  confirmLabel?: string;
  /** "danger" for anything that removes access or stops calls. */
  tone?: "danger" | "default";
  /** Extra context rendered above the reason field — e.g. the offboard
   * step list, or what a plan change costs. */
  children?: React.ReactNode;
  /** Receives the trimmed reason. Throw to surface an error in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

export function ConfirmActionDialog({
  open,
  onClose,
  title,
  blastRadius,
  requireTypedConfirmation,
  typedConfirmationLabel = "confirmation",
  confirmLabel = "Confirm",
  tone = "danger",
  children,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const typedId = useId();

  // Reopening must never inherit the previous action's reason — that is how a
  // reason ends up attached to the wrong tenant in the audit log.
  useEffect(() => {
    if (open) {
      setReason("");
      setTyped("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const reasonOk = reason.trim().length > 0;
  const typedOk = !requireTypedConfirmation || typed === requireTypedConfirmation;
  const canSubmit = reasonOk && typedOk && !submitting;

  const blockedBecause = !reasonOk
    ? "Enter a reason to continue."
    : !typedOk
      ? `Type ${requireTypedConfirmation} exactly to continue.`
      : null;

  async function handleConfirm() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action failed. Nothing was changed.");
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={submitting ? () => {} : onClose} title={title} size="md">
      <div className="space-y-4">
        <p
          data-testid="blast-radius"
          className={
            tone === "danger"
              ? "rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger"
              : "rounded-[var(--radius)] border border-hairline bg-surface-subtle p-3 text-[13px] text-secondary"
          }
        >
          {blastRadius}
        </p>

        {children}

        <div className="space-y-1.5">
          <Label htmlFor={reasonId}>
            Reason <span className="text-danger">*</span>
          </Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            placeholder="Why are you doing this? Recorded in the platform audit log."
            data-testid="confirm-reason"
          />
          <p className="text-[11px] text-tertiary">
            Mandatory, and recorded against this action permanently.
          </p>
        </div>

        {requireTypedConfirmation && (
          <div className="space-y-1.5">
            <Label htmlFor={typedId}>
              Type <code className="font-mono text-primary">{requireTypedConfirmation}</code> to
              confirm the {typedConfirmationLabel}
            </Label>
            <Input
              id={typedId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-testid="confirm-typed"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-[13px] text-danger" data-testid="confirm-error">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {blockedBecause && (
            <p className="mr-auto text-[11px] text-tertiary" data-testid="confirm-blocked-reason">
              {blockedBecause}
            </p>
          )}
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={handleConfirm}
            disabled={!canSubmit}
            data-testid="confirm-submit"
          >
            {submitting ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
