import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VerifiedChart } from "@/components/call/verified-chart";
import { signedInClinic } from "@/lib/desk/session";
import { serverDeps } from "@/lib/server/deps";

export const metadata: Metadata = {
  title: "Call",
  robots: { index: false, follow: false },
};

const WHEN = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export default async function DeskCallPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const clinic = await signedInClinic();
  // Not signed in and signed in to another clinic look the same from outside.
  if (!clinic) notFound();
  const { sessionId } = await params;
  const call = await serverDeps().calls.get(sessionId);
  if (!call || call.clinicId !== clinic.id) notFound();

  return (
    <article className="space-y-4">
      <Link href="/desk" className="text-sm">
        Back to the desk
      </Link>
      <h1 className="text-3xl font-bold">{WHEN.format(call.processedAt)}</h1>
      <p className="text-[var(--muted)]">
        {call.durationSeconds === null
          ? "Length not recorded."
          : `${Math.round(call.durationSeconds)} seconds on the line.`}{" "}
        {call.grade.ready
          ? "Every critical field is verified."
          : "Something here needs a person before the visit."}
      </p>
      <VerifiedChart record={call} heading="h2" />
      <dl className="grid gap-x-6 gap-y-1 border-t border-[var(--line)] pt-4 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4 border-b border-dotted border-[var(--line)] py-1">
          <dt className="text-[var(--muted)]">Answer time, median</dt>
          <dd>{call.latency.p50 === null ? "not measured" : `${call.latency.p50} ms`}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-dotted border-[var(--line)] py-1">
          <dt className="text-[var(--muted)]">Answer time, 95th</dt>
          <dd>{call.latency.p95 === null ? "not measured" : `${call.latency.p95} ms`}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-dotted border-[var(--line)] py-1">
          <dt className="text-[var(--muted)]">Tool calls</dt>
          <dd>
            {call.tools.calls}, {call.tools.failures} failed
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-dotted border-[var(--line)] py-1">
          <dt className="text-[var(--muted)]">Call reference</dt>
          <dd className="font-mono text-xs">{call.sessionId}</dd>
        </div>
      </dl>
    </article>
  );
}
