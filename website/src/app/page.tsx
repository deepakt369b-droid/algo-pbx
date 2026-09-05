import Link from "next/link";
import { Section, SectionHeading } from "@/components/site/section";
import { Faq } from "@/components/site/faq";
import { HowItWorksDiagram } from "@/components/site/how-it-works-diagram";
import { contactEmail, features, howItWorksSteps, pricing } from "@/content/site";
import { Check } from "lucide-react";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <Section className="pb-12 pt-20 text-center sm:pt-28">
        <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-primary sm:text-6xl">
          Your phone system. Your SIMs. Your data. Our software.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-secondary">
          Algo PBX is hosted PBX, CRM, and WhatsApp/SMS software that runs on the
          GSM gateway and SIM cards you already own and control. We never sell
          minutes, numbers, or carrier service.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <a
            href={`mailto:${contactEmail}`}
            className="rounded-[var(--radius)] bg-accent px-6 py-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Contact us
          </a>
          <Link
            href="/docs/"
            className="rounded-[var(--radius)] border px-6 py-3 text-sm font-medium text-primary hover:bg-surface-hover"
            style={{ borderColor: "rgb(var(--hairline))" }}
          >
            Read the docs
          </Link>
        </div>
      </Section>

      {/* How it works */}
      <Section id="how-it-works">
        <SectionHeading eyebrow="How it works" title="Your infrastructure, our software" />
        <div className="mt-12">
          <HowItWorksDiagram />
        </div>
        <dl className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {howItWorksSteps.map((step) => (
            <div key={step.title}>
              <dt className="text-sm font-medium text-primary">{step.title}</dt>
              <dd className="mt-2 text-sm text-secondary">{step.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* Features */}
      <Section id="features" className="bg-surface-subtle">
        <SectionHeading eyebrow="Features" title="Everything your call center needs" />
        <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="card p-6">
              <h3 className="text-base font-semibold text-primary">{f.title}</h3>
              <p className="mt-2 text-sm text-secondary">{f.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Pricing */}
      <Section id="pricing">
        <SectionHeading eyebrow="Pricing" title="One plan, no surprises" />
        <div className="mx-auto mt-12 max-w-md">
          <div className="card p-8">
            <h3 className="text-lg font-semibold text-primary">{pricing.planName}</h3>
            <p className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-semibold text-primary">
                AED {pricing.priceAed}
              </span>
              <span className="text-secondary">/ month</span>
            </p>
            <p className="mt-1 text-sm text-tertiary">{pricing.billingNote}</p>
            <ul className="mt-6 space-y-3">
              {pricing.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2 text-sm text-secondary">
                  <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                  {b}
                </li>
              ))}
            </ul>
            <a
              href={`mailto:${contactEmail}`}
              className="mt-8 block rounded-[var(--radius)] bg-accent px-6 py-3 text-center text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              Contact to onboard
            </a>
          </div>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" className="bg-surface-subtle">
        <SectionHeading eyebrow="FAQ" title="Common questions" />
        <div className="mt-12">
          <Faq />
        </div>
      </Section>

      {/* Contact */}
      <Section id="contact" className="text-center">
        <SectionHeading
          eyebrow="Contact"
          title="Ready to talk?"
          body="We'll walk through your gateway setup and get you onboarded."
        />
        <a
          href={`mailto:${contactEmail}`}
          className="mt-8 inline-block rounded-[var(--radius)] bg-accent px-6 py-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          {contactEmail}
        </a>
      </Section>
    </>
  );
}
