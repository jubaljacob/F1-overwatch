import { Providers } from "@/components/providers";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "F1Overwatch",
  description: "Web-based Formula 1 race replay and analytics platform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: some browser extensions (ColorZilla,
          Grammarly, etc.) inject attributes on <body> after SSR. */}
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
