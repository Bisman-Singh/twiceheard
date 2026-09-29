"use client";

import { useEffect, useState } from "react";
import { fetchResult } from "@/lib/call/result-client";
import type { CallPhase } from "@/lib/call/session-client";
import type { CallRecord } from "@/lib/postcall/record";

/**
 * Waiting for the chart of the call that just ended.
 *
 * The recording is attached a moment after the line drops, so the page asks,
 * waits and asks again rather than reporting a failure. If it never arrives,
 * the page says so plainly: the clinic still has the call either way. The
 * answer is kept against the session it belongs to, so the chart of an
 * earlier call can never be shown beside a later one.
 */

export type ResultStatus = "none" | "waiting" | "ready" | "unavailable";

export interface ResultState {
  status: ResultStatus;
  record?: CallRecord;
}

interface Answer extends ResultState {
  sessionId: string;
}

export const POLL_EVERY_MS = 4000;
export const GIVE_UP_AFTER_MS = 2 * 60 * 1000;

export function useCallResult(sessionId: string, phase: CallPhase): ResultState {
  const [answer, setAnswer] = useState<Answer>({ sessionId: "", status: "none" });

  useEffect(() => {
    if (phase !== "ended" || !sessionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUpAt = Date.now() + GIVE_UP_AFTER_MS;

    const ask = async () => {
      const result = await fetchResult(sessionId);
      if (stopped) return;
      if (result.status === "ready") {
        setAnswer({ sessionId, status: "ready", record: result.record });
      } else if (result.status === "unavailable" || Date.now() >= giveUpAt) {
        setAnswer({ sessionId, status: "unavailable" });
      } else {
        timer = setTimeout(() => void ask(), POLL_EVERY_MS);
      }
    };
    void ask();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, sessionId]);

  const settled = answer.sessionId === sessionId ? answer : null;
  if (settled && settled.status !== "none") return settled;
  return { status: phase === "ended" && sessionId ? "waiting" : "none" };
}
