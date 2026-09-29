import { describe, expect, it, vi } from "vitest";
import { allowedEdits, chooseMatch, drugWords, editDistance } from "@/lib/medication/match";
import { createRxNormLookup, type FetchLike } from "@/lib/medication/rxnorm";

/** Shapes and top candidates as returned by the live RxNorm API when this was written. */
const LIVE = {
  metphormin: [
    { rxcui: "6809", rxaui: "10328664", score: "7.83", rank: "1", source: "GS" },
    {
      rxcui: "6809",
      rxaui: "12251601",
      score: "7.83",
      rank: "1",
      name: "metformin",
      source: "RXNORM",
    },
    {
      rxcui: "6809",
      rxaui: "2628685",
      score: "7.83",
      rank: "1",
      name: "METFORMIN",
      source: "VANDF",
    },
  ],
  Glycomet: [
    { rxcui: "1426910", score: "7.46", rank: "1", name: "glycogen", source: "RXNORM" },
    { rxcui: "1426910", score: "7.46", rank: "1", source: "GS" },
  ],
  "Dolo 650": [{ rxcui: "543632", score: "6.41", rank: "1", name: "No Dolo", source: "RXNORM" }],
  "telmisartan 40": [
    { rxcui: "316764", score: "12.1", rank: "1", name: "telmisartan 40 MG", source: "RXNORM" },
  ],
};

function rxnorm(candidates: unknown[] | null, status = 200): FetchLike {
  return vi.fn<FetchLike>(
    async () =>
      new Response(
        JSON.stringify(candidates ? { approximateGroup: { candidate: candidates } } : {}),
        { status },
      ),
  );
}

describe("drugWords", () => {
  it("keeps the drug and drops doses, forms and frequencies", () => {
    expect(drugWords("Metformin 500 mg twice daily")).toBe("metformin");
    expect(drugWords("telmisartan 40 MG")).toBe("telmisartan");
    expect(drugWords("Salbutamol syrup 2.5 ml at night")).toBe("salbutamol");
  });

  it("keeps a number that is part of the name, with or without a space", () => {
    expect(drugWords("Vitamin B12")).toBe("vitamin b12");
    expect(drugWords("Vitamin D3")).toBe("vitamin d3");
    expect(drugWords("Tylenol 3")).toBe("tylenol 3");
    expect(drugWords("Dolo 650")).toBe("dolo 650");
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions and substitutions", () => {
    expect(editDistance("metphormin", "metformin")).toBe(2);
    expect(editDistance("glycomet", "glycogen")).toBe(2);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe("allowedEdits", () => {
  it("allows one edit per four letters after the first, never more than two", () => {
    expect([4, 5, 8, 9, 10, 20].map((n) => allowedEdits("x".repeat(n)))).toEqual([
      0, 1, 1, 2, 2, 2,
    ]);
  });
});

describe("chooseMatch", () => {
  it("turns a misspelling into a question for the caller, never a silent change", () => {
    expect(chooseMatch("metphormin", [{ rxcui: "6809", name: "metformin" }])).toEqual({
      kind: "suggestion",
      name: "metformin",
      rxcui: "6809",
      heard: "metphormin",
    });
  });

  it("never swaps an Indian brand for a different drug that happens to rank first", () => {
    expect(chooseMatch("Glycomet", [{ rxcui: "1426910", name: "glycogen" }])).toEqual({
      kind: "none",
      name: "Glycomet",
    });
    expect(chooseMatch("Dolo 650", [{ rxcui: "543632", name: "No Dolo" }]).kind).toBe("none");
  });

  it("recognises an exact name even with a dose attached on either side", () => {
    expect(
      chooseMatch("Telmisartan 40 mg", [{ rxcui: "316764", name: "telmisartan 40 MG" }]),
    ).toEqual({
      kind: "exact",
      name: "telmisartan",
      rxcui: "316764",
    });
  });

  it("picks the closest of several candidates, whatever their order", () => {
    const candidates = [
      { rxcui: "1", name: "metoprolol" },
      { rxcui: "6809", name: "metformin" },
      { rxcui: "2", name: "methotrexate" },
    ];
    expect(chooseMatch("metformin", candidates)).toEqual({
      kind: "exact",
      name: "metformin",
      rxcui: "6809",
    });
  });

  it("asks rather than treating one strength of a drug as another", () => {
    const pairs: Array<[string, string]> = [
      ["Vitamin B12", "Vitamin B6"],
      ["Vitamin D3", "Vitamin D2"],
      ["Tylenol 3", "Tylenol"],
    ];
    for (const [spoken, candidate] of pairs) {
      const match = chooseMatch(spoken, [{ rxcui: "1", name: candidate }]);
      expect(match.kind, `${spoken} vs ${candidate}`).not.toBe("exact");
    }
  });

  it("still drops a real dose, so the drug itself matches exactly", () => {
    expect(chooseMatch("metformin 500 mg", [{ rxcui: "6809", name: "Metformin" }])).toEqual({
      kind: "exact",
      name: "metformin",
      rxcui: "6809",
    });
  });

  it("keeps the caller's words when there is nothing to compare", () => {
    expect(chooseMatch("  florbenax ", [])).toEqual({ kind: "none", name: "florbenax" });
    expect(chooseMatch("500 mg", [{ rxcui: "1", name: "x" }])).toEqual({
      kind: "none",
      name: "500 mg",
    });
  });
});

describe("createRxNormLookup", () => {
  it("looks up only RxNorm-sourced names and applies the spelling rule", async () => {
    const fetchImpl = rxnorm(LIVE.metphormin);
    const match = await createRxNormLookup(fetchImpl).lookup("metphormin 500 mg");
    expect(match).toMatchObject({ kind: "suggestion", name: "metformin", rxcui: "6809" });
    const url = String(vi.mocked(fetchImpl).mock.calls[0]?.[0]);
    expect(url).toContain("approximateTerm.json?term=metphormin&maxEntries=8");
  });

  it("returns the caller's words for brands the database does not know", async () => {
    expect(await createRxNormLookup(rxnorm(LIVE.Glycomet)).lookup("Glycomet")).toEqual({
      kind: "none",
      name: "Glycomet",
    });
    expect((await createRxNormLookup(rxnorm(LIVE["Dolo 650"])).lookup("Dolo 650")).kind).toBe(
      "none",
    );
    expect(
      (await createRxNormLookup(rxnorm(LIVE["telmisartan 40"])).lookup("telmisartan 40 mg")).kind,
    ).toBe("exact");
    // Without a unit the number may belong to the name, so the caller's words are kept.
    expect(
      (await createRxNormLookup(rxnorm(LIVE["telmisartan 40"])).lookup("telmisartan 40")).kind,
    ).toBe("none");
  });

  it("treats short terms, empty results, errors, bad shapes and timeouts as not found", async () => {
    const neverCalled = vi.fn<FetchLike>();
    expect((await createRxNormLookup(neverCalled).lookup("ab")).kind).toBe("none");
    expect(neverCalled).not.toHaveBeenCalled();
    expect((await createRxNormLookup(rxnorm(null)).lookup("florbenax")).kind).toBe("none");
    expect((await createRxNormLookup(rxnorm([], 503)).lookup("florbenax")).kind).toBe("none");
    const badShape = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ approximateGroup: 7 })),
    );
    expect((await createRxNormLookup(badShape).lookup("florbenax")).kind).toBe("none");
    const down = vi.fn<FetchLike>(async () => Promise.reject(new Error("timeout")));
    expect(await createRxNormLookup(down).lookup("metformin")).toEqual({
      kind: "none",
      name: "metformin",
    });
  });
});
