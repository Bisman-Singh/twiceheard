import { describe, expect, it } from "vitest";
import { CATEGORIES, EVAL_CASES, type EvalCase } from "@/lib/evals/cases";
import { categoryTable, report, resultsTable, summaryLine } from "@/lib/evals/report";
import { runCase, runEvals, type EvalRun } from "@/lib/evals/run";

const run = runEvals();

// A green run stays quiet; ask for the table when you want to read it.
if (process.env.EVALS_REPORT === "1") process.stdout.write(`${report(run)}\n`);

/** A case that states a grade the product does not give, to prove the harness can fail. */
const wrongCase: EvalCase = {
  kind: "grade",
  id: "states-the-wrong-grade",
  category: "live",
  checks: "A case written wrong on purpose.",
  input: { kind: "chart", saves: [] },
  caller: null,
  expected: {
    fields: [{ field: "full_name", grade: "green", reasons: [] }],
    issues: [],
    ready: true,
  },
};

/** A hand-built run, so the report is tested on its own and not on the day's results. */
const sample: EvalRun = {
  results: [
    {
      id: "a",
      checks: "A case that passes.",
      category: "live",
      expected: "x",
      actual: "x",
      pass: true,
    },
    {
      id: "b",
      checks: "A case with a | pipe in the text.",
      category: "recording",
      expected: "y",
      actual: "z",
      pass: false,
    },
    {
      id: "c",
      checks: "Another case that passes.",
      category: "medication",
      expected: "q",
      actual: "q",
      pass: true,
    },
  ],
  totals: { cases: 3, passed: 2 },
  byCategory: [
    { category: "live", cases: 1, passed: 1 },
    { category: "recording", cases: 1, passed: 0 },
    { category: "medication", cases: 1, passed: 1 },
  ],
};

describe("the evaluation harness", () => {
  it("grades every scripted case exactly as the case expects", () => {
    const failed = run.results.filter((result) => !result.pass).map((result) => result.id);
    expect(failed, `\n${report(run)}\n`).toEqual([]);
  });

  it("runs every case once, under an id of its own", () => {
    expect(run.totals.cases).toBe(EVAL_CASES.length);
    expect(new Set(EVAL_CASES.map((item) => item.id)).size).toBe(EVAL_CASES.length);
  });

  it("puts every case in a category, and leaves no category empty", () => {
    const counted = run.byCategory.reduce((total, entry) => total + entry.cases, 0);
    expect(counted).toBe(run.totals.cases);
    expect(run.byCategory.map((entry) => entry.category)).toEqual([...CATEGORIES]);
    expect(run.byCategory.every((entry) => entry.cases > 0)).toBe(true);
  });

  it("runs only the cases it is handed", () => {
    expect(runEvals(EVAL_CASES.slice(0, 1)).totals).toEqual({ cases: 1, passed: 1 });
    expect(runEvals([]).results).toEqual([]);
  });

  it("fails a case whose stated grade is not the grade the product gives", () => {
    const result = runCase(wrongCase);
    expect(result.pass).toBe(false);
    expect(result.expected).toBe("full_name=green; ready=true");
    expect(result.actual).toBe("full_name=red (Not captured.); ready=false");
  });

  it("reports both the live reason and the recording reason when a field earns both", () => {
    const both = run.results.find((result) => result.id === "caller-said-no-to-the-readback");
    expect(both?.actual).toContain("Heard but not confirmed by the caller.");
    expect(both?.actual).toContain("The recording suggests a different value.");
  });
});

describe("the Markdown report", () => {
  it("writes one row per case under a header and a divider", () => {
    const lines = resultsTable(run).split("\n");
    expect(lines[0]).toBe("| Case | What it checks | Expected | Actual | Result |");
    expect(lines[1]).toBe("| --- | --- | --- | --- | --- |");
    expect(lines).toHaveLength(run.results.length + 2);
    expect(lines.every((line) => line.startsWith("| ") && line.endsWith(" |"))).toBe(true);
  });

  it("spells out pass and fail, and escapes a pipe so the table still parses", () => {
    const lines = resultsTable(sample).split("\n");
    expect(lines[2]).toBe("| a | A case that passes. | x | x | pass |");
    expect(lines[3]).toBe("| b | A case with a \\| pipe in the text. | y | z | fail |");
  });

  it("counts the cases and the passes of each category", () => {
    expect(categoryTable(sample).split("\n")).toEqual([
      "| Category | Cases | Passed |",
      "| --- | --- | --- |",
      "| live | 1 | 1 |",
      "| recording | 1 | 0 |",
      "| medication | 1 | 1 |",
    ]);
  });

  it("states the pass rate as a whole percentage", () => {
    expect(summaryLine(sample)).toBe("2 of 3 cases pass, 67% pass rate.");
  });

  it("says nothing passed rather than dividing by no cases", () => {
    expect(summaryLine(runEvals([]))).toBe("0 of 0 cases pass, 0% pass rate.");
  });

  it("joins both tables and the summary into one report", () => {
    const text = report(sample);
    expect(text).toContain(resultsTable(sample));
    expect(text).toContain(categoryTable(sample));
    expect(text.endsWith(summaryLine(sample))).toBe(true);
  });
});
