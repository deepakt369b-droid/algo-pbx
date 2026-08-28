import { describe, expect, it } from "vitest";
import { countUnseenVoicemail } from "./voicemail-unread";

const SEEN_AT = "2026-08-24T00:00:00.000Z";
const SEEN_AT_MS = new Date(SEEN_AT).getTime();
const BEFORE = SEEN_AT_MS / 1000 - 3600;
const AFTER = SEEN_AT_MS / 1000 + 3600;

describe("countUnseenVoicemail", () => {
  it("counts every message as unseen when lastSeenAt is null", () => {
    expect(countUnseenVoicemail([{ origtime: BEFORE }, { origtime: AFTER }], null)).toBe(2);
  });

  it("excludes messages with origtime at or before lastSeenAt", () => {
    expect(countUnseenVoicemail([{ origtime: BEFORE }], SEEN_AT)).toBe(0);
  });

  it("includes messages with origtime after lastSeenAt", () => {
    expect(countUnseenVoicemail([{ origtime: AFTER }], SEEN_AT)).toBe(1);
  });

  it("treats a message with no parsed origtime as unseen", () => {
    expect(countUnseenVoicemail([{ origtime: null }], SEEN_AT)).toBe(1);
  });

  it("returns 0 for an empty message list regardless of lastSeenAt", () => {
    expect(countUnseenVoicemail([], SEEN_AT)).toBe(0);
    expect(countUnseenVoicemail([], null)).toBe(0);
  });

  it("mixes seen, unseen, and unknown-time messages correctly", () => {
    const messages = [{ origtime: BEFORE }, { origtime: AFTER }, { origtime: null }];
    expect(countUnseenVoicemail(messages, SEEN_AT)).toBe(2);
  });
});
