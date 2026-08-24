"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

export interface WaInstance {
  id: string;
  label: string;
  simPort: number;
  phoneE164: string | null;
  pushName: string | null;
  provider: "OPENWA" | "META_CLOUD" | "DINSTAR_SMS";
  status: "PAIRING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";
  lastError: string | null;
  sessionName: string | null;
  openwaSessionId: string | null;
  assignedUser: { id: string; name: string; email: string } | null;
}

interface PairingPollResult {
  status: WaInstance["status"];
  providerStatus: string | null;
  qrCode: string | null;
  qrAgeSeconds: number | null;
  pairingCode: string | null;
  phoneE164: string | null;
  pushName: string | null;
  lastError: string | null;
  sidecarReachable: boolean;
}

const POLL_INTERVAL_MS = 2000;
const QR_WINDOW_SECONDS = 20;

const STATUS_STYLE: Record<WaInstance["status"], { dot: string; label: string }> = {
  CONNECTED: { dot: "bg-green-400", label: "Connected" },
  PAIRING: { dot: "bg-cyan animate-pulse", label: "Pairing" },
  DISCONNECTED: { dot: "bg-red-400", label: "Disconnected" },
  LOGGED_OUT: { dot: "bg-slate-500", label: "Logged out" },
};

export function PairingCard({ instance, onChanged }: { instance: WaInstance; onChanged: () => void }) {
  const [poll, setPoll] = useState<PairingPollResult | null>(null);
  const [mode, setMode] = useState<"code" | "qr">("code");
  const [phoneInput, setPhoneInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const isPairing = instance.status === "PAIRING";

  useEffect(() => {
    function stopPolling() {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }

    async function tick() {
      if (document.visibilityState === "hidden") return;
      try {
        const result = await apiFetch<PairingPollResult>(`/api/admin/whatsapp/instances/${instance.id}/pairing`);
        setPoll(result);
        if (result.status === "CONNECTED") {
          stopPolling();
          onChanged();
        }
      } catch {
        // Transient poll failures are surfaced via sidecarReachable on the
        // next success — do not blank the card on one missed poll.
      }
    }

    if (isPairing && instance.provider === "OPENWA") {
      void tick();
      pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
    }
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, instance.status, instance.provider]);

  const act = async (action: "refresh" | "logout" | "repair" | "forceKill") => {
    setBusy(action);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/whatsapp/instances/${instance.id}`, { method: "PATCH", body: { action } });
      setMessage({ kind: "ok", text: `${action === "repair" ? "Re-pairing started" : action} succeeded.` });
      onChanged();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Request failed." });
    } finally {
      setBusy(null);
    }
  };

  const requestPairingCode = async () => {
    setBusy("pairing-code");
    setMessage(null);
    try {
      await apiFetch(`/api/admin/whatsapp/instances/${instance.id}/pairing-code`, {
        method: "POST",
        body: { phoneNumber: phoneInput.replace(/[^\d]/g, "") },
      });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not request a pairing code." });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (force: boolean) => {
    setBusy("remove");
    setMessage(null);
    try {
      await apiFetch(`/api/admin/whatsapp/instances/${instance.id}${force ? "?force=1" : ""}`, { method: "DELETE" });
      onChanged();
      setRemoveFailed(false);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not remove this instance." });
      setRemoveFailed(true);
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  const style = STATUS_STYLE[instance.status];
  const lastError = poll?.lastError ?? instance.lastError;
  const qrAge = poll?.qrAgeSeconds ?? null;
  const qrExpired = qrAge !== null && qrAge > QR_WINDOW_SECONDS;

  return (
    <div className="glass-card flex w-full flex-col gap-3 p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-slate-100">
            {instance.label} <span className="text-xs text-slate-500">(SIM {instance.simPort})</span>
          </p>
          <p className="text-xs text-slate-500">{poll?.phoneE164 ?? instance.phoneE164 ?? "not yet linked"}</p>
          {(poll?.pushName ?? instance.pushName) && (
            <p className="text-xs text-slate-500">{poll?.pushName ?? instance.pushName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          <span className="text-xs font-medium text-slate-300">{style.label}</span>
        </div>
      </div>

      {instance.assignedUser ? (
        <p className="text-xs text-slate-400">
          Assigned to <span className="text-slate-200">{instance.assignedUser.name}</span>
        </p>
      ) : (
        <p className="text-xs text-slate-600">Not assigned to an agent yet.</p>
      )}

      {poll && !poll.sidecarReachable && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          The WhatsApp sidecar is unreachable right now — pairing status can&apos;t be refreshed until it&apos;s back.
        </div>
      )}

      {lastError && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{lastError}</div>
      )}

      {isPairing && instance.provider === "OPENWA" && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setMode("code")}
              className={`rounded px-2 py-1 ${mode === "code" ? "bg-cyan text-background" : "text-slate-400"}`}
            >
              Pairing code
            </button>
            <button
              onClick={() => setMode("qr")}
              className={`rounded px-2 py-1 ${mode === "qr" ? "bg-cyan text-background" : "text-slate-400"}`}
            >
              Scan QR instead
            </button>
          </div>

          {mode === "code" ? (
            <div className="flex flex-col items-center gap-3">
              {poll?.pairingCode ? (
                <>
                  <p className="text-xs text-slate-400">
                    On the phone: WhatsApp → Settings → Linked Devices → Link with phone number instead
                  </p>
                  <button
                    onClick={() => navigator.clipboard?.writeText(poll.pairingCode ?? "")}
                    className="rounded-lg bg-surface px-6 py-3 font-mono text-2xl tracking-widest text-cyan"
                    title="Copy"
                  >
                    {poll.pairingCode}
                  </button>
                  <p className="text-xs text-slate-500">Tap the code to copy it.</p>
                </>
              ) : (
                <div className="flex w-full max-w-xs flex-col gap-2">
                  <input
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="971544887712 (digits only)"
                    className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
                  />
                  <button
                    onClick={requestPairingCode}
                    disabled={busy === "pairing-code" || phoneInput.replace(/[^\d]/g, "").length < 7}
                    className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
                  >
                    {busy === "pairing-code" ? "Requesting…" : "Get pairing code"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {poll?.qrCode ? (
                <>
                  <img src={poll.qrCode} alt="WhatsApp pairing QR code" className={`h-48 w-48 ${qrExpired ? "opacity-30" : ""}`} />
                  <p className="text-xs text-slate-500">
                    {qrExpired ? "Expired — refreshing…" : `Scan with WhatsApp · refreshes automatically`}
                  </p>
                </>
              ) : (
                <p className="py-8 text-xs text-slate-500">Waiting for a QR code…</p>
              )}
            </div>
          )}
        </div>
      )}

      {message && (
        <p className={`text-xs ${message.kind === "error" ? "text-red-400" : "text-green-400"}`}>{message.text}</p>
      )}

      <div className="flex flex-wrap gap-3 border-t border-border pt-3">
        <button onClick={() => act("refresh")} disabled={busy === "refresh"} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50">
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
        {instance.status !== "CONNECTED" && (
          <button onClick={() => act("repair")} disabled={busy === "repair"} className="text-xs text-cyan hover:underline disabled:opacity-50">
            {busy === "repair" ? "Re-pairing…" : "Re-pair"}
          </button>
        )}
        {instance.status === "CONNECTED" && (
          <button onClick={() => act("logout")} disabled={busy === "logout"} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
            {busy === "logout" ? "Logging out…" : "Log out"}
          </button>
        )}
        <button onClick={() => act("forceKill")} disabled={busy === "forceKill"} className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50">
          Force-kill
        </button>
        {!confirmRemove ? (
          <button onClick={() => setConfirmRemove(true)} className="text-xs text-red-400 hover:text-red-300">
            Remove
          </button>
        ) : (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Remove &quot;{instance.label}&quot;?</span>
            <button onClick={() => remove(false)} disabled={busy === "remove"} className="text-red-400 hover:text-red-300">
              Confirm
            </button>
            <button onClick={() => setConfirmRemove(false)} className="text-slate-500 hover:text-slate-300">
              Cancel
            </button>
          </span>
        )}
        <button onClick={() => setShowTechnical((v) => !v)} className="ml-auto text-xs text-slate-600 hover:text-slate-400">
          {showTechnical ? "Hide" : "Technical details"}
        </button>
      </div>

      {removeFailed && (
        <button onClick={() => remove(true)} className="self-start text-xs text-red-400 underline hover:text-red-300">
          Force remove anyway (leaves the sidecar session orphaned)
        </button>
      )}

      {showTechnical && (
        <div className="rounded-lg bg-background/60 px-3 py-2 text-xs text-slate-500">
          <p>sessionName: {instance.sessionName ?? "—"}</p>
          <p>openwaSessionId: {instance.openwaSessionId ?? "—"}</p>
          <p>providerStatus: {poll?.providerStatus ?? "—"}</p>
        </div>
      )}
    </div>
  );
}
