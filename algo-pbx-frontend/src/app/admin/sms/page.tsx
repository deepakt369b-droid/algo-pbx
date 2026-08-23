"use client";

import { useEffect, useState } from "react";

interface AccessRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "DECLINED" | "REVOKED";
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  message: { id: string; conversationId: string; createdAt: string };
  requestedBy: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string; email: string } | null;
}

// Admin-only SIM SMS inbox + the approval queue for sensitive (OTP-shaped)
// messages an agent has asked to see. Nothing here filters sensitive
// content — this IS the surface that can see it, by design (an admin has
// to be able to see a message to decide whether to unlock it). Agents
// never reach this route or this page; requireAdminSession backs every
// call.
export default function SmsAdminPage() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [pollMessage, setPollMessage] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/messaging/sms-access-requests?status=PENDING")
      .then((r) => r.json())
      .then((data) => setRequests(data.requests ?? []));
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  const decide = async (id: string, action: "approve" | "decline" | "revoke") => {
    await fetch(`/api/admin/messaging/sms-access-requests/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  };

  const pollNow = async () => {
    setPollMessage("Checking...");
    const res = await fetch("/api/admin/messaging/sms/poll", { method: "POST" });
    const data = await res.json();
    setPollMessage(res.ok ? `Ingested ${data.ingested} new SMS.` : `Failed: ${JSON.stringify(data.error ?? data)}`);
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">SIM SMS</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Inbound SMS on the Dinstar SIMs. OTP/verification-code-shaped messages are withheld from every
        agent-facing view by default — an agent must request access here before seeing one, and the
        request expires 15 minutes after approval.
      </p>

      <div className="glass-card flex w-full max-w-md flex-col items-center gap-3 p-6">
        <button onClick={pollNow} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
          Check for new SMS now
        </button>
        {pollMessage && <p className="text-xs text-slate-500">{pollMessage}</p>}
        <p className="text-xs text-slate-600">
          The Dinstar gateway has no push webhook — new SMS only arrives here on a poll. Wire this
          route to a schedule for unattended ingestion once a human is available to authenticate it —
          see the route&apos;s own header comment.
        </p>
      </div>

      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Pending access requests ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-slate-500">Nothing pending.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm text-slate-200">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center justify-between border-t border-border pt-3 first:border-0 first:pt-0">
                <div>
                  <p>
                    {r.requestedBy.name} <span className="text-xs text-slate-500">({r.requestedBy.email})</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    requested {new Date(r.createdAt).toLocaleString()} — message from{" "}
                    {new Date(r.message.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => decide(r.id, "approve")} className="text-xs text-green-400 hover:text-green-300">
                    Approve
                  </button>
                  <button onClick={() => decide(r.id, "decline")} className="text-xs text-red-400 hover:text-red-300">
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
