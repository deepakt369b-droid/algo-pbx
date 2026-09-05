// Per-tenant onboarding compliance checklist.
//
// These five items come from the legal checklist behind this product, and
// each one is a real regulatory or contractual artefact that has to exist on
// file before a tenant carries traffic in earnest. GO_LIVE_CHECKLIST.md's
// Gate 3 carries the platform-wide versions of several of them, still
// unresolved; this module is the PER-TENANT record of the same discipline.
//
// Deliberate design decision: an incomplete checklist does NOT block tenant
// creation. Onboarding paperwork legitimately lags a technical setup by days
// or weeks, and a console that refuses to record a customer until the filing
// cabinet is perfect just moves the record-keeping into somebody's inbox,
// where it is invisible. Instead the tenant is created and a persistent
// warning follows it everywhere — tenant row, tenant detail header, and the
// overview attention queue — until the gaps are closed.
//
// Stored as nullable timestamps rather than booleans so the record answers
// "when was this filed", which is the question an auditor actually asks.

export type ComplianceItemId =
  | "typeApproval"
  | "carrierLetter"
  | "aupSigned"
  | "pdplTermsSigned"
  | "recordingDisclosure";

export interface ComplianceItem {
  id: ComplianceItemId;
  label: string;
  /** Why this exists, shown in the UI — an operator who understands the item
   * is far likelier to chase it than one ticking an unexplained box. */
  why: string;
  filedAt: Date | null;
}

export interface ComplianceTenantView {
  complianceTypeApprovalFiledAt: Date | null;
  complianceEtisalatLetterAt: Date | null;
  complianceAupSignedAt: Date | null;
  compliancePdplTermsSignedAt: Date | null;
  complianceRecordingDisclosureAt: Date | null;
}

export interface ComplianceResult {
  complete: boolean;
  items: ComplianceItem[];
  missing: ComplianceItem[];
  filedCount: number;
  totalCount: number;
  /** One-line summary for the tenant row / attention queue. */
  summary: string;
}

export function evaluateCompliance(tenant: ComplianceTenantView): ComplianceResult {
  const items: ComplianceItem[] = [
    {
      id: "typeApproval",
      label: "Type-approval certificate filed",
      why: "The Dinstar gateway must be type-approved for use on the UAE network. Without it the hardware is not lawfully connectable.",
      filedAt: tenant.complianceTypeApprovalFiledAt,
    },
    {
      id: "carrierLetter",
      label: "e& / du confirmation letter",
      why: "Written carrier confirmation that this customer's GSM termination arrangement is permitted. GO_LIVE_CHECKLIST.md Gate 3 flags the legality of GSM termination as an open question — this is the per-tenant answer to it.",
      filedAt: tenant.complianceEtisalatLetterAt,
    },
    {
      id: "aupSigned",
      label: "Acceptable Use Policy signed",
      why: "Binds the customer against traffic that would put the shared trunk or our carrier relationship at risk.",
      filedAt: tenant.complianceAupSignedAt,
    },
    {
      id: "pdplTermsSigned",
      label: "PDPL terms signed",
      why: "UAE PDPL data-processing terms. Call recordings and CDRs are personal data, and offboarding without an agreed export/deletion position is a PDPL problem.",
      filedAt: tenant.compliancePdplTermsSignedAt,
    },
    {
      id: "recordingDisclosure",
      label: "Recording disclosure verified",
      why: "Callers must be told they are recorded. The forced announcement exists in the product but has never been confirmed on a real call (docs/S6-real-call-test-plan.md) — verify per tenant.",
      filedAt: tenant.complianceRecordingDisclosureAt,
    },
  ];

  const missing = items.filter((i) => i.filedAt === null);
  const filedCount = items.length - missing.length;

  return {
    complete: missing.length === 0,
    items,
    missing,
    filedCount,
    totalCount: items.length,
    summary:
      missing.length === 0
        ? "Compliance checklist complete."
        : `${missing.length} of ${items.length} compliance item${missing.length === 1 ? "" : "s"} outstanding: ` +
          missing.map((i) => i.label).join(", ") + ".",
  };
}
