import { describe, it, expect } from "vitest";
import { evaluateCompliance, type ComplianceTenantView } from "./compliance";

const NONE: ComplianceTenantView = {
  complianceTypeApprovalFiledAt: null,
  complianceEtisalatLetterAt: null,
  complianceAupSignedAt: null,
  compliancePdplTermsSignedAt: null,
  complianceRecordingDisclosureAt: null,
};

const D = new Date("2026-09-01T00:00:00.000Z");

const ALL: ComplianceTenantView = {
  complianceTypeApprovalFiledAt: D,
  complianceEtisalatLetterAt: D,
  complianceAupSignedAt: D,
  compliancePdplTermsSignedAt: D,
  complianceRecordingDisclosureAt: D,
};

describe("evaluateCompliance", () => {
  it("reports all five items as outstanding for a fresh tenant", () => {
    const r = evaluateCompliance(NONE);
    expect(r.complete).toBe(false);
    expect(r.totalCount).toBe(5);
    expect(r.filedCount).toBe(0);
    expect(r.missing).toHaveLength(5);
  });

  it("is complete when every item has a date", () => {
    const r = evaluateCompliance(ALL);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.summary).toBe("Compliance checklist complete.");
  });

  it("covers exactly the five items from the legal checklist", () => {
    expect(evaluateCompliance(NONE).items.map((i) => i.id)).toEqual([
      "typeApproval",
      "carrierLetter",
      "aupSigned",
      "pdplTermsSigned",
      "recordingDisclosure",
    ]);
  });

  it("tracks partial completion", () => {
    const r = evaluateCompliance({ ...NONE, complianceAupSignedAt: D, compliancePdplTermsSignedAt: D });
    expect(r.complete).toBe(false);
    expect(r.filedCount).toBe(2);
    expect(r.missing.map((i) => i.id)).toEqual(["typeApproval", "carrierLetter", "recordingDisclosure"]);
  });

  it("names the outstanding items in the summary so the warning is actionable", () => {
    const r = evaluateCompliance({ ...ALL, complianceTypeApprovalFiledAt: null });
    expect(r.summary).toContain("1 of 5 compliance item outstanding");
    expect(r.summary).toContain("Type-approval certificate filed");
  });

  it("pluralises the summary correctly", () => {
    const r = evaluateCompliance({ ...ALL, complianceTypeApprovalFiledAt: null, complianceAupSignedAt: null });
    expect(r.summary).toContain("2 of 5 compliance items outstanding");
  });

  it("preserves the filed date so the record answers 'when', not just 'whether'", () => {
    const item = evaluateCompliance(ALL).items.find((i) => i.id === "pdplTermsSigned");
    expect(item?.filedAt).toEqual(D);
  });

  it("explains why every item exists", () => {
    for (const item of evaluateCompliance(NONE).items) {
      expect(item.why.length).toBeGreaterThan(30);
    }
  });

  it("does not mutate its input", () => {
    const input = { ...NONE };
    evaluateCompliance(input);
    expect(input).toEqual(NONE);
  });
});
