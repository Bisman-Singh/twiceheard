import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Twiceheard", template: "%s · Twiceheard" },
  description:
    "Clinic intake by phone. A voice agent takes the call in English, Hindi or Hinglish, reads every critical detail back, books the appointment, and hands the clinic a chart where each field is verified or flagged.",
};

/** Every page renders per request so the CSP nonce from `proxy.ts` applies. */
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#101528" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body className="min-h-screen">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-[var(--surface)] focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl px-4 py-12">
          {children}
        </main>
      </body>
    </html>
  );
}
