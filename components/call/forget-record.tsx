"use client";

import { useCallback, useState } from "react";

/**
 * Deleting the call that just happened, from the page it happened on.
 *
 * A right nobody can exercise is not a right, so this sits under the chart
 * rather than behind an email address. Erasure cannot be taken back, so the
 * first press only asks the question and the answer to it is what deletes. The
 * wording says what goes and what does not: the recording belongs to the
 * platform that carried the call and is not this app's to remove.
 */

type Step = "offered" | "asking" | "working" | "gone" | "failed";

/**
 * What each step says out loud. One region carries all of them and is in the
 * page from the start, because a live region a screen reader meets only after
 * the change it announces is a region that announces nothing.
 */
const SAID: Partial<Record<Step, string>> = {
  working: "Deleting.",
  failed: "That did not go through. Nothing was deleted. Please try again.",
  gone: "The chart is gone from Twiceheard, and the clinic desk will not see this call. The recording and the call's timeline stay with the voice platform that carried the line, under their retention and not this app's.",
};

export function ForgetRecord({
  sessionId,
  onForgotten,
}: {
  sessionId: string;
  /** Tells the page to stop showing the chart, the moment there is no chart to show. */
  onForgotten: () => void;
}) {
  const [step, setStep] = useState<Step>("offered");

  const erase = useCallback(async () => {
    setStep("working");
    try {
      const response = await fetch("/api/call/forget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!response.ok) throw new Error("refused");
      setStep("gone");
      onForgotten();
    } catch {
      setStep("failed");
    }
  }, [sessionId, onForgotten]);

  const gone = step === "gone";
  return (
    <section
      aria-label="Deleting this call"
      className={`mt-6 pt-5 ${gone ? "border-t-2 border-[var(--text)]" : "border-t border-[var(--line)]"}`}
    >
      {gone ? (
        <h3 className="text-lg font-semibold">This call has been deleted</h3>
      ) : (
        <Offer
          step={step}
          onAsk={() => setStep("asking")}
          onYes={erase}
          onNo={() => setStep("offered")}
        />
      )}
      <p role="status" className="mt-3 max-w-2xl text-sm empty:hidden">
        {SAID[step]}
      </p>
    </section>
  );
}

function Offer({
  step,
  onAsk,
  onYes,
  onNo,
}: {
  step: Step;
  onAsk: () => void;
  onYes: () => Promise<void>;
  onNo: () => void;
}) {
  return (
    <>
      <h3 className="text-sm font-semibold uppercase tracking-wide">Your call, your record</h3>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        You can have this call deleted. The chart above goes, and the clinic desk never sees it.
        This cannot be undone.
      </p>
      {step === "offered" ? (
        <Press onClick={onAsk}>Delete this call</Press>
      ) : (
        <div className="mt-4 border-l-2 border-[var(--red-text)] pl-4">
          <p className="text-sm font-semibold">Delete the chart from this call?</p>
          <div className="flex flex-wrap gap-3">
            <Press onClick={() => void onYes()} disabled={step === "working"}>
              Yes, delete it
            </Press>
            <Press onClick={onNo} disabled={step === "working"}>
              Keep it
            </Press>
          </div>
        </div>
      )}
    </>
  );
}

function Press({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-4 border-2 border-[var(--text)] px-5 py-2 font-semibold disabled:opacity-60"
    >
      {children}
    </button>
  );
}
