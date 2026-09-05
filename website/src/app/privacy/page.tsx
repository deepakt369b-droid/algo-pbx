import type { Metadata } from "next";
import { Section } from "@/components/site/section";
import { contactEmail } from "@/content/site";

export const metadata: Metadata = { title: "Privacy Policy" };

// DRAFT — Gate A. PDPL-aligned: customer is controller, Sahara Techs is
// processor. The support-access description matches the real mechanism
// (SupportGrant + PlatformAuditLog, prisma/schema.prisma) rather than an
// aspiration — see the plan doc's instruction not to guess this. Retention
// figures match COMPLIANCE.md / RECORDING_RETENTION_DAYS. [ENTITY] /
// [JURISDICTION] left for the operator to fill, same as Terms.
export default function PrivacyPage() {
  return (
    <Section className="prose-section">
      <h1 className="text-3xl font-semibold text-primary">Privacy Policy</h1>
      <p className="mt-2 text-sm text-tertiary">
        Draft — pending legal review. Last updated: [DATE].
      </p>

      <div className="mt-10 space-y-8 text-secondary">
        <div>
          <h2 className="text-xl font-semibold text-primary">1. Controller and processor</h2>
          <p className="mt-2">
            Under the UAE Personal Data Protection Law (PDPL) and equivalent
            regimes, <strong>you</strong> — our customer — are the data
            controller for the personal data that flows through your use of
            Algo PBX (your contacts, your callers, your agents).{" "}
            <strong>[ENTITY]</strong> (&ldquo;Sahara Techs,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;), registered
            in <strong>[JURISDICTION]</strong>, acts as your data processor:
            we host and operate the software; we do not decide why your data
            is collected or how it is used.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">2. What we process</h2>
          <ul className="mt-2 list-disc space-y-2 pl-6">
            <li>
              <strong>Call metadata</strong> (call detail records — who called
              whom, when, how long) — retained to support call history,
              reporting, and billing.
            </li>
            <li>
              <strong>Call recordings and voicemail</strong> — retained for a
              fixed, configurable number of days, then permanently deleted by
              an automated nightly job. Retention is not indefinite by
              default.
            </li>
            <li>
              <strong>WhatsApp/SMS messages and CRM records</strong> —
              contacts, companies, deals, and conversation history you or
              your agents create.
            </li>
            <li>
              <strong>Gateway diagnostic events</strong> — technical events
              from your telecom gateway (call attempts, port/registration
              state), which can incidentally include phone numbers. These are
              retained for a fixed 30 days and then permanently deleted.
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">3. Support access</h2>
          <p className="mt-2">
            Our staff do not have standing access to your data. Support access
            is granted through a time-boxed mechanism: each grant has a
            mandatory reason, a hard expiry after which access is
            automatically revoked, and is recorded in an immutable platform
            audit log — visible to you on request. Absence of an active grant
            means our support staff can see nothing in your account.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">4. Retention and deletion</h2>
          <p className="mt-2">
            Recordings and voicemail: deleted after your configured retention
            window (default set at account creation, adjustable by your
            admins). Gateway diagnostic events: deleted after 30 days,
            fixed. On account closure, we retain data only as long as
            necessary to comply with our own legal obligations or as you
            direct, then delete it.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">5. Your rights</h2>
          <p className="mt-2">
            As the data subject&rsquo;s controller, you are responsible for
            responding to their PDPL rights requests (access, correction,
            deletion). We will support you in fulfilling those requests
            against data we hold on your behalf. To make a request or ask a
            question, contact{" "}
            <a href={`mailto:${contactEmail}`} className="text-accent hover:text-accent-hover">
              {contactEmail}
            </a>.
          </p>
        </div>
      </div>
    </Section>
  );
}
