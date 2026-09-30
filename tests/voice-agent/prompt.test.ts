import { describe, expect, it } from "vitest";
import { DEMO_CLINIC, type Clinic } from "@/lib/clinic/config";
import { FIELD_IDS } from "@/lib/intake/fields";
import {
  emergencyNumber,
  greeting,
  keyterms,
  systemPrompt,
  transcriptionPrompt,
} from "@/lib/voice-agent/prompt";

/**
 * The prompt is the product on a live call, so these read it the way a
 * reviewer would: each rule the agent got wrong on a real call has a test that
 * names the behaviour, and the rules it already got right are pinned so a
 * later edit cannot quietly drop one.
 */

const usClinic: Clinic = { ...DEMO_CLINIC, country: "US", timezone: "America/New_York" };
const prompt = systemPrompt(DEMO_CLINIC);

/** The paragraph a rule lives in, so a test reads one instruction, not the whole prompt. */
function paragraphWith(text: string, needle: string): string {
  const found = text.split("\n\n").filter((block) => block.includes(needle));
  expect(found, `no single paragraph contains ${needle}`).toHaveLength(1);
  return found[0] as string;
}

describe("systemPrompt: the reason for the visit", () => {
  it("saves the reason as soon as the caller gives it, before it is asked for", () => {
    const rule = paragraphWith(prompt, "reason_for_visit");
    expect(rule).toContain("The moment the caller says why they are calling");
    expect(rule).toContain("before you ask");
    expect(rule).toMatch(/call save_field for reason_for_visit with status heard/);
  });

  it("keeps the caller's own wording rather than the agent's summary of it", () => {
    expect(paragraphWith(prompt, "reason_for_visit")).toContain("in their own words");
  });

  it("forbids asking a second time for a reason already on the chart", () => {
    expect(paragraphWith(prompt, "reason_for_visit")).toContain(
      "Never ask for a reason you have already saved.",
    );
  });

  it("still lists the reason as a detail to collect, for callers who never volunteer it", () => {
    expect(prompt).toContain("4. The reason for the visit, in a few words.");
  });
});

describe("systemPrompt: the preferred time", () => {
  it("saves what the caller asked for before looking for slots, so the chart shows it", () => {
    // A real call booked a slot and still left preferred_time empty on the chart.
    const step = systemPrompt(DEMO_CLINIC)
      .split("\n")
      .find((line) => line.startsWith("7."));
    expect(step).toContain("preferred_time");
    expect(step).toContain("status heard");
    expect(step).toContain("find_slots");
  });
});

describe("systemPrompt: appointment times", () => {
  it("looks up slots once for what the caller asked for", () => {
    expect(paragraphWith(prompt, "Call find_slots once")).toContain(
      "Call find_slots once for what the caller asked for, then offer those times in words.",
    );
  });

  it("names the only two reasons to look slots up again, so the same answer is not re-fetched", () => {
    const rule = paragraphWith(prompt, "Call find_slots once");
    expect(rule).toContain("Call it again only if");
    expect(rule).toContain("names a different day or time of day");
    expect(rule).toContain("the time they chose has gone");
  });

  it("bounds a vague caller to two tries, then hands the call over instead of looping", () => {
    const rule = paragraphWith(prompt, "Call find_slots once");
    expect(rule).toContain("offer the first time as a yes or no question");
    expect(rule).toMatch(/after two tries with no choice, call escalate with urgent false/);
  });

  it("keeps the three-time offer and the booking step it ends in", () => {
    // Step 7 now also saves the time the caller asked for; the offer and the booking are unchanged.
    expect(prompt).toContain("use find_slots, offer at most three times, then book_appointment.");
  });
});

describe("systemPrompt: rules the new instructions must not have disturbed", () => {
  it("still leads with the readback rule, ahead of everything added since", () => {
    expect(prompt.startsWith("READ BACK BEFORE YOU CONFIRM.")).toBe(true);
    expect(prompt).toContain("Never confirm a detail the caller has not said yes to.");
  });

  it("still opens the call with start_intake and closes it with finish_intake", () => {
    expect(prompt).toContain("At the very start of your first reply, call start_intake.");
    expect(prompt).toContain("Before you say goodbye, call finish_intake.");
  });

  it("still collects every intake field, in order", () => {
    const numbered = prompt.match(/^\d+\. .+$/gm) ?? [];
    expect(numbered).toHaveLength(FIELD_IDS.length);
    const order = ["Full name", "Date of birth", "phone number", "reason", "medications"];
    let cursor = -1;
    for (const label of order) {
      const next = prompt.indexOf(label);
      expect(next, label).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("still drives every field through heard, confirmed and unresolved", () => {
    const rule = paragraphWith(prompt, "After each detail");
    for (const status of ["status heard", "status confirmed", "status unresolved"]) {
      expect(rule, status).toContain(status);
    }
  });

  it("still routes an emergency to the country's number and stops the intake there", () => {
    expect(prompt).toContain("call escalate with urgent true");
    expect(prompt).toContain("call one one two now. Do not continue the intake.");
    expect(systemPrompt(usClinic)).toContain("call nine one one now. Do not continue the intake.");
    expect(emergencyNumber(DEMO_CLINIC)).toBe("one one two");
    expect(emergencyNumber(usClinic)).toBe("nine one one");
  });

  it("still hands over on request or upset, which the slot and silence rules now reuse", () => {
    expect(prompt).toContain("If the caller asks for a person, or is upset, call escalate");
    // Three uses now: a caller who will not choose a time, one who asks for a person
    // or is upset, and one who has stopped answering.
    expect(prompt.match(/call escalate with urgent false/g)).toHaveLength(3);
  });

  it("still refuses clinical judgement and names what it may do instead", () => {
    expect(prompt).toContain("Things you CAN do:");
    expect(prompt).toContain("Things you CANNOT do: give medical advice");
    expect(prompt).toContain("say what a symptom means");
  });

  it("still bans bot phrases and reading identifiers aloud", () => {
    for (const phrase of ["certainly", "absolutely", "great question", "as an AI"]) {
      expect(prompt, phrase).toContain(`"${phrase}"`);
    }
    expect(prompt).toContain("Never read out an intake id or a slot id.");
  });

  // A caller on the phone line gave his name, heard a different name read back at
  // confidence 1.0, said no, was asked to say it again, and was heard the same way a
  // second time. Saying it again is not a correction, it is the same input.
  it("asks the caller to spell a name it got wrong, rather than to repeat it", () => {
    expect(prompt).toMatch(/says a name is wrong[^.]*ask them to spell it/i);
    expect(prompt).toMatch(/say it again only hears it the same way twice/i);
    expect(prompt).toMatch(/one part at a time, the given name then the family name/i);
  });

  it("still expects English, Hindi or a mix, and answers in simple English", () => {
    expect(prompt).toContain("The caller may speak English, Hindi, or a mix.");
  });

  it("stays short enough to be a phone-call instruction, and names the clinic it answers for", () => {
    expect(prompt).toContain("Sunrise Family Clinic");
    // Rules were added for what a real caller does: goes quiet, asks to hear a value
    // again, disowns one, asks a question of their own, rings off, and tells the agent
    // it has their name wrong. The bound moves with them and stays tight, because a
    // long prompt drowns its best rule.
    expect(prompt.length).toBeLessThan(4_500);
  });
});

describe("systemPrompt: what a real caller does", () => {
  it("ends the call on one goodbye instead of repeating a confirmation", () => {
    // Three of four live calls said goodbye, or read the booking back, up to seven
    // times, and ran until an external timer cut them off.
    const rule = paragraphWith(prompt, "that sentence is the goodbye");
    expect(rule).toContain("When finish_intake or escalate returns a sentence");
    expect(rule).toContain("Say it once, word for word, then stop.");
    expect(rule).toContain("never say goodbye twice");
    expect(rule).toContain("never repeat a booking confirmation");
    expect(rule).toContain("call no tool after it");
  });

  it("asks a silent caller once, then hands over rather than sitting in silence", () => {
    const rule = paragraphWith(prompt, "gone quiet");
    expect(rule).toContain("ask once whether they are still there");
    expect(rule).toMatch(/If nothing comes back, call escalate with urgent false/);
    expect(rule).toContain("Silence is never a reason to keep talking.");
  });

  it("reproduces a value through save_field rather than saying a number from memory", () => {
    const rule = paragraphWith(prompt, "asks to hear a detail again");
    expect(rule).toContain("call save_field for that field with the same value and status heard");
    expect(rule).toContain("say the sentence it returns");
    expect(rule).toContain("Never say a number or a date back from memory.");
  });

  it("records that a caller has disowned a value instead of leaving the old one", () => {
    const rule = paragraphWith(prompt, "replaces_earlier_value");
    expect(rule).toContain("is not theirs any more");
    expect(rule).toContain("replaces_earlier_value true");
  });

  it("answers the caller's own questions from tool results, reason included", () => {
    const rule = paragraphWith(prompt, "Answer a question of the caller's own");
    expect(rule).toContain("only from what a tool gave you");
    expect(rule).toContain("the clinic's hours and today's date from start_intake");
    expect(rule).toContain("the reason find_slots gives when it has no times");
    expect(rule).toContain("Say that reason, not just that nothing is free.");
  });
});

describe("what the caller and the transcriber hear", () => {
  it("discloses recording in the greeting and invites the caller to say why they rang", () => {
    expect(greeting(DEMO_CLINIC)).toBe(
      "Hello, you've reached Sunrise Family Clinic. This call is recorded to prepare for your visit. How can I help you today?",
    );
  });

  it("describes the call to the transcriber by the clinic's country", () => {
    expect(transcriptionPrompt(DEMO_CLINIC)).toContain("in India");
    expect(transcriptionPrompt(usClinic)).toContain("in the United States");
  });

  it("biases transcription to the clinic's own names, deduplicated and within the platform limits", () => {
    const terms = keyterms({
      ...DEMO_CLINIC,
      formulary: [...DEMO_CLINIC.formulary, DEMO_CLINIC.formulary[0] as string, "y".repeat(60)],
    });
    expect(terms[0]).toBe("Sunrise Family Clinic");
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.every((term) => term.length <= 50)).toBe(true);
    const many = keyterms({
      ...DEMO_CLINIC,
      formulary: Array.from({ length: 80 }, (_, index) => `drug-${index}`),
      doctors: Array.from({ length: 20 }, (_, index) => ({
        id: `d-${index}`,
        name: `Doctor ${index}`,
        specialty: "GP",
      })),
    });
    expect(many).toHaveLength(100);
  });
});
