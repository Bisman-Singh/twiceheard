import Link from "next/link";

/**
 * The 404 page.
 *
 * A wrong address is not an error worth dressing up. It says what happened in
 * one line and then lists the two pages that exist, each with a sentence
 * saying what is on it, so a person who arrived here from a stale link can
 * pick the one they wanted.
 */

const PLACES = [
  {
    href: "/",
    title: "What Twiceheard does",
    body: "How a call works, and what the clinic sees for each field.",
  },
  {
    href: "/call",
    title: "Call the demo clinic",
    body: "Talk to the intake agent in your browser, the way a patient would.",
  },
] as const;

export default function NotFound() {
  return (
    <article className="space-y-8">
      <header className="space-y-3 border-b-2 border-[var(--text)] pb-4">
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--accent)]">404</p>
        <h1 className="text-3xl font-bold">That page is not here.</h1>
        <p className="max-w-2xl text-[var(--muted)]">
          The address may be mistyped, or the page may have been moved since the link was written.
        </p>
      </header>

      <nav aria-label="Pages that exist">
        <ul className="max-w-2xl">
          {PLACES.map((place) => (
            <li key={place.href} className="border-b border-[var(--line)] py-4">
              {/* A block with padding, so the target is a bar rather than a line of text. */}
              <Link href={place.href} className="inline-block py-3 font-semibold">
                {place.title}
              </Link>
              <p className="mt-1 text-sm text-[var(--muted)]">{place.body}</p>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}
