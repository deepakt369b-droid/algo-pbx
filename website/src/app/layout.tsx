import type { Metadata } from "next";
import { ThemeProvider, NO_FLASH_SCRIPT } from "@/theme/theme-provider";
import { Nav } from "@/components/site/nav";
import { Footer } from "@/components/site/footer";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Algo PBX — hosted phone system for your own gateway",
    template: "%s — Algo PBX",
  },
  description:
    "Algo PBX is hosted PBX, CRM, and WhatsApp/SMS software that runs on the GSM gateway and SIM cards you already own.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <div className="flex min-h-screen flex-col">
            <Nav />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
