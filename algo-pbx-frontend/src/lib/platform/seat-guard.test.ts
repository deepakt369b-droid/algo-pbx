import { describe, it, expect, vi } from "vitest";
import { assertSeatAvailable, getSeatUsage, SeatLimitError, type SeatGuardReader } from "./seat-guard";

function fakeReader(seats: number | null, used: number): SeatGuardReader {
  return {
    tenant: { findUnique: vi.fn().mockResolvedValue(seats === null ? null : { seats }) },
    extension: { count: vi.fn().mockResolvedValue(used) },
  };
}

describe("getSeatUsage", () => {
  it("reports total, used and available seats", async () => {
    const reader = fakeReader(4, 2);
    await expect(getSeatUsage("t1", reader)).resolves.toEqual({
      seatsTotal: 4,
      seatsUsed: 2,
      seatsAvailable: 2,
    });
    expect(reader.tenant.findUnique).toHaveBeenCalledWith({ where: { id: "t1" }, select: { seats: true } });
    expect(reader.extension.count).toHaveBeenCalledWith({ where: { tenantId: "t1" } });
  });

  it("never reports negative availability when over-provisioned", async () => {
    const reader = fakeReader(4, 6);
    await expect(getSeatUsage("t1", reader)).resolves.toEqual({
      seatsTotal: 4,
      seatsUsed: 6,
      seatsAvailable: 0,
    });
  });

  it("treats a missing tenant as zero total seats", async () => {
    const reader = fakeReader(null, 0);
    await expect(getSeatUsage("ghost", reader)).resolves.toEqual({
      seatsTotal: 0,
      seatsUsed: 0,
      seatsAvailable: 0,
    });
  });
});

describe("assertSeatAvailable", () => {
  it("resolves when a seat is free", async () => {
    const reader = fakeReader(4, 3);
    await expect(assertSeatAvailable("t1", reader)).resolves.toBeUndefined();
  });

  it("throws SeatLimitError once seats are exhausted", async () => {
    const reader = fakeReader(4, 4);
    await expect(assertSeatAvailable("t1", reader)).rejects.toThrow(SeatLimitError);
  });

  it("throws SeatLimitError when over-provisioned past the ceiling", async () => {
    const reader = fakeReader(4, 5);
    await expect(assertSeatAvailable("t1", reader)).rejects.toThrow(SeatLimitError);
  });

  it("throws for a tenant with zero configured seats", async () => {
    const reader = fakeReader(0, 0);
    await expect(assertSeatAvailable("t1", reader)).rejects.toThrow(SeatLimitError);
  });

  it("names the tenant and seat total on the error for API surfacing", async () => {
    const reader = fakeReader(4, 4);
    await expect(assertSeatAvailable("t1", reader)).rejects.toThrow(/4 seats/);
  });
});
