"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DESTINATIONS, isCurrent } from "./destinations";

/**
 * The way into every page, on every page.
 *
 * Text on a ruled line, set the way the clinic screens are: the wordmark, then
 * each page after a middle dot. The page being read is in full ink, underlined,
 * and carries `aria-current`; the others are quieter. Each link is a 44 pixel
 * tall target so a thumb can hit it, and the focus ring is the one the
 * stylesheet draws for everything else.
 */

const LINK = "inline-flex min-h-11 items-center px-1";

export default function SiteNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Pages" className="border-b border-[var(--line)]">
      <ul className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-4 px-4 text-sm sm:gap-x-1">
        <li>
          <Link
            href="/"
            className={`${LINK} font-semibold uppercase tracking-[0.18em] text-[var(--text)]`}
          >
            Twiceheard
          </Link>
        </li>
        {DESTINATIONS.map((destination) => {
          const current = isCurrent(pathname, destination.href);
          return (
            <li key={destination.href} className="flex items-center gap-x-1">
              {/* Read as punctuation, not as a word, so it stays out of the accessible name.
                  Dropped on a phone, where the row wraps and a dot would start a line. */}
              <span aria-hidden="true" className="text-[var(--muted)] max-sm:hidden">
                &middot;
              </span>
              <Link
                href={destination.href}
                aria-current={current ? "page" : undefined}
                className={`${LINK} ${
                  current
                    ? "font-semibold text-[var(--text)] underline"
                    : "text-[var(--muted)] hover:underline"
                }`}
              >
                {destination.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
