"use client";

import { useEffect, useMemo, useState } from "react";

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
  extension: { number: string; status: string } | null;
}

interface QueueSnapshot {
  name: string;
  strategy: string;
  waiting: number;
  longestWaitSec: number;
  members: { extension: string; status: string }[];
}

// Rooms (Workstream E) — a UI view only, per the client's explicit
// decision. No tenancy, no new scoping on any other model: a Room is just
// a named, persisted set of agents an admin wants to watch together. This
// page renders the call-center wallboard filtered to that set alongside
// their WhatsApp/SMS conversation activity, side by side.
export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomMembers, setNewRoomMembers] = useState<Set<string>>(new Set());
  const [queues, setQueues] = useState<QueueSnapshot[]>([]);
  const [conversations, setConversations] = useState<
    { id: string; channel: string; contact: { numberE164: string; displayName: string | null }; assignedAgentId: string | null; lastMessageAt: string | null }[]
  >([]);

  const loadRooms = () => fetch("/api/admin/rooms").then((r) => r.json()).then((d) => setRooms(d.rooms ?? []));
  const loadUsers = () => fetch("/api/admin/users").then((r) => r.json()).then((d) => setUsers(d.users ?? []));

  useEffect(() => {
    loadRooms();
    loadUsers();
  }, []);

  useEffect(() => {
    if (!selectedRoomId) return;
    const load = () => {
      fetch("/api/queues").then((r) => r.json()).then((d) => setQueues(d.queues ?? []));
      fetch("/api/messaging/conversations").then((r) => r.json()).then((d) => setConversations(d.conversations ?? []));
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [selectedRoomId]);

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;
  const roomExtensions = useMemo(() => {
    if (!selectedRoom) return new Set<string>();
    return new Set(
      users.filter((u) => selectedRoom.memberUserIds.includes(u.id) && u.extension).map((u) => u.extension!.number)
    );
  }, [selectedRoom, users]);
  const roomUserIds = useMemo(() => new Set(selectedRoom?.memberUserIds ?? []), [selectedRoom]);

  const createRoom = async () => {
    if (!newRoomName.trim()) return;
    await fetch("/api/admin/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newRoomName, memberUserIds: Array.from(newRoomMembers) }),
    });
    setNewRoomName("");
    setNewRoomMembers(new Set());
    loadRooms();
  };

  const deleteRoom = async (id: string) => {
    await fetch(`/api/admin/rooms/${id}`, { method: "DELETE" });
    if (selectedRoomId === id) setSelectedRoomId(null);
    loadRooms();
  };

  const toggleMember = (id: string) => {
    setNewRoomMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Rooms</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        A saved group of agents to watch together — call activity and WhatsApp/SMS conversations,
        side by side. No data isolation: this only changes what you see, not what agents can access.
      </p>

      <div className="flex w-full max-w-4xl gap-6">
        <div className="glass-card flex w-64 flex-shrink-0 flex-col gap-3 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Rooms</h2>
          <ul className="flex flex-col gap-1">
            {rooms.map((r) => (
              <li key={r.id} className="flex items-center justify-between">
                <button
                  onClick={() => setSelectedRoomId(r.id)}
                  className={`flex-1 rounded px-2 py-1 text-left text-sm ${selectedRoomId === r.id ? "bg-surface text-cyan" : "text-slate-300 hover:text-slate-100"}`}
                >
                  {r.name} <span className="text-xs text-slate-500">({r.memberUserIds.length})</span>
                </button>
                <button onClick={() => deleteRoom(r.id)} className="px-1 text-xs text-red-400 hover:text-red-300">
                  x
                </button>
              </li>
            ))}
          </ul>

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
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-4">
          {!selectedRoom ? (
            <p className="text-slate-500">Select a room to view its activity.</p>
          ) : (
            <>
              <div className="glass-card p-4">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Queue activity — {selectedRoom.name}
                </h2>
                {queues.map((q) => {
                  const members = q.members.filter((m) => roomExtensions.has(m.extension));
                  if (members.length === 0) return null;
                  return (
                    <div key={q.name} className="mb-2 text-sm text-slate-200">
                      <p className="font-medium">{q.name}</p>
                      <ul className="ml-3 text-xs text-slate-400">
                        {members.map((m) => (
                          <li key={m.extension}>
                            {m.extension}: {m.status}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <div className="glass-card p-4">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                  WhatsApp / SMS activity
                </h2>
                <ul className="flex flex-col gap-2 text-sm text-slate-200">
                  {conversations
                    .filter((c) => c.assignedAgentId && roomUserIds.has(c.assignedAgentId))
                    .map((c) => (
                      <li key={c.id} className="border-t border-border pt-2 first:border-0 first:pt-0">
                        <span className="mr-2 rounded bg-surface px-1.5 py-0.5 text-xs text-cyan">{c.channel}</span>
                        {c.contact.displayName ?? c.contact.numberE164}
                        <span className="ml-2 text-xs text-slate-500">
                          {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : ""}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
