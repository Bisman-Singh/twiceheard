import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import SiteNav from "@/components/site/nav";
import "./globals.css";

const DESCRIPTION =
  "Clinic intake by phone. A voice agent takes the call in English, Hindi or Hinglish, reads every critical detail back, books the appointment, and hands the clinic a chart where each field is verified or flagged.";

/**
 * Where this deployment answers, for the absolute URLs a link preview needs.
 *
 * Read from the platform rather than written down, so a preview deployment
 * advertises itself and not production. `opengraph-image.jpg` beside this file
 * is resolved against it; without a base the card falls back to no image at all.
 */
const SITE_URL = new URL(
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000",
);

export const metadata: Metadata = {
  metadataBase: SITE_URL,
  title: { default: "Twiceheard", template: "%s · Twiceheard" },
  description: DESCRIPTION,
  // Without these a link shared in a message previews as the bare host name.
  // Open Graph does not inherit the page title or description, so both are
  // repeated here. The image is the file beside this one, which Next resolves
  // against `metadataBase` and serves at its own hashed path.
  openGraph: {
    type: "website",
    siteName: "Twiceheard",
    locale: "en_IN",
    title: "Twiceheard",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Twiceheard",
    description: DESCRIPTION,
  },
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
        {/* After the skip link, so the first Tab still offers the way past the nav. */}
        <SiteNav />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl px-4 py-12">
          {children}
        </main>
      </body>
    </html>
  );
}
