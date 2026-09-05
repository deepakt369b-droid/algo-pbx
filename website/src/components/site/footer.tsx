import Link from "next/link";
import { contactEmail } from "@/content/site";

export function Footer() {
  return (
    <footer className="border-t" style={{ borderColor: "rgb(var(--hairline))" }}>
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-10 text-sm text-secondary sm:flex-row sm:items-center sm:justify-between">
        <p>© {new Date().getFullYear()} Sahara Techs. All rights reserved.</p>
        <div className="flex flex-wrap gap-6">
          <Link href="/terms/" className="hover:text-primary">Terms</Link>
          <Link href="/privacy/" className="hover:text-primary">Privacy</Link>
          <Link href="/docs/" className="hover:text-primary">Docs</Link>
          <a href={`mailto:${contactEmail}`} className="hover:text-primary">{contactEmail}</a>
        </div>
      </div>
    </footer>
  );
}
