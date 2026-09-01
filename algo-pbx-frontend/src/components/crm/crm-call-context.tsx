"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useSIP } from "@/contexts/sip-context";

// CrmCallContext (node W, W2) — a tiny client-only store holding the CRM
// identity of the call currently in progress. It is deliberately NOT a
// change to SIPProvider: sip-context.tsx stays telephony-only and read-only
// for this node. Both call-initiation sites write here —
//   (a) a "Call" button on a CRM contact/deal, via useCrmCall()
//   (b) src/components/dialpad.tsx, which sets { number } on dial
// — so that an OUTBOUND call finally carries CRM context (the dialed number
// used to live only inside Dialpad's local state; see LLM.md §31 / plan G4).
//
// Inbound calls are resolved separately by ScreenPop from
// useSIP().incomingCallerId; when the agent opens that contact, ScreenPop
// also calls setCallIdentity so the popover and the post-call disposition
// prompt know who the live call is with.

export interface CrmCallIdentity {
  /** null until an inbound number is known / an outbound number is dialled */
  number: string | null;
  contactId?: string | null;
  contactName?: string | null;
}

interface CrmCallContextValue {
  identity: CrmCallIdentity | null;
  /** Set/replace the identity of the call in progress. */
  setCallIdentity: (identity: CrmCallIdentity | null) => void;
  /** Merge fields into the current identity (e.g. attach a contactId later). */
  mergeCallIdentity: (patch: Partial<CrmCallIdentity>) => void;
  /**
   * The identity captured for the MOST RECENT call, retained one beat after
   * callState returns to idle so DispositionPrompt can still read who the
   * just-ended call was with. Cleared when a new call starts.
   */
  lastIdentity: CrmCallIdentity | null;
}

const Ctx = createContext<CrmCallContextValue | null>(null);

export function CrmCallProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<CrmCallIdentity | null>(null);
  const [lastIdentity, setLastIdentity] = useState<CrmCallIdentity | null>(null);
  const identityRef = useRef<CrmCallIdentity | null>(null);
  identityRef.current = identity;

  const setCallIdentity = useCallback((next: CrmCallIdentity | null) => {
    if (next) {
      setLastIdentity(next);
      setIdentity(next);
    } else {
      // Call cleared: keep whatever we last knew as lastIdentity, drop live.
      if (identityRef.current) setLastIdentity(identityRef.current);
      setIdentity(null);
    }
  }, []);

  const mergeCallIdentity = useCallback((patch: Partial<CrmCallIdentity>) => {
    setIdentity((prev) => {
      const base: CrmCallIdentity = prev ?? { number: null };
      const merged = { ...base, ...patch };
      setLastIdentity(merged);
      return merged;
    });
  }, []);

  const value = useMemo(
    () => ({ identity, setCallIdentity, mergeCallIdentity, lastIdentity }),
    [identity, setCallIdentity, mergeCallIdentity, lastIdentity],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCrmCallContext(): CrmCallContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCrmCallContext must be used within a CrmCallProvider");
  return v;
}

/**
 * useCrmCall — the CRM-side call entrypoint. Sets the call identity, then
 * places the call through the app-wide SIP session (useSIP().makeCall, the
 * exact same path Dialpad uses — no second dialler). S2b's contact/deal
 * "Call" button calls this.
 */
export function useCrmCall() {
  const { setCallIdentity } = useCrmCallContext();
  const { makeCall, callState } = useSIP();

  const call = useCallback(
    async (number: string, identity?: Omit<CrmCallIdentity, "number">) => {
      if (callState !== "idle") return;
      setCallIdentity({ number, ...identity });
      await makeCall(number);
    },
    [makeCall, callState, setCallIdentity],
  );

  return { call, callState };
}
