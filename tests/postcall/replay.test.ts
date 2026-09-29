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

  it("does not take a Hindi word, a complaint or laughter for a yes", () => {
    // Each of these was scored as agreement to whatever had just been read back.
    for (const no of [
      "जी मिचला रहा है", // "I feel nauseous": जी matched as a bare substring.
      "मेरा जीवन ठीक है", // जी inside जीवन.
      "ना जी", // "No, sir": ना was missing from the negatives.
      "ha ha",
      "ha ha ha",
      "नहीं जी",
    ]) {
      expect(isAgreement(no), no).toBe(false);
    }
    // The honorific yes still counts when it is the whole answer, or carries its own yes.
    for (const yes of ["जी", "जी।", "ji", "जी हाँ", "हां जी"]) {
      expect(isAgreement(yes), yes).toBe(true);
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

  it("keeps the turns it can read when the platform sends one it cannot", () => {
    const timeline = timelineSchema.parse({
      // No session id and no turn ids: nothing here reads either, and requiring
      // them threw the whole call away.
      started_at_unix_ms: "not a number",
      turns: [
        { user_transcript: "My name is Arjun Mehta." },
        { turn_id: "t2", user_transcript: 7 },
        null,
        "a turn in some shape from the future",
        { turn_id: "t3", agent_text: "I have your name as Arjun Mehta. Is that right?" },
      ],
    });
    expect(timeline.started_at_unix_ms).toBeUndefined();
    expect(callEvents(timeline)).toEqual([
      { kind: "caller", text: "My name is Arjun Mehta.", confidence: null },
      {
        kind: "agent",
        text: "I have your name as Arjun Mehta. Is that right?",
        interrupted: false,
      },
    ]);
    // A turn list that is not a list is the same kind of loss, and costs no more.
    expect(timelineSchema.parse({ session_id: "s", turns: "none today" }).turns).toEqual([]);
  });
});

describe("a caller who does not follow the script", () => {
  const nameReadback = "I have your name as Arjun Mehta. Is that right?";

  it("will not let one yes confirm two values at once", () => {
    const now = { at: Date.parse("2026-09-29T06:00:00Z") };
    const replay = replayChart(
      [
        caller("I am Arjun Mehta, born on the twelfth of March nineteen ninety"),
        save("full_name", "Arjun Mehta", "heard", now),
        save("date_of_birth", "1990-03-12", "heard", now),
        agent(`${nameReadback} I have your date of birth as 12 March 1990. Is that right?`),
        caller("Yes"),
        save("full_name", "Arjun Mehta", "confirmed", now),
        save("date_of_birth", "1990-03-12", "confirmed", now),
      ],
      context,
    );
    expect(replay.chart.full_name.status).toBe("confirmed");
    // The same word cannot answer for the second field as well.
    expect(replay.chart.date_of_birth.status).toBe("heard");
    expect(replay.issues).toEqual([
      { field: "date_of_birth", issue: "one_yes_two_values", alsoAnswered: "full_name" },
    ]);
  });

  it("will not accept a yes to a readback the caller talked over", () => {
    const replay = replayChart(
      [
        caller("Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        { kind: "agent", text: nameReadback, interrupted: true } as CallEvent,
        caller("yes yes"),
        save("full_name", "Arjun Mehta", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.full_name.status).toBe("heard");
    expect(replay.issues).toEqual([{ field: "full_name", issue: "readback_interrupted" }]);
  });

  it("does not forget a readback because the agent reported the value twice", () => {
    const replay = replayChart(
      [
        caller("Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        agent(nameReadback),
        caller("Yes, that's right."),
        // The model reports the same value again in the turn it confirms it.
        save("full_name", "Arjun Mehta", "heard"),
        save("full_name", "Arjun Mehta", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.full_name.status).toBe("confirmed");
    expect(replay.issues).toEqual([]);
  });

  const phoneReadback =
    "I have your number as nine eight seven six five, four three two one zero. Is that right?";

  it("does not let a yes to a later question confirm a value the caller rejected", () => {
    const replay = replayChart(
      [
        save("phone", "98765 43210", "heard"),
        agent(phoneReadback),
        caller("No, that is not my number."),
        agent("What is the best number to reach you on?"),
        // An answer to the new question, taken by the model as agreement to the old value.
        caller("Yes please"),
        save("phone", "98765 43210", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.phone.status).toBe("heard");
    expect(replay.issues).toEqual([
      { field: "phone", issue: "caller_did_not_agree", callerSaid: "No, that is not my number." },
    ]);
  });

  it("accepts the yes after a readback the agent had to say a second time", () => {
    const replay = replayChart(
      [
        save("phone", "98765 43210", "heard"),
        agent(phoneReadback),
        caller("Sorry, could you say that again?"),
        agent(phoneReadback),
        caller("Yes, that's right."),
        save("phone", "98765 43210", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.phone.status).toBe("confirmed");
    expect(replay.issues).toEqual([]);
  });

  it("does not flag one yes as two values when the model reports the same confirmation twice", () => {
    const replay = replayChart(
      [
        caller("Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        agent(nameReadback),
        caller("Yes"),
        save("full_name", "Arjun Mehta", "confirmed"),
        save("full_name", "Arjun Mehta", "confirmed"),
      ],
      context,
    );
    expect(replay.chart.full_name.status).toBe("confirmed");
    expect(replay.issues).toEqual([]);
  });

  it("dates a tool event with no timestamp from the call, not from 1970", () => {
    const replay = replayChart(
      [
        caller("twelfth of March nineteen ninety"),
        save("date_of_birth", "1990-03-12", "heard", { at: null }),
      ],
      context,
      Date.parse("2026-09-29T06:00:00Z"),
    );
    // With 1970 as "now" a real date of birth reads as impossible and vanishes silently.
    expect(replay.chart.date_of_birth.value).toBe("1990-03-12");
    expect(replay.chart.date_of_birth.status).toBe("heard");
  });

  it("does not read a bare 'right' inside a sentence as agreement", () => {
    const replay = replayChart(
      [
        caller("my number is 98765 43210"),
        save("phone", "98765 43210", "heard"),
        agent(
          "I have your number as nine eight seven six five, four three two one zero. Is that right?",
        ),
        caller("Sorry, I didn't hear you right."),
        save("phone", "98765 43210", "confirmed"),
      ],
      context,
    );
    // The caller asked to hear it again. That is not a yes, and this field used to
    // come out confirmed and green off it.
    expect(replay.chart.phone.status).toBe("heard");
    // Not a refusal: the caller asked to hear it again. The chart says exactly that,
    // rather than telling the clinic the caller objected.
    expect(replay.issues).toEqual([
      {
        field: "phone",
        issue: "caller_did_not_confirm",
        callerSaid: "Sorry, I didn't hear you right.",
      },
    ]);
  });

  it("still takes a plain 'that's right' or 'ठीक है' as agreement", () => {
    for (const answer of ["That's right.", "Correct.", "ठीक है"]) {
      const replay = replayChart(
        [
          caller("Arjun Mehta"),
          save("full_name", "Arjun Mehta", "heard"),
          agent("I have your name as Arjun Mehta. Is that right?"),
          caller(answer),
          save("full_name", "Arjun Mehta", "confirmed"),
        ],
        context,
      );
      expect(replay.chart.full_name.status).toBe("confirmed");
      expect(replay.issues).toEqual([]);
    }
  });

  it("catches one yes spent on two values even when a third is judged in between", () => {
    const replay = replayChart(
      [
        caller("Arjun Mehta"),
        save("full_name", "Arjun Mehta", "heard"),
        agent("I have your name as Arjun Mehta. Is that right?"),
        caller("Yes"),
        save("full_name", "Arjun Mehta", "confirmed"),
        caller("98765 43210 and no allergies"),
        save("phone", "98765 43210", "heard"),
        save("allergies", "none", "heard"),
        agent(
          "I have your number as nine eight seven six five, four three two one zero. Is that right? " +
            "I have that you have no known allergies. Is that right?",
        ),
        caller("Yes, both of those are correct"),
        save("phone", "98765 43210", "confirmed"),
        // The model re-files the name it already confirmed. A single-slot guard forgot
        // which yes had been spent here, and the allergy list went through unflagged.
        save("full_name", "Arjun Mehta", "confirmed"),
        save("allergies", "none", "confirmed"),
      ],
      context,
    );
    expect(replay.issues).toEqual([
      { field: "allergies", issue: "one_yes_two_values", alsoAnswered: "phone" },
    ]);
    expect(replay.chart.allergies.status).toBe("heard");
  });

  it("refuses a readback the agent voiced with a different value", () => {
    expect(
      wasSpoken(
        "I have your name as Arjun Mehta. Is that right?",
        "I have your name as Arjun Sharma. Is that right?",
      ),
    ).toBe(false);
    expect(
      wasSpoken(
        "I have your allergies as penicillin. Is that the complete list?",
        "I have your allergies as sulfa. Is that the complete list?",
      ),
    ).toBe(false);
    // The frame around the value may still be said any way the agent likes.
    expect(
      wasSpoken(
        "I have your date of birth as 12 March 1990. Is that right?",
        "So, I have your date of birth as March twelfth, nineteen ninety. Is that right?",
      ),
    ).toBe(true);
  });

  it("tells the desk whether the caller objected or simply never said yes", () => {
    const answer = (said: string) =>
      replayChart(
        [
          caller("I take metformin every day"),
          save("medications", "metformin", "heard"),
          agent("I have your medications as metformin. Is that the complete list?"),
          caller(said),
          save("medications", "metformin", "confirmed"),
        ],
        context,
      ).issues[0];

    // Leading with a no, or calling the value wrong, is the caller objecting.
    expect(answer("No, I also take aspirin.")).toMatchObject({ issue: "caller_did_not_agree" });
    expect(answer("That is wrong.")).toMatchObject({ issue: "caller_did_not_agree" });
    // A "not" inside a careful answer is not an objection, and saying it was would be
    // telling a clinic something untrue about its own patient.
    expect(
      answer("I am not certain of the name, I would have to check the box at home."),
    ).toMatchObject({
      issue: "caller_did_not_confirm",
      callerSaid: "I am not certain of the name, I would have to check the box at home.",
    });
    expect(answer("Hold on a moment.")).toMatchObject({ issue: "caller_did_not_confirm" });
  });
});
