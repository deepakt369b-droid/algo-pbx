import { describe, it, expect } from "vitest";
import { NoteCreateSchema, toNoteThread, noteActivitySummary, noteActivityRefId } from "./notes";

describe("NoteCreateSchema", () => {
  it("accepts a non-empty body", () => {
    expect(NoteCreateSchema.safeParse({ body: "Called back, left voicemail." }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(NoteCreateSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("rejects a body over 4000 characters", () => {
    expect(NoteCreateSchema.safeParse({ body: "x".repeat(4001) }).success).toBe(false);
  });
});

describe("toNoteThread", () => {
  const rows = [
    { id: "n1", body: "First", createdAt: new Date("2026-09-01T10:00:00Z"), author: { id: "u1", name: "Alice" } },
    { id: "n2", body: "Second", createdAt: new Date("2026-09-03T10:00:00Z"), author: { id: "u2", name: "Bob" } },
    { id: "n3", body: "Third", createdAt: new Date("2026-09-02T10:00:00Z"), author: { id: "u1", name: "Alice" } },
  ];

  it("orders newest first", () => {
    const thread = toNoteThread(rows);
    expect(thread.map((t) => t.id)).toEqual(["n2", "n3", "n1"]);
  });

  it("serialises dates to ISO strings", () => {
    const thread = toNoteThread(rows);
    expect(thread[0].createdAt).toBe("2026-09-03T10:00:00.000Z");
  });

  it("passes through an already-ISO createdAt unchanged", () => {
    const thread = toNoteThread([{ id: "n4", body: "x", createdAt: "2026-09-04T00:00:00.000Z", author: { id: "u1", name: null } }]);
    expect(thread[0].createdAt).toBe("2026-09-04T00:00:00.000Z");
  });

  it("does not mutate the input array", () => {
    const copy = [...rows];
    toNoteThread(rows);
    expect(rows).toEqual(copy);
  });
});

describe("noteActivitySummary", () => {
  it("prefixes with Note: and truncates at 140 chars, matching truncateBody", () => {
    const long = "x".repeat(200);
    const summary = noteActivitySummary(long);
    expect(summary.startsWith("Note: ")).toBe(true);
    expect(summary.length).toBe("Note: ".length + 140);
  });

  it("handles a short note verbatim", () => {
    expect(noteActivitySummary("Called back.")).toBe("Note: Called back.");
  });
});

describe("noteActivityRefId", () => {
  it("returns the note's own id regardless of kind", () => {
    expect(noteActivityRefId("deal", "note123")).toBe("note123");
    expect(noteActivityRefId("company", "note123")).toBe("note123");
    expect(noteActivityRefId("contact", "note123")).toBe("note123");
  });
});
