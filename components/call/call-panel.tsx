"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  startCall,
  type CallField,
  type CallHandle,
  type CallLine,
  type CallPhase,
} from "@/lib/call/session-client";

/**
 * The call button and what happens while the call runs.
 *
 * Laid out like the intake slip a front desk fills in: ruled rows, a value
 * against its label, and the state written in words as well as in ink colour.
 * The conversation is shown as it happens, so a person watching can see the
 * agent read a value back before the caller agrees to it.
 */

const FIELD_LABELS: Record<string, string> = {
  full_name: "Name",
  date_of_birth: "Date of birth",
  phone: "Phone",
  reason_for_visit: "Reason for visit",
  medications: "Medications",
  allergies: "Allergies",
  preferred_time: "Preferred time",
};

const STATUS_WORDS: Record<CallField["status"], string> = {
  heard: "read back, waiting",
  confirmed: "confirmed",
  unresolved: "left for the desk",
};

const STATUS_INK: Record<CallField["status"], string> = {
  heard: "text-[var(--amber-text)]",
  confirmed: "text-[var(--green-text)]",
  unresolved: "text-[var(--red-text)]",
};

const PHASE_WORDS: Record<CallPhase, string> = {
  idle: "Not connected.",
  connecting: "Connecting. Allow the microphone when your browser asks.",
  live: "Connected. Speak normally.",
  ending: "Ending the call.",
  ended: "Call ended.",
  failed: "The call could not continue.",
};

export function CallPanel({ clinicId, clinicName }: { clinicId: string; clinicName: string }) {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [problem, setProblem] = useState("");
  const [lines, setLines] = useState<CallLine[]>([]);
  const [fields, setFields] = useState<CallField[]>([]);
  const [booking, setBooking] = useState("");
  const handle = useRef<CallHandle | null>(null);
  const transcript = useRef<HTMLOListElement>(null);

  // One way to hang up: the button, and the page being left mid-call.
  const endCall = useCallback(() => handle.current?.end(), []);
  useEffect(() => endCall, [endCall]);

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [lines]);

  const begin = useCallback(async () => {
    setProblem("");
    setLines([]);
    setFields([]);
    setBooking("");
    setPhase("connecting");
    try {
      handle.current = await startCall(clinicId, {
        onPhase: (next, detail) => {
          setPhase(next);
          if (detail) setProblem(detail);
        },
        onLine: (line) =>
          setLines((current) => {
            const kept = current.filter((entry) => entry.id !== "partial" && entry.id !== line.id);
            return line.text.trim() ? [...kept, line] : kept;
          }),
        onField: (field) =>
          setFields((current) => [
            ...current.filter((entry) => entry.field !== field.field),
            field,
          ]),
        onBooking: setBooking,
      });
    } catch (error) {
      setPhase("failed");
      setProblem(error instanceof Error ? error.message : "The call could not start.");
    }
  }, [clinicId]);

  const live = phase === "connecting" || phase === "live" || phase === "ending";
  const label = live ? "End the call" : phase === "ended" ? "Call again" : "Call the clinic";

  return (
    <section className="border-t-2 border-[var(--text)] pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--line)] pb-3">
        <h2 className="text-xl font-semibold">{clinicName}, intake line</h2>
        <p role="status" className="text-sm text-[var(--muted)]">
          {problem || PHASE_WORDS[phase]}
        </p>
      </div>

      <div className="flex flex-wrap gap-3 border-b border-[var(--line)] py-4">
        <button
          type="button"
          onClick={live ? endCall : begin}
          disabled={phase === "connecting" || phase === "ending"}
          className="border-2 border-[var(--text)] px-5 py-2 font-semibold disabled:opacity-60"
        >
          {label}
        </button>
        <p className="max-w-md text-sm text-[var(--muted)]">
          A recorded demonstration line. Speak as a patient would, and do not give real medical
          details.
        </p>
      </div>

      <div className="grid gap-8 py-6 md:grid-cols-[3fr_2fr]">
        <Transcript lines={lines} live={live} scrollRef={transcript} />
        <IntakeSlip fields={fields} booking={booking} />
      </div>
    </section>
  );
}

function Transcript({
  lines,
  live,
  scrollRef,
}: {
  lines: CallLine[];
  live: boolean;
  scrollRef: RefObject<HTMLOListElement | null>;
}) {
  return (
    <section aria-label="The call">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">The call</h3>
      <ol
        ref={scrollRef}
        className="h-72 overflow-y-auto border border-[var(--line)] p-3 text-sm"
        aria-live="polite"
        aria-label="Conversation so far"
      >
        {lines.length === 0 && (
          <li className="text-[var(--muted)]">
            {live ? "Waiting for the first words." : "Nothing said yet."}
          </li>
        )}
        {lines.map((line) => (
          <li key={line.id} className="border-b border-dotted border-[var(--line)] py-1.5">
            <span className="mr-2 font-semibold">{line.who === "agent" ? "Clinic" : "Caller"}</span>
            <span className={line.partial ? "italic text-[var(--muted)]" : ""}>{line.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function IntakeSlip({ fields, booking }: { fields: CallField[]; booking: string }) {
  return (
    <section aria-label="Intake slip">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Intake slip</h3>
      {fields.length === 0 && (
        <p className="border border-[var(--line)] p-3 text-sm text-[var(--muted)]">
          Nothing captured yet.
        </p>
      )}
      <dl className="border border-[var(--line)] p-3 text-sm empty:hidden">
        {fields.map((field) => (
          <div
            key={field.field}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-dotted border-[var(--line)] py-1.5 last:border-b-0"
          >
            <dt className="font-semibold">{FIELD_LABELS[field.field] ?? field.field}</dt>
            <dd className="flex-1">{field.value}</dd>
            <dd className={`text-xs ${STATUS_INK[field.status]}`}>{STATUS_WORDS[field.status]}</dd>
          </div>
        ))}
      </dl>
      {booking && (
        <p className="mt-3 border-l-2 border-[var(--green-text)] pl-3 text-sm">{booking}</p>
      )}
    </section>
  );
}
