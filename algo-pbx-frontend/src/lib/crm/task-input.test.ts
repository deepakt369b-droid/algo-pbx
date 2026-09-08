import { describe, it, expect } from "vitest";
import { TaskCreateSchema, normalizeTaskInput } from "./task-input";

const NOW = new Date("2026-09-08T12:00:00Z");

describe("TaskCreateSchema", () => {
  it("accepts the minimal required shape", () => {
    const parsed = TaskCreateSchema.safeParse({ title: "Call back", contactId: "c1" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing contactId", () => {
    const parsed = TaskCreateSchema.safeParse({ title: "Call back" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const parsed = TaskCreateSchema.safeParse({ title: "", contactId: "c1" });
    expect(parsed.success).toBe(false);
  });
});

describe("normalizeTaskInput", () => {
  it("trims the title and description, coercing blanks to null", () => {
    const result = normalizeTaskInput(
      { title: "  Call back  ", contactId: "c1", description: "   " },
      NOW
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Call back");
      expect(result.value.description).toBeNull();
    }
  });

  it("defaults assigneeId/dealId/dueAt to null when omitted", () => {
    const result = normalizeTaskInput({ title: "Call back", contactId: "c1" }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.assigneeId).toBeNull();
      expect(result.value.dealId).toBeNull();
      expect(result.value.dueAt).toBeNull();
    }
  });

  it("rejects a whitespace-only title even though zod's min(1) already passed shape validation", () => {
    const result = normalizeTaskInput({ title: "   ", contactId: "c1" }, NOW);
    expect(result.ok).toBe(false);
  });

  it("accepts a due date a few months out", () => {
    const dueAt = new Date("2026-12-01T00:00:00Z");
    const result = normalizeTaskInput({ title: "Follow up", contactId: "c1", dueAt }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dueAt).toEqual(dueAt);
  });

  it("rejects a due date more than 5 years out as a likely typo", () => {
    const dueAt = new Date("2062-01-01T00:00:00Z");
    const result = normalizeTaskInput({ title: "Follow up", contactId: "c1", dueAt }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/check the year/);
  });

  it("keeps a real description", () => {
    const result = normalizeTaskInput(
      { title: "Follow up", contactId: "c1", description: "Bring the updated quote." },
      NOW
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.description).toBe("Bring the updated quote.");
  });
});
