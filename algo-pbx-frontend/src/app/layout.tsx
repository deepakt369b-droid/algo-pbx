import type { Metadata } from "next";
import "./globals.css";
import { AuthSessionProvider } from "@/components/session-provider";
import { SIPProvider } from "@/contexts/sip-context";

export const metadata: Metadata = {
  title: "Algo PBX",
  description: "Self-hosted cloud PBX for the Algo call center",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <AuthSessionProvider>
          <SIPProvider>{children}</SIPProvider>
        </AuthSessionProvider>
      </body>
    </html>
  );
}
