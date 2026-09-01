import type { Metadata } from "next";
import "./globals.css";
import { AuthSessionProvider } from "@/components/session-provider";
import { SIPProvider } from "@/contexts/sip-context";
import { ThemeProvider, NO_FLASH_SCRIPT } from "@/theme/theme-provider";

export const metadata: Metadata = {
  title: "Algo PBX",
  description: "Self-hosted cloud PBX for the Algo call center",
};

// The inline script runs before hydration so there is no flash of the wrong
// theme; it is a fixed literal (no interpolated data), covered by the
// existing style-src 'unsafe-inline' CSP.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthSessionProvider>
            <SIPProvider>{children}</SIPProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
