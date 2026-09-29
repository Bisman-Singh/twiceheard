import type { Metadata } from "next";
import { CallList } from "@/components/desk/call-list";
import { SignInForm } from "@/components/desk/sign-in-form";
import { signOutAction } from "@/app/desk/actions";
import { signedInClinic } from "@/lib/desk/session";
import { serverDeps } from "@/lib/server/deps";

export const metadata: Metadata = {
  title: "Clinic desk",
  robots: { index: false, follow: false },
};

/** How many calls one page of the desk shows. */
const PAGE = 25;

export default async function DeskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const clinic = await signedInClinic();
  if (!clinic) {
    return (
      <article className="space-y-4">
        <h1 className="text-3xl font-bold">Clinic desk</h1>
        <p className="max-w-2xl text-[var(--muted)]">
          Calls that have finished, with every field graded. Sign in with your clinic code.
        </p>
        <SignInForm />
      </article>
    );
  }

  const page = Math.max(0, Number((await searchParams).page ?? 0) || 0);
  const calls = await serverDeps().calls.list(clinic.id, PAGE + 1, page * PAGE);
  const shown = calls.slice(0, PAGE);

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-bold">{clinic.name}</h1>
        <form action={signOutAction}>
          <button type="submit" className="border border-[var(--text)] px-3 py-1 text-sm">
            Sign out
          </button>
        </form>
      </div>
      <p className="text-[var(--muted)]">
        Finished calls, newest first. Open one to see what was verified and what needs a call back.
      </p>
      <CallList calls={shown} />
      <nav className="flex gap-4 text-sm" aria-label="More calls">
        {page > 0 && <a href={`/desk?page=${page - 1}`}>Newer calls</a>}
        {calls.length > PAGE && <a href={`/desk?page=${page + 1}`}>Older calls</a>}
      </nav>
    </article>
  );
}
