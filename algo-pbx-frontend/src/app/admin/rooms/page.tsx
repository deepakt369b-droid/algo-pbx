"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface Room {
  id: string;
  name: string;
  memberUserIds: string[];
}

interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: "AGENT" | "SUPERVISOR" | "ADMIN";
}

interface MemberActivity {
  id: string;
  name: string;
  email: string;
  role: string;
  extension: { number: string; status: string; liveChannel: { channel: string; state?: string; callerIdNum?: string } | null } | null;
  waInstance: { id: string; label: string; simPort: number; status: string; phoneE164: string | null } | null;
}

interface ConversationPreview {
  id: string;
  channel: string;
  assignedAgentId: string | null;
  contact: { numberE164: string; displayName: string | null };
  lastMessageAt: string | null;
  unreadCount: number;
  recentMessages: { id: string; direction: string; body: string | null; sensitive: boolean; createdAt: string }[];
}

// Rooms (Workstream E) — a named, persisted set of agents an admin wants
// to supervise together. GET /api/admin/rooms/[id]/activity is what turns
// this from a static member count into live inspection: presence + live
// call state per member, their WhatsApp identity, and recent conversation
// previews (redacted per the same rule every other message route uses —
// see conversation-access.ts).
export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomMembers, setNewRoomMembers] = useState<Set<string>>(new Set());
  const [createMessage, setCreateMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [activity, setActivity] = useState<{ members: MemberActivity[]; conversations: ConversationPreview[] } | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const loadRooms = async () => {
    try {
      const d = await apiFetch<{ rooms: Room[] }>("/api/admin/rooms");
      setRooms(d.rooms ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load rooms.");
    }
  };
  const loadUsers = async () => {
    try {
      const d = await apiFetch<{ users: StaffUser[] }>("/api/admin/users");
      setUsers(d.users ?? []);
    } catch {
      // Non-fatal for this page — the member picker just stays empty.
    }
  };

  useEffect(() => {
    loadRooms();
    loadUsers();
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    const load = async () => {
      try {
        const d = await apiFetch<{ members: MemberActivity[]; conversations: ConversationPreview[] }>(
          `/api/admin/rooms/${selectedRoomId}/activity`
        );
        setActivity(d);
        setActivityError(null);
      } catch (err) {
        setActivityError(err instanceof ApiError ? err.message : "Could not load room activity.");
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [selectedRoomId]);

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;

  const createRoom = async () => {
    if (!newRoomName.trim()) return;
    setCreateMessage(null);
    try {
      const d = await apiFetch<{ room: Room }>("/api/admin/rooms", {
        method: "POST",
        body: { name: newRoomName, memberUserIds: Array.from(newRoomMembers) },
      });
      setNewRoomName("");
      setNewRoomMembers(new Set());
      await loadRooms();
      setSelectedRoomId(d.room.id);
    } catch (err) {
      setCreateMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not create room." });
    }
  };

  const deleteRoom = async (id: string) => {
    try {
      await apiFetch(`/api/admin/rooms/${id}`, { method: "DELETE" });
      if (selectedRoomId === id) setSelectedRoomId(null);
      await loadRooms();
    } catch (err) {
      setCreateMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not delete room." });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const rename = async () => {
    if (!selectedRoom || !renameValue.trim()) return;
    try {
      await apiFetch(`/api/admin/rooms/${selectedRoom.id}`, { method: "PATCH", body: { name: renameValue } });
      await loadRooms();
      setRenaming(false);
    } catch (err) {
      setCreateMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not rename room." });
    }
  };

  const toggleMember = (id: string) => {
    setNewRoomMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const membersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Rooms</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        A saved group of agents to supervise together — live calls and WhatsApp/SMS conversations,
        side by side. No data isolation: this only changes what you see, not what agents can access.
      </p>

      {loadError && (
        <div className="w-full max-w-4xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      <div className="flex w-full max-w-4xl gap-6">
        <div className="glass-card flex w-64 flex-shrink-0 flex-col gap-3 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Rooms</h2>
          <ul className="flex flex-col gap-1">
            {rooms.map((r) => (
              <li key={r.id} className="flex items-center justify-between">
                <button
                  onClick={() => {
                    setSelectedRoomId(r.id);
                    setRenaming(false);
                  }}
                  className={`flex-1 rounded px-2 py-1 text-left text-sm ${selectedRoomId === r.id ? "bg-surface text-cyan" : "text-slate-300 hover:text-slate-100"}`}
                >
                  {r.name} <span className="text-xs text-slate-500">({r.memberUserIds.length})</span>
                </button>
                {confirmDeleteId === r.id ? (
                  <span className="flex items-center gap-1 text-xs">
                    <button onClick={() => deleteRoom(r.id)} className="text-red-400 hover:text-red-300">
                      Confirm
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} className="text-slate-500">
                      x
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDeleteId(r.id)} className="px-1 text-xs text-red-400 hover:text-red-300">
                    delete
                  </button>
                )}
              </li>
            ))}
          </ul>

          {users.length <= 1 ? (
            <p className="border-t border-border pt-3 text-xs text-slate-600">
              Only one staff account exists. Rooms group multiple agents — create agents first in{" "}
              <a href="/admin/users" className="text-cyan hover:underline">
                Users
              </a>
              .
            </p>
          ) : (
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <input
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="New room name"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-cyan"
              />
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={newRoomMembers.has(u.id)} onChange={() => toggleMember(u.id)} />
                    {u.name} ({u.role})
                  </label>
                ))}
              </div>
              <button onClick={createRoom} className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-background">
                Create room
              </button>
              {createMessage && (
                <p className={`text-xs ${createMessage.kind === "error" ? "text-red-400" : "text-green-400"}`}>{createMessage.text}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4">
          {!selectedRoom ? (
            <p className="text-slate-500">Select a room to view its activity.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {renaming ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="rounded-lg border border-border bg-background px-2 py-1 text-sm outline-none focus:border-cyan"
                    />
                    <button onClick={rename} className="text-xs text-cyan hover:underline">
                      Save
                    </button>
                    <button onClick={() => setRenaming(false)} className="text-xs text-slate-500">
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold text-slate-200">{selectedRoom.name}</h2>
                    <button
                      onClick={() => {
                        setRenaming(true);
                        setRenameValue(selectedRoom.name);
                      }}
                      className="text-xs text-slate-500 hover:text-slate-300"
                    >
                      rename
                    </button>
                  </>
                )}
              </div>

              {activityError && (
                <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-xs text-red-300">{activityError}</div>
              )}

              {activity && (
                <>
                  <div className="glass-card p-4">
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Members</h3>
                    {activity.members.length === 0 ? (
                      <p className="text-xs text-slate-500">No members in this room yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {activity.members.map((m) => (
                          <li key={m.id} className="flex items-center justify-between border-t border-border pt-2 text-sm first:border-0 first:pt-0">
                            <div>
                              <p className="text-slate-200">{m.name}</p>
                              <p className="text-xs text-slate-500">
                                {m.extension ? `ext. ${m.extension.number} · ${m.extension.status}` : "no extension"}
                                {m.extension?.liveChannel && (
                                  <span className="ml-2 text-cyan">
                                    on call {m.extension.liveChannel.state ? `(${m.extension.liveChannel.state})` : ""}
                                  </span>
                                )}
                              </p>
                              {m.waInstance && (
                                <p className="text-xs text-slate-500">
                                  WhatsApp SIM {m.waInstance.simPort} · {m.waInstance.status}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="glass-card p-4">
                    <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                      WhatsApp / SMS activity
                    </h3>
                    {activity.conversations.length === 0 ? (
                      <p className="text-xs text-slate-500">No conversations assigned to this room&apos;s members yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-3 text-sm text-slate-200">
                        {activity.conversations.map((c) => (
                          <li key={c.id} className="border-t border-border pt-2 first:border-0 first:pt-0">
                            <div className="flex items-center justify-between">
                              <span>
                                <span className="mr-2 rounded bg-surface px-1.5 py-0.5 text-xs text-cyan">{c.channel}</span>
                                {c.contact.displayName ?? c.contact.numberE164}
                                {c.assignedAgentId && membersById.get(c.assignedAgentId) && (
                                  <span className="ml-2 text-xs text-slate-500">— {membersById.get(c.assignedAgentId)!.name}</span>
                                )}
                              </span>
                              <span className="text-xs text-slate-500">
                                {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ""}
                              </span>
                            </div>
                            {c.recentMessages.length > 0 && (
                              <p className="mt-1 truncate text-xs text-slate-500">
                                {c.recentMessages[0].body ?? (c.recentMessages[0].sensitive ? "(sensitive — hidden)" : "(no text)")}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
