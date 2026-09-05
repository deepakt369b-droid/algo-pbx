import type { Metadata } from "next";
import { Section } from "@/components/site/section";
import { contactEmail } from "@/content/site";

export const metadata: Metadata = { title: "Terms of Service" };

// DRAFT — Gate A. Not for publication until the operator reviews and fills
// in [ENTITY] / [JURISDICTION]. Content sourced from handoff.md's plan and
// what the app actually does (COMPLIANCE.md, prisma/schema.prisma) — no
// invented obligations either direction.
export default function TermsPage() {
  return (
    <Section className="prose-section">
      <h1 className="text-3xl font-semibold text-primary">Terms of Service</h1>
      <p className="mt-2 text-sm text-tertiary">
        Draft — pending legal review. Last updated: [DATE].
      </p>

      <div className="mt-10 space-y-8 text-secondary">
        <div>
          <h2 className="text-xl font-semibold text-primary">1. The service</h2>
          <p className="mt-2">
            Algo PBX (&ldquo;the Service&rdquo;) is a software subscription: hosted PBX,
            CRM, and messaging software provided by <strong>[ENTITY]</strong>,
            a company registered in <strong>[JURISDICTION]</strong>
            (&ldquo;Sahara Techs,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). We do not sell telecommunications
            minutes, SIM cards, phone numbers, or carrier service of any
            kind — the Service operates against telecom infrastructure that
            you already own or contract for separately.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">2. Your responsibilities</h2>
          <p className="mt-2">
            You own and are solely responsible for: your GSM gateway hardware,
            your SIM cards, your phone numbers, and your carrier contracts.
            You are responsible for ensuring your use of these lines — the
            calls you make, the numbers you dial, and the data you collect —
            complies with the telecom and data-protection regulations of
            every jurisdiction you operate in.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">3. Acceptable use</h2>
          <p className="mt-2">You agree not to use the Service to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            <li>Bypass call-termination rules or operate a SIM-box / call-bypass
              scheme on infrastructure you do not have the right to use this way.</li>
            <li>Contact numbers registered on a Do-Not-Call list without a
              lawful basis, or otherwise violate telemarketing regulations
              applicable to your calls.</li>
            <li>Use the Service for unlawful, fraudulent, or harassing
              communications.</li>
          </ul>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">4. Suspension and data</h2>
          <p className="mt-2">
            If we suspend your account (for example, for non-payment or a
            breach of acceptable use), we will not automatically delete your
            data. Data is retained through suspension and deleted only per
            our published retention rules or on your explicit request, in
            each case documented in our{" "}
            <a href="/privacy/" className="text-accent hover:text-accent-hover">
              Privacy Policy
            </a>.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">5. Liability</h2>
          <p className="mt-2">
            The Service is provided on an &ldquo;as available&rdquo; basis. To the
            maximum extent permitted by the laws of <strong>[JURISDICTION]</strong>,
            our aggregate liability under these Terms is limited to the fees
            you paid for the Service in the three months preceding the claim.
            We are not liable for the acts, omissions, or regulatory
            compliance of your telecom carrier or gateway hardware.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-semibold text-primary">6. Contact</h2>
          <p className="mt-2">
            Questions about these Terms:{" "}
            <a href={`mailto:${contactEmail}`} className="text-accent hover:text-accent-hover">
              {contactEmail}
            </a>.
          </p>
        </div>
      </div>
    </Section>
  );
}
