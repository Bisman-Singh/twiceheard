import Link from "next/link";
import type { CallRecord } from "@/lib/postcall/record";

/**
 * The day's calls, newest first.
 *
 * A desk reads this the way it reads a register: one line per call, the
 * counts that decide whether anyone has to ring back, and the name only so
 * the line can be found again. Anything amber or red is the reason to open it.
 */

const TIME = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export function CallList({ calls }: { calls: readonly CallRecord[] }) {
  if (calls.length === 0) {
    return (
      <p className="border-t border-[var(--line)] py-4 text-sm text-[var(--muted)]">
        No calls yet. A finished call appears here once its recording has been checked.
      </p>
    );
  }
  return (
    <ol className="border-t border-[var(--line)]">
      {calls.map((call) => (
        <li key={call.sessionId} className="border-b border-[var(--line)]">
          <Link
            href={`/desk/calls/${encodeURIComponent(call.sessionId)}`}
            className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-3 hover:bg-[var(--line)] max-sm:grid-cols-1"
          >
            <span className="font-semibold">{caller(call)}</span>
            <span className="text-sm text-[var(--muted)]">{TIME.format(call.processedAt)}</span>
            <span className="col-span-full text-sm">
              <Count n={call.grade.counts.green} word="verified" ink="green" />
              <Count n={call.grade.counts.amber} word="to check" ink="amber" />
              <Count n={call.grade.counts.red} word="missing" ink="red" />
              {call.escalation ? " · handed to a person" : ""}
              {call.booking ? " · booked" : ""}
              {call.hearing === "unavailable" ? " · heard once only" : ""}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

const INK = {
  green: "text-[var(--green-text)]",
  amber: "text-[var(--amber-text)]",
  red: "text-[var(--red-text)]",
} as const;

function Count({ n, word, ink }: { n: number; word: string; ink: keyof typeof INK }) {
  if (n === 0) return null;
  return (
    <span className={`mr-3 ${INK[ink]}`}>
      {n} {word}
    </span>
  );
}

/** The name if the call got one, so a line can be found again, and nothing more. */
function caller(call: CallRecord): string {
  const name = call.chart.full_name.value;
  return typeof name === "string" && name.length > 0 ? name : "Name not captured";
}
