"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import { ChatThread } from "@/components/chat/chat-thread";
import { ChatAvatar } from "@/components/chat/chat-avatar";

/** Human-readable one-line preview for a room conversation row. */
function previewText(m: {
  body: string | null;
  mediaKind?: string | null;
  sensitive: boolean;
} | undefined): string {
  if (!m) return "No messages yet";
  if (m.sensitive) return "🔒 Sensitive message";
  if (m.mediaKind) {
    const t: Record<string, string> = {
      voice: "🎤 Voice message",
      audio: "🎵 Audio",
      image: "📷 Photo",
      video: "🎬 Video",
      document: "📄 Document",
      sticker: "Sticker",
    };
    return m.body?.trim() || t[m.mediaKind] || "Attachment";
  }
  return m.body ?? "";
}

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
  contact: { id: string; numberE164: string; displayName: string | null };
  lastMessageAt: string | null;
  unreadCount: number;
  recentMessages: {
    id: string;
    direction: string;
    body: string | null;
    mediaKind?: string | null;
    sensitive: boolean;
    createdAt: string;
  }[];
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
  // The conversation currently opened in the slide-over chat thread. Staff
  // canAccessConversation() already grants ADMIN/SUPERVISOR read+send on
  // every conversation, so this reuses the agent-facing ChatThread as-is —
  // no new API surface, and the server-side redaction rules stay the only
  // access-control path.
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

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
    <div className="flex w-full flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-primary">Rooms</h1>
        <p className="mt-1 max-w-2xl text-xs text-tertiary">
          A saved group of agents to supervise together — live calls and WhatsApp/SMS conversations,
          side by side. No data isolation: this only changes what you see, not what agents can access.
        </p>
      </div>

      {loadError && (
        <div className="rounded-[var(--radius)] border border-danger/40 bg-danger-subtle px-4 py-2 text-xs text-danger">
          {loadError}
        </div>
      )}

      <div className="flex w-full gap-5">
        <div className="flex w-72 flex-shrink-0 flex-col gap-3 rounded-[var(--radius-lg)] border bg-surface p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Rooms</h2>
          <ul className="flex flex-col gap-1">
            {rooms.map((r) => (
              <li key={r.id} className="flex items-center justify-between">
                <button
                  onClick={() => {
                    setSelectedRoomId(r.id);
                    setRenaming(false);
                  }}
                  className={`flex-1 rounded px-2 py-1 text-left text-sm ${selectedRoomId === r.id ? "bg-surface text-accent" : "text-secondary hover:text-primary"}`}
                >
                  {r.name} <span className="text-xs text-tertiary">({r.memberUserIds.length})</span>
                </button>
                {confirmDeleteId === r.id ? (
                  <span className="flex items-center gap-1 text-xs">
                    <button onClick={() => deleteRoom(r.id)} className="text-danger hover:text-danger">
                      Confirm
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)} className="text-tertiary">
                      x
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDeleteId(r.id)} className="px-1 text-xs text-danger hover:text-danger">
                    delete
                  </button>
                )}
              </li>
            ))}
          </ul>

          {users.length <= 1 ? (
            <p className="border-t border-border pt-3 text-xs text-tertiary">
              Only one staff account exists. Rooms group multiple agents — create agents first in{" "}
              <a href="/admin/users" className="text-accent hover:underline">
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
                className="rounded-lg border border-border bg-canvas px-2 py-1.5 text-xs outline-none focus:border-accent"
              />
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-xs text-secondary">
                    <input type="checkbox" checked={newRoomMembers.has(u.id)} onChange={() => toggleMember(u.id)} />
                    {u.name} ({u.role})
                  </label>
                ))}
              </div>
              <button onClick={createRoom} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg">
                Create room
              </button>
              {createMessage && (
                <p className={`text-xs ${createMessage.kind === "error" ? "text-danger" : "text-success"}`}>{createMessage.text}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-4">
          {!selectedRoom ? (
            <p className="text-tertiary">Select a room to view its activity.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {renaming ? (
                  <>
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="rounded-lg border border-border bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
                    />
                    <button onClick={rename} className="text-xs text-accent hover:underline">
                      Save
                    </button>
                    <button onClick={() => setRenaming(false)} className="text-xs text-tertiary">
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="text-sm font-semibold text-primary">{selectedRoom.name}</h2>
                    <button
                      onClick={() => {
                        setRenaming(true);
                        setRenameValue(selectedRoom.name);
                      }}
                      className="text-xs text-tertiary hover:text-primary"
                    >
                      rename
                    </button>
                  </>
                )}
              </div>

              {activityError && (
                <div className="rounded-lg border border-danger/40 bg-danger-subtle px-4 py-2 text-xs text-danger">{activityError}</div>
              )}

              {activity && (
                <>
                  <div className="overflow-hidden rounded-[var(--radius-lg)] border bg-surface">
                    <h3 className="border-b px-4 py-3 text-sm font-semibold uppercase tracking-wide text-secondary">
                      Members
                    </h3>
                    {activity.members.length === 0 ? (
                      <p className="px-4 py-4 text-xs text-tertiary">No members in this room yet.</p>
                    ) : (
                      <ul className="divide-y [&>li]:border-hairline">
                        {activity.members.map((m) => (
                          <li key={m.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                            <div>
                              <p className="text-primary">{m.name}</p>
                              <p className="text-xs text-tertiary">
                                {m.extension ? `ext. ${m.extension.number} · ${m.extension.status}` : "no extension"}
                                {m.extension?.liveChannel && (
                                  <span className="ml-2 text-accent">
                                    on call {m.extension.liveChannel.state ? `(${m.extension.liveChannel.state})` : ""}
                                  </span>
                                )}
                              </p>
                              {m.waInstance && (
                                <p className="text-xs text-tertiary">
                                  WhatsApp SIM {m.waInstance.simPort} · {m.waInstance.status}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="overflow-hidden rounded-[var(--radius-lg)] border bg-surface">
                    <h3 className="border-b px-4 py-3 text-sm font-semibold uppercase tracking-wide text-secondary">
                      WhatsApp / SMS activity
                    </h3>
                    {activity.conversations.length === 0 ? (
                      <p className="px-4 py-4 text-xs text-tertiary">
                        No conversations assigned to this room&apos;s members yet.
                      </p>
                    ) : (
                      <ul className="divide-y [&>li]:border-hairline">
                        {activity.conversations.map((c) => {
                          const label = c.contact.displayName ?? c.contact.numberE164;
                          const last = c.recentMessages[0];
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => setOpenThreadId(c.id)}
                                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover"
                                title="Open chat thread"
                              >
                                <ChatAvatar
                                  name={label}
                                  src={
                                    c.channel === "WHATSAPP"
                                      ? `/api/messaging/avatar/${c.contact.id}`
                                      : null
                                  }
                                  size={40}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                                      {label}
                                    </span>
                                    {c.lastMessageAt && (
                                      <span className="flex-shrink-0 text-[10px] text-tertiary">
                                        {new Date(c.lastMessageAt).toLocaleDateString(undefined, {
                                          month: "short",
                                          day: "numeric",
                                        })}
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
                                      {last?.direction === "OUTBOUND" ? "You: " : ""}
                                      {previewText(last)}
                                    </span>
                                    {c.assignedAgentId && membersById.get(c.assignedAgentId) && (
                                      <span className="flex-shrink-0 text-[10px] text-tertiary">
                                        · {membersById.get(c.assignedAgentId)!.name}
                                      </span>
                                    )}
                                    {c.unreadCount > 0 && (
                                      <span className="flex h-5 min-w-[1.25rem] flex-shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
                                        {c.unreadCount}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {openThreadId && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-[2px]"
          onClick={() => setOpenThreadId(null)}
        >
          <div
            className="flex h-full w-full max-w-xl flex-col gap-2 border-l bg-canvas p-3 shadow-2xl [border-color:rgb(var(--hairline))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-shrink-0 items-center justify-between px-1">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary">Conversation</h3>
              <button
                onClick={() => setOpenThreadId(null)}
                className="rounded-[var(--radius)] px-2 py-1 text-xs text-tertiary hover:bg-surface-hover hover:text-primary"
              >
                Close
              </button>
            </div>
            <ChatThread conversationId={openThreadId} />
          </div>
        </div>
      )}
    </div>
  );
}
