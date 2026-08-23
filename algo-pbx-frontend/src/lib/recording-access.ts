// Single source of truth for "may this session access this recording"
// (Phase D — recording retention with asymmetric agent/admin deletion).
// Called identically by GET /api/recordings (listing) and
// GET /api/recordings/[uniqueid] (byte-serving) so the two can never drift
// apart — a hidden recording must be unreachable by direct URL, not merely
// absent from a list.
//
// Ownership has no foreign key: CallDetailRecord.agentExtension is a bare
// string (see prisma/schema.prisma's comment), matched against the caller's
// session.user.extension by equality — same mechanism already used by
// PATCH /api/extensions/[number].

export type Role = "AGENT" | "SUPERVISOR" | "ADMIN";

export interface RecordingAccessInput {
  role: Role;
  callerExtension: string | null;
  cdrAgentExtension: string | null;
  hiddenFromAgentAt: Date | null;
}

export function canAccessRecording(input: RecordingAccessInput): boolean {
  if (input.role === "ADMIN" || input.role === "SUPERVISOR") return true;

  // AGENT: must own the call (non-null, matching extension) and it must
  // not be hidden. `callerExtension === input.cdrAgentExtension` alone
  // would be true for two `null`s — explicitly require both non-null so an
  // agent with no linked extension can never "match" a call with no agent
  // assigned either.
  const owns =
    input.callerExtension !== null &&
    input.cdrAgentExtension !== null &&
    input.callerExtension === input.cdrAgentExtension;

  return owns && input.hiddenFromAgentAt === null;
}
