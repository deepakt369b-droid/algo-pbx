"use client";

import { useEffect, useState } from "react";
import { ConversationList } from "./conversation-list";
import { ChatThread } from "./chat-thread";
import { WhatsAppConnectionBadge } from "./whatsapp-connection-badge";
import {
  resolveWhatsAppConversation,
  createWhatsAppConversationWithInstance,
  type WhatsAppDeepLinkResult,
} from "@/lib/messaging/whatsapp-deep-link";

type Phase = { kind: "idle" } | { kind: "resolving" } | { kind: "creating" } | WhatsAppDeepLinkResult;

// Top-level chat panel wired into agent/chat/page.tsx. WhatsApp pairing/
// logout are entirely out of scope here and live exclusively in
// src/app/admin/whatsapp — this panel only ever reads and sends messages
// on conversations already assigned or claimable by the signed-in agent.
// The connection badge below is read-only, no control.
//
// The CRM "WhatsApp" deep-link entry point (P3/P1) is rendering only —
// every branch of what happens when a contact's WhatsApp button is
// clicked (existing conversation vs. create vs. no-instance-agent vs.
// no-instance-admin-picker) lives in src/lib/messaging/whatsapp-deep-link.ts,
// unit-tested there (this repo's vitest is `environment: "node"`, no
// jsdom — see that file's header).
export function ChatPanel({ initialNumber }: { initialNumber?: string } = {}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(initialNumber ? { kind: "resolving" } : { kind: "idle" });

  useEffect(() => {
    if (!initialNumber) {
      setPhase({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setPhase({ kind: "resolving" });
    resolveWhatsAppConversation(initialNumber).then((result) => {
      if (!cancelled) setPhase(result);
    });
    return () => {
      cancelled = true;
    };
  }, [initialNumber]);

  useEffect(() => {
    if (phase.kind === "found") setSelectedId(phase.conversationId);
  }, [phase]);

  const createWithInstance = async (waInstanceId: string) => {
    if (!initialNumber) return;
    setPhase({ kind: "creating" });
    const result = await createWhatsAppConversationWithInstance(initialNumber, waInstanceId);
    setPhase(result);
  };

  return (
    <div className="flex h-[36rem] w-full flex-col gap-2">
      <WhatsAppConnectionBadge />
      <div className="flex flex-1 gap-3">
        <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
        {phase.kind === "resolving" || phase.kind === "creating" ? (
          <div className="glass-card flex flex-1 items-center justify-center text-sm text-slate-500">
            {phase.kind === "creating" ? "Starting conversation…" : "Opening conversation…"}
          </div>
        ) : phase.kind === "error" ? (
          <div className="glass-card flex flex-1 items-center justify-center text-sm text-red-400">{phase.message}</div>
        ) : phase.kind === "no-instance-agent" ? (
          <div className="glass-card flex flex-1 items-center justify-center p-6 text-center text-sm text-amber-400">
            No WhatsApp line assigned to your account — ask your admin.
          </div>
        ) : phase.kind === "no-instance-admin" ? (
          <div className="glass-card flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-slate-300">Choose a SIM line to send from:</p>
            {phase.instances.length === 0 ? (
              <p className="text-xs text-slate-500">No WhatsApp-capable SIM ports are configured yet.</p>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                {phase.instances.map((inst) => (
                  <button
                    key={inst.id}
                    onClick={() => createWithInstance(inst.id)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-slate-200 hover:border-cyan hover:text-cyan"
                  >
                    {inst.label || `SIM ${inst.simPort}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : selectedId ? (
          <ChatThread conversationId={selectedId} />
        ) : (
          <div className="glass-card flex flex-1 items-center justify-center text-sm text-slate-500">
            Select a conversation
          </div>
        )}
      </div>
    </div>
  );
}
