import type { CaseResult, EvalRun } from "@/lib/evals/run";

/**
 * The run, written out for a person to read.
 *
 * Plain Markdown, no colour and no symbols: the table is read in a terminal,
 * in a pull request and in a printout, and it has to mean the same thing in
 * all three. Pass or fail is a word, not a mark.
 */

const RESULT_HEADER = ["Case", "What it checks", "Expected", "Actual", "Result"];
const CATEGORY_HEADER = ["Category", "Cases", "Passed"];

/** A pipe inside a value would end the cell, so it is escaped rather than dropped. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function row(values: readonly string[]): string {
  return `| ${values.map(cell).join(" | ")} |`;
}

function table(header: readonly string[], rows: readonly string[][]): string {
  return [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");
}

function resultRow(result: CaseResult): string[] {
  return [result.id, result.checks, result.expected, result.actual, result.pass ? "pass" : "fail"];
}

export function resultsTable(run: EvalRun): string {
  return table(RESULT_HEADER, run.results.map(resultRow));
}

export function categoryTable(run: EvalRun): string {
  const rows = run.byCategory.map((total) => [
    total.category,
    String(total.cases),
    String(total.passed),
  ]);
  return table(CATEGORY_HEADER, rows);
}

export function summaryLine(run: EvalRun): string {
  const { cases, passed } = run.totals;
  const rate = cases === 0 ? 0 : Math.round((passed / cases) * 100);
  return `${passed} of ${cases} cases pass, ${rate}% pass rate.`;
}

export function report(run: EvalRun): string {
  return [resultsTable(run), "", categoryTable(run), "", summaryLine(run)].join("\n");
}
