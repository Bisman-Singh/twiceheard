"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ForgetRecord } from "@/components/call/forget-record";
import { useCallResult, type ResultState } from "@/components/call/use-call-result";
import { FIELDS, FIELD_IDS, isFieldId, type FieldId } from "@/lib/intake/fields";
import { spokenDate } from "@/lib/intake/readback";
import { VerifiedChart } from "@/components/call/verified-chart";
import { claimSession } from "@/lib/call/result-client";
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

/**
 * Where the slip says it shorter than the intake does.
 *
 * The fields themselves come from the intake, so one added there appears here
 * without this file changing. Only the wording of these three is the slip's
 * own: a slip is read at a glance, and the graded chart lower down the same
 * page carries the intake's longer labels, so two rows both reading "Current
 * medications" on one screen would read as one row printed twice.
 */
const SHORT_LABELS: Partial<Record<FieldId, string>> = {
  full_name: "Name",
  phone: "Phone",
  medications: "Medications",
};

/** A field the clinic added and the intake has no label for keeps its own name. */
function slipLabel(field: string): string {
  if (!isFieldId(field)) return field;
  return SHORT_LABELS[field] ?? FIELDS[field].label;
}

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
  const [session, setSession] = useState("");
  const handle = useRef<CallHandle | null>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const result = useCallResult(session, phase);

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
    setSession("");
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
        onSession: (sessionId) => {
          setSession(sessionId);
          // Claimed while the call runs, so only this browser can read its chart back.
          void claimSession(sessionId);
        },
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

      <CallControls
        label={label}
        busy={phase === "connecting" || phase === "ending"}
        onClick={live ? endCall : begin}
      />

      <div className="grid gap-8 py-6 md:grid-cols-[3fr_2fr]">
        <Transcript lines={lines} live={live} scrollRef={transcript} />
        <IntakeSlip fields={fields} booking={booking} />
      </div>

      <CallResult result={result} />
    </section>
  );
}

function CallControls({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-3 border-b border-[var(--line)] py-4">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="border-2 border-[var(--text)] px-5 py-2 font-semibold disabled:opacity-60"
      >
        {label}
      </button>
      <p className="max-w-md text-sm text-[var(--muted)]">
        This needs a microphone, and the browser asks for one when you press the button. The line is
        recorded: what you say is transcribed as you speak and again from the recording, and becomes
        the chart at the foot of this page, which the clinic desk sees too. You can delete that
        chart yourself once the call ends. Speak as a patient would, and give no real medical
        details.
      </p>
    </div>
  );
}

const RESULT_WORDS: Partial<Record<ResultState["status"], string>> = {
  waiting: "Listening to the recording a second time. This takes a few seconds.",
  unavailable:
    "The chart is not ready yet. The clinic still has the call, and the desk will see it once the recording has been checked.",
};

function CallResult({ result }: { result: ResultState }) {
  // Held against the session it belongs to, so a later call opens with a chart again.
  const [forgotten, setForgotten] = useState("");
  const sessionId = result.record?.sessionId ?? "";
  const forget = useCallback(() => setForgotten(sessionId), [sessionId]);

  if (result.record) {
    return (
      <>
        {forgotten !== sessionId && <VerifiedChart record={result.record} />}
        <ForgetRecord key={sessionId} sessionId={sessionId} onForgotten={forget} />
      </>
    );
  }
  const words = RESULT_WORDS[result.status];
  if (!words) return null;
  return (
    <p role="status" className="border-t-2 border-[var(--text)] pt-5 text-sm">
      {words}
    </p>
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
            {live
              ? "Waiting for the first words."
              : "Nothing said yet. Every line of the call is written here as it is said, each one marked Caller for you or Clinic for the agent."}
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

/** A date is shown as the agent said it, so the slip reads like the call sounded. */
function spoken(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? spokenDate(value) : value;
}

interface SlipRow {
  field: string;
  /** Empty until the call has saved something for this field. */
  value: string;
  /** Null while the field is still to be asked about. */
  status: CallField["status"] | null;
}

/**
 * Every field of the intake, in the order the agent collects them, each with
 * whatever the call has for it so far.
 *
 * The slip is ruled out in full before the call starts, so the page says what
 * is going to be collected instead of holding an empty box that says nothing.
 */
function slipRows(fields: readonly CallField[]): SlipRow[] {
  const saved = new Map(fields.map((field) => [field.field, field]));
  return [
    ...FIELD_IDS.map((id): SlipRow => saved.get(id) ?? { field: id, value: "", status: null }),
    // A field the clinic added is not in the intake's list, so it joins the end.
    ...fields.filter((field) => !isFieldId(field.field)),
  ];
}

function IntakeSlip({ fields, booking }: { fields: CallField[]; booking: string }) {
  return (
    <section aria-label="Intake slip">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide">Intake slip</h3>
      <dl className="border border-[var(--line)] px-3 py-1 text-sm">
        {slipRows(fields).map((row) => (
          <div
            key={row.field}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-dotted border-[var(--line)] py-1.5 last:border-b-0"
          >
            <dt className="min-w-[5.5rem] font-semibold">{slipLabel(row.field)}</dt>
            <dd className="min-w-0 flex-1">{row.value ? spoken(row.value) : "-"}</dd>
            <dd
              className={`text-xs ${row.status === null ? "text-[var(--muted)]" : STATUS_INK[row.status]}`}
            >
              {row.status === null ? "waiting" : STATUS_WORDS[row.status]}
            </dd>
          </div>
        ))}
      </dl>
      {booking && (
        <p className="mt-3 border-l-2 border-[var(--green-text)] pl-3 text-sm">{booking}</p>
      )}
    </section>
  );
}
