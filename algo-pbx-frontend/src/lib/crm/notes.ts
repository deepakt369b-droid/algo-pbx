import { z } from "zod";
import { truncateBody } from "@/lib/crm/activity";

// Pure logic shared by every threaded-notes route (deal/company/contact —
// owner-page enchanted-sphinx plan, W5: "there is no 'notes/description'
// section in any of the crm pages"). Kept DB-free so the ordering,
// serialisation and Activity-summary format are unit-tested without a
// database, matching this repo's "extract the pure decision" convention
// (src/lib/recording-access.ts, src/lib/crm/task-input.ts).

export const NoteCreateSchema = z.object({ body: z.string().min(1).max(4000) });

export interface NoteRow {
  id: string;
  body: string;
  createdAt: Date | string;
  author: { id: string; name: string | null };
}

export interface NoteThreadItem {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string | null };
}

/** Newest-first, ISO-serialised — the shape every NoteThread component
 * renders directly. */
export function toNoteThread(rows: readonly NoteRow[]): NoteThreadItem[] {
  return [...rows]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : r.createdAt.toISOString(),
      author: r.author,
    }));
}

/** The ONE place a note's Activity-timeline summary string is built —
 * reuses the same truncateBody() the agent contact-notes route already
 * uses, so a deal/company note's timeline entry reads identically to a
 * contact note's. */
export function noteActivitySummary(body: string): string {
  return `Note: ${truncateBody(body)}`;
}

/** Activity.refId for a note. Deliberately just the note's own id — the
 * same convention the existing agent contact-notes route already uses
 * (src/app/api/agent/crm/contacts/[id]/notes/route.ts) — because cuids are
 * globally unique, so a DealNote id and a CompanyNote id can never collide
 * even sharing one refId namespace. This is what makes recordActivity()
 * idempotent under Activity's `@@unique([tenantId, type, refId])`: a
 * retried POST with the same note id updates the existing Activity row
 * instead of duplicating it. `kind` is accepted for callers that want to
 * be explicit at the call site; it does not change the returned value. */
export function noteActivityRefId(_kind: "deal" | "company" | "contact", noteId: string): string {
  return noteId;
}
