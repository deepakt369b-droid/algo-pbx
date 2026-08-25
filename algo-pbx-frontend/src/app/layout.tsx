import type { Metadata } from "next";
import "./globals.css";
import { AuthSessionProvider } from "@/components/session-provider";
import { SIPProvider } from "@/contexts/sip-context";
import { ThemeProvider, NO_FLASH_SCRIPT } from "@/theme/theme-provider";
import { NextEmotionCacheProvider } from "@/theme/next-emotion-cache-provider";

export const metadata: Metadata = {
  title: "Algo PBX",
  description: "Self-hosted cloud PBX for the Algo call center",
};

// MUI's static CSP (next.config.mjs: style-src 'self' 'unsafe-inline')
// already covers Emotion's injected <style> tags — no CSP change needed
// for the theme layer. The inline script below runs before hydration so
// there is no flash of the wrong theme; it is a fixed literal (no
// interpolated data), not a CSP or XSS concern.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <NextEmotionCacheProvider>
          <ThemeProvider>
            <AuthSessionProvider>
              <SIPProvider>{children}</SIPProvider>
            </AuthSessionProvider>
          </ThemeProvider>
        </NextEmotionCacheProvider>
      </body>
    </html>
  );
}
