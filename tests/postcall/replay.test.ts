import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isAgreement, replayChart, wasSpoken } from "@/lib/postcall/replay";
import {
  callEvents,
  firstAudioLatencies,
  timelineSchema,
  type CallEvent,
} from "@/lib/postcall/timeline";

const context = { country: "IN" as const };
const real = timelineSchema.parse(JSON.parse(readFileSync("tests/fixtures/timeline.json", "utf8")));

const caller = (text: string): CallEvent => ({ kind: "caller", text, confidence: 1 });
const agent = (text: string): CallEvent => ({ kind: "agent", text, interrupted: false });
const save = (
  field: string,
  value: string,
  status: string,
  extra: Partial<CallEvent> = {},
): CallEvent =>
  ({
    kind: "tool",
    name: "save_field",
    args: { field, value, status },
    at: 1,
    durationMs: 100,
    failed: false,
    ...extra,
  }) as CallEvent;

describe("callEvents on a real timeline", () => {
  it("orders caller speech, tool calls and agent speech even when a turn is oddly labelled", () => {
    const kinds = callEvents(real).map((event) =>
      event.kind === "tool" ? `tool:${String(event.args.status)}` : event.kind,
    );
    expect(kinds).toEqual([
      "agent",
      "caller",
      "tool:heard",
      "agent",
      "caller",
      "tool:confirmed",
      "agent",
      "caller",
      "tool:heard",
      "agent",
      "caller",
      "tool:confirmed",
      "agent",
      "caller",
      "agent",
    ]);
  });

  it("reads the platform's own first-audio latencies, leaving out the greeting", () => {
    expect(firstAudioLatencies(real)).toEqual([506]);
  });
});

describe("replayChart", () => {
  it("confirms both fields of the real call, because every readback was spoken and answered yes", () => {
    const replay = replayChart(callEvents(real), context);
    expect(replay.issues).toEqual([]);
    expect(replay.chart.full_name).toMatchObject({ status: "confirmed", value: "Arjun Mehta" });
    expect(replay.chart.date_of_birth).toMatchObject({ status: "confirmed", value: "1990-03-12" });
  });

  it("does not let a yes given to one field confirm the next one", () => {
    const replay = replayChart(
      [
        caller("My name is Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        agent("I have your name as Arjun Mehta. Is that right?"),
        caller("Yes, that's correct."),
        save("full_name", "Arjun Mehta", "confirmed"),
        save("phone", "98765 43210", "heard"),
        agent(
          "I have your number as nine eight seven six five, four three two one zero. Is that right?",
        ),
        // The caller says nothing here, and the model reports a confirmation anyway.
        save("phone", "98765 43210", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.full_name.status).toBe("confirmed");
    expect(replay.chart.phone.status).toBe("heard");
    expect(replay.issues).toEqual([{ field: "phone", issue: "no_answer_after_readback" }]);
  });

  it("does not accept a confirmation the agent never read back aloud", () => {
    const replay = replayChart(
      [
        caller("It's Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        agent("One moment."),
        caller("yes"),
        save("full_name", "Arjun Mehta", "confirmed"),
      ],
      context,
    );
    expect(replay.issues).toEqual([{ field: "full_name", issue: "readback_not_spoken" }]);
    expect(replay.chart.full_name.status).toBe("heard");
  });

  it("does not accept a confirmation when the caller did not say yes", () => {
    const replay = replayChart(
      [
        save("phone", "98765 43210", "heard"),
        agent(
          "I have your number as nine eight seven six five, four three two one zero. Is that right?",
        ),
        caller("No, the last digit is one."),
        save("phone", "98765 43210", "confirmed"),
      ],
      context,
    );
    expect(replay.issues).toEqual([
      { field: "phone", issue: "caller_did_not_agree", callerSaid: "No, the last digit is one." },
    ]);
    expect(replay.chart.phone.status).toBe("heard");
  });

  it("lets the reducer refuse a confirmation with no readback, and skips failed, foreign and malformed calls", () => {
    const replay = replayChart(
      [
        caller("yes"),
        save("allergies", "none", "confirmed"),
        save("full_name", "Arjun Mehta", "heard", { failed: true }),
        { kind: "tool", name: "find_slots", args: {}, at: 1, durationMs: 5, failed: false },
        {
          kind: "tool",
          name: "save_field",
          args: { field: 7 },
          at: null,
          durationMs: null,
          failed: false,
        },
        {
          kind: "tool",
          name: "save_field",
          args: { field: "phone", status: "maybe" },
          at: null,
          durationMs: null,
          failed: false,
        },
        {
          kind: "tool",
          name: "save_field",
          args: { field: "reason_for_visit", value: 42, status: "heard" },
          at: null,
          durationMs: null,
          failed: false,
        },
      ],
      context,
    );
    expect(replay.issues).toEqual([]);
    expect(replay.chart.allergies.status).toBe("missing");
    expect(replay.chart.full_name.status).toBe("missing");
    expect(replay.chart.reason_for_visit.status).toBe("missing");
  });

  it("ignores confirmations of unknown fields", () => {
    expect(
      replayChart([caller("yes"), save("blood_group", "O", "confirmed")], context).issues,
    ).toEqual([]);
  });
});

describe("wasSpoken and isAgreement", () => {
  it("counts a number read aloud as spoken when the transcript wrote it as digits", () => {
    // Seen in a real call: the tool gave words to say, the transcriber wrote numerals.
    expect(
      wasSpoken(
        "I have your number as nine eight one two three, four five six seven eight. Is that right?",
        "I have your number as 9 8 1 2 3 4 5 6 7 8. Is that right?",
      ),
    ).toBe(true);
    expect(
      wasSpoken(
        "I have your date of birth as 12 March 1990. Is that right?",
        "I have your date of birth as March 12th 1990. Is that right?",
      ),
    ).toBe(true);
    // Seen in a real call the other way round: the agent's words were written out in full.
    expect(
      wasSpoken(
        "I have your date of birth as 12 March 1990. Is that right?",
        "I have your date of birth as March twelfth, nineteen ninety. Is that right?",
      ),
    ).toBe(true);
    // A different day is a different date, however it was said.
    expect(
      wasSpoken(
        "I have your date of birth as 12 March 1990. Is that right?",
        "I have your date of birth as March thirteenth, nineteen ninety. Is that right?",
      ),
    ).toBe(false);
    // A different number is still a different number.
    expect(
      wasSpoken(
        "I have your number as nine eight one two three, four five six seven eight. Is that right?",
        "I have your number as 9 8 1 2 3 4 5 6 7 9. Is that right?",
      ),
    ).toBe(false);
  });

  it("accepts the readback voiced with small differences, and rejects a paraphrase", () => {
    expect(
      wasSpoken(
        "I have your date of birth as 12 March 1990. Is that right?",
        "I have your date of birth as 12 March, 1990, is that right?",
      ),
    ).toBe(true);
    expect(
      wasSpoken("I have your name as Arjun Mehta. Is that right?", "Got it, Arjun. Anything else?"),
    ).toBe(false);
    expect(wasSpoken("", "anything")).toBe(false);
  });

  it("hears a clear yes in English, Hinglish and Hindi, and nothing with a no in it", () => {
    for (const yes of ["Yes, that's correct.", "Haan ji", "हाँ सही है", "That's right", "yep"]) {
      expect(isAgreement(yes), yes).toBe(true);
    }
    for (const no of ["No, that's right.", "nahi", "That is wrong", "Hmm", "गलत है"]) {
      expect(isAgreement(no), no).toBe(false);
    }
  });
});

describe("timeline parsing", () => {
  it("accepts arguments as JSON strings and drops arguments it cannot read", () => {
    const timeline = timelineSchema.parse({
      session_id: "s",
      turns: [
        {
          turn_id: "t1",
          user_transcript: "  ",
          agent_text: "Sorry, go on.",
          interrupted_at_ms: 1234,
          tool_calls: [
            {
              call_id: "a",
              name: "save_field",
              arguments: '{"field":"phone","value":"1","status":"heard"}',
            },
            { call_id: "b", name: "save_field", arguments: "not json" },
            { call_id: "c", name: "save_field", arguments: "[1,2]" },
            { call_id: "d", name: "finish_intake", timed_out: true },
          ],
        },
      ],
    });
    const events = callEvents(timeline);
    expect(events.map((event) => (event.kind === "tool" ? event.args : event.kind))).toEqual([
      { field: "phone", value: "1", status: "heard" },
      {},
      {},
      {},
      "agent",
    ]);
    expect(events[3]).toMatchObject({ failed: true, at: null, durationMs: null });
    expect(events[4]).toEqual({ kind: "agent", text: "Sorry, go on.", interrupted: true });
    expect(timelineSchema.parse({ session_id: "empty" }).turns).toEqual([]);
    const noConfidence = timelineSchema.parse({
      session_id: "s",
      turns: [{ turn_id: "t", user_transcript: "hello" }],
    });
    expect(callEvents(noConfidence)).toEqual([{ kind: "caller", text: "hello", confidence: null }]);
  });
});
