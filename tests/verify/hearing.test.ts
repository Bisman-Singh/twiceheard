import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIELDS } from "@/lib/intake/fields";
import { tokens, verifyValue, type HeardWord, type Utterance } from "@/lib/verify/hearing";

interface FixtureUtterance {
  channel: string;
  words: HeardWord[];
}

/** The caller's side of a real multichannel transcript of a synthetic test call. */
const fixture = JSON.parse(readFileSync("tests/fixtures/second-hearing.json", "utf8")) as {
  utterances: FixtureUtterance[];
};
const caller: Utterance[] = fixture.utterances.filter((u) => u.channel === "1").map((u) => u.words);

function said(text: string, confidence = 0.99): Utterance {
  return text
    .split(" ")
    .map((word, index) => ({ text: word, confidence, start: index, end: index + 1 }));
}

function withLowWord(text: string, low: string, confidence: number): Utterance {
  return said(text).map((word) =>
    word.text.replace(/[^\w]/g, "") === low ? { ...word, confidence } : word,
  );
}

describe("tokens", () => {
  it("drops punctuation, lowers case, splits slashed dates and strips ordinals", () => {
    expect(tokens(said("The 12th of March, 1990. 12/03/1990 Don't")).map((t) => t.token)).toEqual([
      "the",
      "12",
      "of",
      "march",
      "1990",
      "12",
      "03",
      "1990",
      "don't",
    ]);
  });
});

describe("verifyValue on a real transcript", () => {
  it("finds the confirmed name and date in the caller's own words, with high confidence", () => {
    const name = verifyValue(FIELDS.full_name, "Arjun Mehta", caller);
    expect(name?.hearing).toBe("agrees");
    expect(name?.minConfidence).toBeGreaterThan(0.9);
    const date = verifyValue(FIELDS.date_of_birth, "1990-03-12", caller);
    expect(date?.hearing).toBe("agrees");
    expect(date?.minConfidence).toBeGreaterThan(0.9);
  });

  it("notices when the recording holds a different date than the chart", () => {
    expect(verifyValue(FIELDS.date_of_birth, "1990-03-21", caller)).toEqual({
      hearing: "differs",
      minConfidence: null,
    });
  });
});

describe("verifyValue", () => {
  it("reports the weakest word that carried a name, and partial matches as different", () => {
    expect(
      verifyValue(FIELDS.full_name, "Arjun Mehta", [
        withLowWord("my name is Arjun Mehta", "Mehta", 0.42),
      ]),
    ).toEqual({
      hearing: "agrees",
      minConfidence: 0.42,
    });
    expect(
      verifyValue(FIELDS.full_name, "Arjun Mehta", [said("my name is Arjun Mehra", 0.8)]),
    ).toEqual({
      hearing: "differs",
      minConfidence: 0.8,
    });
    expect(verifyValue(FIELDS.full_name, "Arjun Mehta", [said("hello there")])).toEqual({
      hearing: "absent",
      minConfidence: null,
    });
  });

  it("accepts dates said month first or written with slashes", () => {
    expect(
      verifyValue(FIELDS.date_of_birth, "1990-03-12", [said("born March 12, 1990")])?.hearing,
    ).toBe("agrees");
    expect(
      verifyValue(FIELDS.date_of_birth, "1990-03-12", [said("it is 12/03/1990")])?.hearing,
    ).toBe("agrees");
    expect(verifyValue(FIELDS.date_of_birth, "1990-03-12", [said("no idea")])?.hearing).toBe(
      "absent",
    );
  });

  it("finds a phone number however the digits were grouped, and scores only those words", () => {
    const grouped: Utterance = [
      ...said("my number is"),
      { text: "98765", confidence: 0.61, start: 10, end: 11 },
      { text: "43210.", confidence: 0.97, start: 11, end: 12 },
      { text: "5", confidence: 0.2, start: 12, end: 13 },
    ];
    expect(verifyValue(FIELDS.phone, "+919876543210", [grouped])).toEqual({
      hearing: "agrees",
      minConfidence: 0.61,
    });
    expect(verifyValue(FIELDS.phone, "+14155552671", [said("call 415 555 2671")])?.hearing).toBe(
      "agrees",
    );
    expect(verifyValue(FIELDS.phone, "+919876543210", [said("it is 98765 43211")])).toEqual({
      hearing: "differs",
      minConfidence: null,
    });
    expect(verifyValue(FIELDS.phone, "+919876543210", [said("just a moment")])?.hearing).toBe(
      "absent",
    );
  });

  it("checks every listed item, and hears none as a clear no", () => {
    const meds = [said("I take Metformin and atorvastatin every day", 0.9)];
    expect(
      verifyValue(FIELDS.medications, ["Metformin 500 mg twice daily", "atorvastatin"], meds),
    ).toEqual({
      hearing: "agrees",
      minConfidence: 0.9,
    });
    expect(verifyValue(FIELDS.medications, ["Metformin", "aspirin"], meds)).toEqual({
      hearing: "differs",
      minConfidence: 0.9,
    });
    expect(verifyValue(FIELDS.allergies, ["penicillin"], meds)?.hearing).toBe("absent");
    expect(verifyValue(FIELDS.allergies, [], [said("no none at all", 0.7)])).toEqual({
      hearing: "agrees",
      minConfidence: 0.7,
    });
    expect(verifyValue(FIELDS.allergies, [], [said("peanuts")])?.hearing).toBe("absent");
  });

  it("matches an item with no letters by the item itself", () => {
    expect(verifyValue(FIELDS.allergies, ["1080"], [said("compound 1080", 0.88)])).toEqual({
      hearing: "agrees",
      minConfidence: 0.88,
    });
  });

  it("checks free text by the words that carry its meaning", () => {
    const spoken = [said("I have had a fever and a sore throat for three days")];
    // Never said the same way twice, so the words are what can be checked.
    expect(
      verifyValue(FIELDS.reason_for_visit, "fever and a sore throat for 3 days", spoken)?.hearing,
    ).toBe("agrees");
    // A reason the recording does not carry must not pass as heard twice: without
    // this the grader fell back to the live chart and the field came out green on
    // the model's word alone.
    expect(verifyValue(FIELDS.reason_for_visit, "a persistent cough", spoken)?.hearing).toBe(
      "absent",
    );
    expect(
      verifyValue(FIELDS.reason_for_visit, "fever and a broken ankle and a rash", spoken)?.hearing,
    ).toBe("differs");
    // Nothing but filler carries no meaning to look for.
    expect(verifyValue(FIELDS.reason_for_visit, "it is about the", spoken)?.hearing).toBe("absent");
  });
});

describe("tokens, numbers the transcriber wrote as words", () => {
  it("reads spoken digits as digits and a spoken year as one number", () => {
    const read = (text: string) => tokens(said(text)).map((t) => t.token);
    expect(read("nine eight seven six five")).toEqual(["9", "8", "7", "6", "5"]);
    expect(read("the twelfth of March, nineteen eighty five")).toEqual([
      "the",
      "12",
      "of",
      "march",
      "1985",
    ]);
    expect(read("the twenty first")).toEqual(["the", "21"]);
    expect(read("five hundred milligrams")).toEqual(["5", "hundred", "milligrams"]);
  });

  it("joins only what was said as one number", () => {
    const read = (text: string) => tokens(said(text)).map((t) => t.token);
    // Half past twelve is a time, and a run of digits is still a run of digits.
    expect(read("twelve thirty")).toEqual(["12", "30"]);
    expect(read("ninety eight seven")).toEqual(["98", "7"]);
  });

  it("scores a joined number by its weakest word", () => {
    expect(tokens(withLowWord("nineteen eighty five", "eighty", 0.3))).toEqual([
      { token: "1985", confidence: 0.3 },
    ]);
  });
});

describe("verifyValue on words a transcriber wrote out", () => {
  it("hears a phone number dictated as words", () => {
    const spoken = [said("my number is nine eight seven six five four three two one zero")];
    expect(verifyValue(FIELDS.phone, "+919876543210", spoken)?.hearing).toBe("agrees");
  });

  it("hears a date of birth said entirely in words", () => {
    expect(
      verifyValue(FIELDS.date_of_birth, "1985-03-12", [
        said("the twelfth of March, nineteen eighty five", 0.95),
      ]),
    ).toEqual({ hearing: "agrees", minConfidence: 0.95 });
  });
});

describe("verifyValue when one number does two jobs", () => {
  it("hears a date whose day is the same number as its month", () => {
    expect(
      verifyValue(FIELDS.date_of_birth, "1990-03-03", [said("the 3rd of March 1990")]),
    ).toEqual({ hearing: "agrees", minConfidence: 0.99 });
    expect(
      verifyValue(FIELDS.date_of_birth, "1990-03-03", [said("it is 03/03/1990")])?.hearing,
    ).toBe("agrees");
    expect(verifyValue(FIELDS.date_of_birth, "1990-03-03", [said("sometime in 3 1990")])).toEqual({
      hearing: "differs",
      minConfidence: null,
    });
  });
});

describe("verifyValue on a name written with a hyphen or a title", () => {
  it("reads the charted name the same way it reads the recording", () => {
    expect(
      verifyValue(FIELDS.full_name, "Kumar-Sharma", [said("my name is Kumar Sharma", 0.93)]),
    ).toEqual({ hearing: "agrees", minConfidence: 0.93 });
    expect(
      verifyValue(FIELDS.full_name, "Dr. Arjun Mehta", [said("this is Dr. Arjun Mehta")])?.hearing,
    ).toBe("agrees");
    expect(verifyValue(FIELDS.full_name, "###", [said("my name is Kumar Sharma")])?.hearing).toBe(
      "absent",
    );
  });
});

describe("verifyValue on a phone number broken by a pause", () => {
  const first: Utterance = [
    ...said("my number is"),
    { text: "98765", confidence: 0.71, start: 10, end: 11 },
  ];
  const second: Utterance = [
    { text: "43210,", confidence: 0.88, start: 20, end: 21 },
    ...said("that's it"),
  ];

  it("joins the digits across the pause", () => {
    expect(verifyValue(FIELDS.phone, "+919876543210", [first, second])).toEqual({
      hearing: "agrees",
      minConfidence: 0.71,
    });
  });

  it("scores only the words that carried the number, not earlier digits", () => {
    const withDate = [said("born 12 March 1990"), first, second];
    expect(verifyValue(FIELDS.phone, "+919876543210", withDate)).toEqual({
      hearing: "agrees",
      minConfidence: 0.71,
    });
  });
});

describe("verifyValue on a list item said inside a denial", () => {
  it("does not read a denied drug as a drug the caller takes", () => {
    expect(
      verifyValue(
        FIELDS.medications,
        ["Metformin"],
        [said("i do not take metformin any more", 0.9)],
      )?.hearing,
    ).toBe("absent");
  });

  it("still hears the drug when the caller states it", () => {
    expect(verifyValue(FIELDS.medications, ["Metformin"], [said("i take metformin", 0.9)])).toEqual(
      {
        hearing: "agrees",
        minConfidence: 0.9,
      },
    );
    // A "no" about the previous question does not reach this far.
    expect(
      verifyValue(
        FIELDS.medications,
        ["Metformin"],
        [said("no allergies at all, and i take metformin", 0.9)],
      )?.hearing,
    ).toBe("agrees");
  });

  it("agrees an empty list only with an utterance that is a denial and nothing else", () => {
    // The goodbye at the end of a call used to verify both empty lists at the
    // confidence of its loudest word, which is the second hearing agreeing with
    // nothing on the two entries where being wrong is most dangerous.
    expect(verifyValue(FIELDS.allergies, [], [said("no that's all thank you")])?.hearing).toBe(
      "absent",
    );
    expect(verifyValue(FIELDS.medications, [], [said("i'm not sure about that")])?.hearing).toBe(
      "absent",
    );
    // A caller listing allergens is not denying medications.
    expect(
      verifyValue(FIELDS.medications, [], [said("no this is my first visit"), said("peanuts")])
        ?.hearing,
    ).toBe("absent");
    // A real denial still agrees, and is scored by its weakest word, not its strongest.
    expect(verifyValue(FIELDS.allergies, [], [said("no known allergies", 0.6)])).toEqual({
      hearing: "agrees",
      minConfidence: 0.6,
    });
  });

  it("understands a denial in Hindi, as the intake side already does", () => {
    expect(verifyValue(FIELDS.allergies, [], [said("nahi koi allergy nahi hai", 0.92)])).toEqual({
      hearing: "agrees",
      minConfidence: 0.92,
    });
  });

  it("looks for the drug in a dose-first item, not for the unit", () => {
    // "500 mg Metformin" was looked for by "mg", so any dose anywhere in the call
    // verified the drug.
    expect(
      verifyValue(FIELDS.medications, ["500 mg Metformin"], [said("i take 5 mg of something else")])
        ?.hearing,
    ).toBe("absent");
    expect(
      verifyValue(FIELDS.medications, ["500 mg Metformin"], [said("i take 500 mg metformin")])
        ?.hearing,
    ).toBe("agrees");
  });
});
