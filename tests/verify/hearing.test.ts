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

  it("does not verify free text", () => {
    expect(verifyValue(FIELDS.reason_for_visit, "cough", caller)).toBeNull();
  });
});
