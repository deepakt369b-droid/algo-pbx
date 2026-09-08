import { z } from "zod";

// Pure input handling for the task-creation dialog (owner-page
// enchanted-sphinx plan, W4 — the task board had no "New task" button or
// POST route at all). Kept DB-free so the route
// (src/app/api/admin/crm/tasks/route.ts) can stay thin: parse with
// TaskCreateSchema, normalise with normalizeTaskInput(), then write.

// A due date more than this far out is almost certainly a typo (a
// four-digit year swap, e.g. 2062 for 2026) rather than a real task —
// rejected here rather than silently accepted and buried in "Open" forever.
const MAX_DUE_YEARS_OUT = 5;

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  // Contact stays REQUIRED per the confirmed decision — a task always hangs
  // off a contact, optionally also off a deal.
  contactId: z.string().min(1),
  assigneeId: z.string().min(1).optional(),
  dealId: z.string().min(1).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;

export type NormalizedTaskInput = {
  title: string;
  contactId: string;
  assigneeId: string | null;
  dealId: string | null;
  dueAt: Date | null;
  description: string | null;
};

export type NormalizeTaskInputResult =
  | { ok: true; value: NormalizedTaskInput }
  | { ok: false; error: string };

/** Trims strings, coerces blank optionals to null, and rejects an
 * implausible due date — everything the route needs beyond zod's own
 * shape-level parsing. */
export function normalizeTaskInput(input: TaskCreateInput, now: Date = new Date()): NormalizeTaskInputResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title cannot be empty." };

  if (input.dueAt) {
    const maxDue = new Date(now);
    maxDue.setFullYear(maxDue.getFullYear() + MAX_DUE_YEARS_OUT);
    if (input.dueAt.getTime() > maxDue.getTime()) {
      return { ok: false, error: `Due date is more than ${MAX_DUE_YEARS_OUT} years out — check the year.` };
    }
  }

  const description = input.description?.trim();

  return {
    ok: true,
    value: {
      title,
      contactId: input.contactId,
      assigneeId: input.assigneeId ?? null,
      dealId: input.dealId ?? null,
      dueAt: input.dueAt ?? null,
      description: description ? description : null,
    },
  };
}
