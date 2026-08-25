"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// The four fixed slots mirror the Dinstar's physical GSM ports 1-4. Every
// slot is ALWAYS on screen — empty ones offer inline start-pairing right in
// place, paired ones keep their pairing code (big, tap-to-copy) or QR
// visible simultaneously — so an operator can link all four phones in one
// sitting instead of scrolling a create-form-plus-list page.
export const SIM_PORTS = [1, 2, 3, 4] as const;

function usePairingPoll(instance: WaInstance | null, onConnected: () => void) {
  const [poll, setPoll] = useState<PairingPollResult | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    function stopPolling() {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    }

    async function tick() {
      if (!instance || document.visibilityState === "hidden") return;
      try {
        const result = await apiFetch<PairingPollResult>(`/api/admin/whatsapp/instances/${instance.id}/pairing`);
        setPoll(result);
        if (result.status === "CONNECTED") {
          stopPolling();
          onConnectedRef.current();
        }
      } catch {
        // Transient poll failures are surfaced via sidecarReachable on the
        // next success — do not blank the slot on one missed poll.
      }
    }

    const isPairing = instance?.status === "PAIRING" && instance?.provider === "OPENWA";
    if (isPairing) {
      void tick();
      pollTimer.current = setInterval(tick, POLL_INTERVAL_MS);
    } else {
      // Status left PAIRING without this poll loop observing it (e.g.
      // another admin re-paired) — drop stale code/QR data so a slot that
      // is no longer pairing doesn't keep showing an old code.
      setPoll(null);
    }
    return stopPolling;
    // Depend only on the identity fields the tick body reads — the parent
    // refreshes the instances array every 5s (new object identities), and
    // keying the effect on the object itself would tear down/restart the
    // poll interval on every one of those refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.id, instance?.status, instance?.provider]);

  return poll;
}

interface SlotActionsProps {
  instance: WaInstance;
  onChanged: () => void;
}

/** Per-instance action row + banners shared by every non-empty slot. */
function SlotFooter({ instance, onChanged }: SlotActionsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

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

  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
      {message && (
        <p className={`text-xs ${message.kind === "error" ? "text-red-400" : "text-green-400"}`}>{message.text}</p>
      )}
      <div className="flex flex-wrap gap-3">
        <button onClick={() => act("refresh")} disabled={busy !== null} className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50">
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
        {instance.status !== "CONNECTED" && (
          <button onClick={() => act("repair")} disabled={busy !== null} className="text-xs text-cyan hover:underline disabled:opacity-50">
            {busy === "repair" ? "Re-pairing…" : "Re-pair"}
          </button>
        )}
        {instance.status === "CONNECTED" && (
          <button onClick={() => act("logout")} disabled={busy !== null} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
            {busy === "logout" ? "Logging out…" : "Log out"}
          </button>
        )}
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
          {showTechnical ? "Hide" : "Details"}
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
        </div>
      )}
    </div>
  );
}

interface InstanceSlotProps {
  instance: WaInstance;
  onChanged: () => void;
}

/** One occupied grid cell: compact header, scan-ready code/QR area, footer actions. */
function InstanceSlot({ instance, onChanged }: InstanceSlotProps) {
  const poll = usePairingPoll(instance, onChanged);
  const [mode, setMode] = useState<"code" | "qr">("code");
  const [phoneInput, setPhoneInput] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);

  const style = STATUS_STYLE[instance.status];
  const lastError = poll?.lastError ?? instance.lastError;
  const qrAge = poll?.qrAgeSeconds ?? null;
  const qrExpired = qrAge !== null && qrAge > QR_WINDOW_SECONDS;

  const requestPairingCode = async () => {
    setCodeBusy(true);
    try {
      await apiFetch(`/api/admin/whatsapp/instances/${instance.id}/pairing-code`, {
        method: "POST",
        body: { phoneNumber: phoneInput.replace(/[^\d]/g, "") },
      });
    } catch (err) {
      // surfaced by the next poll / lastError banner
      void (err instanceof ApiError && console.warn(err.message));
    } finally {
      setCodeBusy(false);
    }
  };

  const isPairing = instance.status === "PAIRING" && instance.provider === "OPENWA";

  return (
    <div className="glass-card flex min-h-[16rem] flex-col gap-3 p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-100">{instance.label}</p>
          <p className="text-xs text-slate-500">{poll?.phoneE164 ?? instance.phoneE164 ?? "not yet linked"}</p>
          {(poll?.pushName ?? instance.pushName) && (
            <p className="truncate text-xs text-slate-500">{poll?.pushName ?? instance.pushName}</p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-background/60 px-2 py-1">
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          <span className="text-[11px] font-medium text-slate-300">SIM {instance.simPort} · {style.label}</span>
        </div>
      </div>

      {(poll && !poll.sidecarReachable) && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          Sidecar unreachable — pairing status can&apos;t refresh until it&apos;s back.
        </div>
      )}
      {lastError && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{lastError}</div>
      )}

      {/* Scan-ready area */}
      {isPairing && mode === "code" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          {poll?.pairingCode ? (
            <>
              <p className="text-center text-[11px] text-slate-500">
                On the phone: WhatsApp → Linked Devices → Link with phone number instead
              </p>
              <button
                onClick={() => navigator.clipboard?.writeText(poll.pairingCode ?? "")}
                className="rounded-lg bg-surface px-6 py-3 font-mono text-2xl tracking-widest text-cyan"
                title="Copy"
                aria-label={`Pairing code ${poll.pairingCode}, click to copy`}
              >
                {poll.pairingCode}
              </button>
              <p className="text-[11px] text-slate-600">Tap to copy · refreshes automatically</p>
            </>
          ) : (
            <div className="flex w-full max-w-xs flex-col gap-2">
              <input
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="SIM's WhatsApp number, digits only"
                aria-label={`WhatsApp number for SIM port ${instance.simPort}`}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
              />
              <button
                onClick={requestPairingCode}
                disabled={codeBusy || phoneInput.replace(/[^\d]/g, "").length < 7}
                className="w-full rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
              >
                {codeBusy ? "Requesting…" : "Get pairing code"}
              </button>
            </div>
          )}
        </div>
      )}

      {isPairing && mode === "qr" && (
        <div className="flex flex-1 items-center justify-center">
          {poll?.qrCode ? (
            <div className="flex flex-col items-center gap-1">
              {/* data-URL QR from the sidecar — next/image can't optimize data URLs */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={poll.qrCode} alt={`WhatsApp pairing QR for SIM port ${instance.simPort}`} className={`h-40 w-40 ${qrExpired ? "opacity-30" : ""}`} />
              <p className="text-[11px] text-slate-500">{qrExpired ? "Expired — refreshing…" : "Scan with the phone's camera"}</p>
            </div>
          ) : (
            <p className="py-6 text-xs text-slate-500">Waiting for a QR code…</p>
          )}
        </div>
      )}

      {instance.status === "CONNECTED" && (
        <div className="flex flex-1 items-center justify-center py-2">
          <p className="text-sm text-green-400">Linked{instance.assignedUser ? ` · assigned to ${instance.assignedUser.name}` : " · no agent assigned yet"}</p>
        </div>
      )}

      {/* Mode toggle only matters while pairing; hide once connected */}
      {isPairing && (
        <div className="flex gap-2 self-start text-xs">
          <button
            onClick={() => setMode("code")}
            className={`rounded px-2 py-1 ${mode === "code" ? "bg-cyan text-background" : "text-slate-400"}`}
          >
            Code
          </button>
          <button
            onClick={() => setMode("qr")}
            className={`rounded px-2 py-1 ${mode === "qr" ? "bg-cyan text-background" : "text-slate-400"}`}
          >
            Scan QR instead
          </button>
        </div>
      )}

      <SlotFooter instance={instance} onChanged={onChanged} />
    </div>
  );
}

interface EmptySlotProps {
  simPort: number;
  onCreated: () => void;
}

/** One vacant grid cell: start pairing inline, right where the card will be. */
function EmptySlot({ simPort, onCreated }: EmptySlotProps) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await apiFetch("/api/admin/whatsapp/instances", {
        method: "POST",
        body: { label: label.trim(), simPort, provider: "OPENWA" },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start pairing.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="glass-card flex min-h-[16rem] flex-col items-center justify-center gap-3 p-5">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-slate-600" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">SIM Port {simPort}</span>
      </div>
      <p className="max-w-[16rem] text-center text-xs text-slate-500">
        Vacant. Enter the SIM&apos;s label to start pairing this port.
      </p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={`Label, e.g. SIM ${simPort} — +971 5X XXX XXXX`}
        aria-label={`Label for SIM port ${simPort}`}
        className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
      />
      <button
        onClick={create}
        disabled={creating || !label.trim()}
        className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {creating ? "Starting…" : "Start pairing"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function SimPortBoard({
  instances,
  loadError,
  onChanged,
}: {
  instances: WaInstance[];
  loadError: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const byPort = new Map(instances.map((i) => [i.simPort, i]));
  // Stable callback identity keeps per-slot poll effects from churning when
  // the parent re-renders on its own 5s instance-list refresh.
  const handleChanged = useCallback(() => void onChanged(), [onChanged]);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-3">
      {loadError && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">{loadError}</div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {SIM_PORTS.map((port) => {
          const instance = byPort.get(port);
          return instance ? (
            <InstanceSlot key={instance.id} instance={instance} onChanged={handleChanged} />
          ) : (
            <EmptySlot key={`empty-${port}`} simPort={port} onCreated={handleChanged} />
          );
        })}
      </div>
    </div>
  );
}
