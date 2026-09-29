"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * The error boundary for every page.
 *
 * The thrown error never reaches the screen. Next.js replaces a server error's
 * message with a digest in production, but an error thrown in the browser keeps
 * its own message, and that message can carry a value the caller just typed or
 * a detail of a request. Only the digest is written to the console, which is
 * enough to match the fault to the server log and carries nothing on its own.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("page failed to render", { digest: error.digest });
  }, [error]);

  return (
    <article className="space-y-8">
      <header className="space-y-3 border-b-2 border-[var(--text)] pb-4">
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--accent)]">
          Something went wrong
        </p>
        <h1 className="text-3xl font-bold">This page could not be shown.</h1>
        <p className="max-w-2xl text-[var(--muted)]">
          The fault is on this side, not yours. Trying again usually works. If it does not, go back
          to the front page and start from there.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-6">
        <button
          type="button"
          onClick={reset}
          className="border-2 border-[var(--text)] px-5 py-2 font-semibold"
        >
          Try again
        </button>
        <Link href="/" className="font-semibold">
          Go to the front page
        </Link>
      </div>
    </article>
  );
}
