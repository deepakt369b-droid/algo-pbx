import { describe, expect, it } from "vitest";
import { mapCdrEventToIngestPayload } from "./cdr-mapper";

describe("mapCdrEventToIngestPayload", () => {
  it("maps a complete Cdr event to the ingestion payload shape", () => {
    const payload = mapCdrEventToIngestPayload(
      {
        UniqueID: "1700000000.42",
        CallerID: "+971501234567",
        Destination: "1001",
        Disposition: "ANSWERED",
        StartTime: "2026-08-24 10:00:00",
        AnswerTime: "2026-08-24 10:00:05",
        EndTime: "2026-08-24 10:02:30",
        Duration: "150",
        BillableSeconds: "145",
      },
      { sourceContext: "from-dinstar", recordingUrlBase: "/api/recordings" }
    );

    expect(payload).toEqual({
      uniqueId: "1700000000.42",
      callerNumber: "+971501234567",
      destination: "1001",
      direction: "inbound",
      disposition: "ANSWERED",
      startedAt: new Date("2026-08-24T10:00:00").toISOString(),
      answeredAt: new Date("2026-08-24T10:00:05").toISOString(),
      endedAt: new Date("2026-08-24T10:02:30").toISOString(),
      durationSec: 150,
      billsecSec: 145,
      recordingUrl: "/api/recordings/1700000000.42",
    });
  });

  it("infers outbound direction from the from-agent context", () => {
    const payload = mapCdrEventToIngestPayload(
      { UniqueID: "1.1", StartTime: "2026-08-24 10:00:00" },
      { sourceContext: "from-agent" }
    );
    expect(payload?.direction).toBe("outbound");
  });

  it("infers outbound direction from any Loop C2 from-agent-* tier or shared-handler context", () => {
    for (const context of ["from-agent-local", "from-agent-national", "from-agent-international", "from-agent-common"]) {
      const payload = mapCdrEventToIngestPayload(
        { UniqueID: `1.${context}`, StartTime: "2026-08-24 10:00:00" },
        { sourceContext: context }
      );
      expect(payload?.direction).toBe("outbound");
    }
  });

  it("defaults to internal direction for an unrecognized context", () => {
    const payload = mapCdrEventToIngestPayload(
      { UniqueID: "1.1", StartTime: "2026-08-24 10:00:00" },
      { sourceContext: "from-internal" }
    );
    expect(payload?.direction).toBe("internal");
  });

  it("returns null when UniqueID is missing", () => {
    expect(mapCdrEventToIngestPayload({ StartTime: "2026-08-24 10:00:00" })).toBeNull();
  });

  it("returns null when StartTime is missing or unparseable", () => {
    expect(mapCdrEventToIngestPayload({ UniqueID: "1.1" })).toBeNull();
    expect(mapCdrEventToIngestPayload({ UniqueID: "1.1", StartTime: "not-a-date" })).toBeNull();
  });

  it("omits recordingUrl when no recordingUrlBase is given", () => {
    const payload = mapCdrEventToIngestPayload({
      UniqueID: "1.1",
      StartTime: "2026-08-24 10:00:00",
    });
    expect(payload?.recordingUrl).toBeUndefined();
  });
});
