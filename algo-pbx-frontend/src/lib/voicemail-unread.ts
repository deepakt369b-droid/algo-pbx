// Pure "which voicemail messages are unseen" filter, extracted out of
// AgentShell's badge computation so it's unit-testable in isolation — same
// motivation as recording-access.ts's canAccessRecording(). Backs the
// Voicemail badge count in src/components/agent-shell/agent-shell.tsx,
// which otherwise had no unread concept at all (every prior version of the
// badge was just `messages.length`, i.e. "total", not "unread").
//
// A message with no parsed origtime (voicemail-spool.ts's parser is
// deliberately lenient about missing/unrecognized fields) can't be time-
// compared against lastSeenAt, so it's treated as unseen rather than
// silently dropped from the count — under-counting unread voicemail is a
// worse failure mode than over-counting it.

export interface UnreadCheckableVoicemail {
  origtime: number | null; // unix seconds, per voicemail-spool.ts
}

export function countUnseenVoicemail(messages: UnreadCheckableVoicemail[], lastSeenAt: string | null): number {
  if (!lastSeenAt) return messages.length;
  const seenAtMs = new Date(lastSeenAt).getTime();
  return messages.filter((m) => m.origtime === null || m.origtime * 1000 > seenAtMs).length;
}
