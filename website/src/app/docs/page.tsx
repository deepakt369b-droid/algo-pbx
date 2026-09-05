import type { Metadata } from "next";
import { Section } from "@/components/site/section";
import { docsSections } from "@/content/docs";
import { contactEmail } from "@/content/site";

export const metadata: Metadata = { title: "Docs" };

export default function DocsPage() {
  return (
    <Section>
      <h1 className="text-3xl font-semibold text-primary">Documentation</h1>
      <p className="mt-2 text-secondary">
        An overview of what Algo PBX is and how onboarding works. For
        anything not covered here, reach us at{" "}
        <a href={`mailto:${contactEmail}`} className="text-accent hover:text-accent-hover">
          {contactEmail}
        </a>.
      </p>

      <div className="mt-10 space-y-10">
        {docsSections.map((section) => (
          <div key={section.title} id={section.title.toLowerCase().replace(/\s+/g, "-")}>
            <h2 className="text-xl font-semibold text-primary">{section.title}</h2>
            <p className="mt-2 whitespace-pre-line text-secondary">{section.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
