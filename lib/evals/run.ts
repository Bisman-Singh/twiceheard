import { emptyChart, saveField, type Chart } from "@/lib/intake/chart";
import type { FieldId } from "@/lib/intake/fields";
import { gradeChart, type FieldGrade } from "@/lib/intake/grade";
import { chooseMatch, type MedicationMatch } from "@/lib/medication/match";
import { verifyChart } from "@/lib/postcall/process";
import { replayChart, type ReplayIssue } from "@/lib/postcall/replay";
import {
  CATEGORIES,
  EVAL_CASES,
  EVAL_CONTEXT,
  type Category,
  type ChartInput,
  type EvalCase,
  type ExpectedField,
  type GradeCase,
  type MatchCase,
  type TimelineInput,
} from "@/lib/evals/cases";

/**
 * Running the scripted cases through the product's own grading code.
 *
 * Nothing is reimplemented here. A case is fed to the same reducer, replay,
 * second hearing and grader a real call goes through, and both sides are
 * rendered to one line so the comparison is exact and the difference is
 * readable. Pure: no files, no clock, no network, so two runs of the same
 * cases always give the same answer.
 */

export interface CaseResult {
  id: string;
  checks: string;
  category: Category;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface Totals {
  cases: number;
  passed: number;
}

export interface CategoryTotals extends Totals {
  category: Category;
}

export interface EvalRun {
  results: CaseResult[];
  totals: Totals;
  byCategory: CategoryTotals[];
}

function describeFieldGrade(field: FieldGrade): string {
  const reasons = field.reasons.join(" ");
  return reasons.length === 0
    ? `${field.id}=${field.grade}`
    : `${field.id}=${field.grade} (${reasons})`;
}

function describeIssue(issue: ReplayIssue): string {
  switch (issue.issue) {
    case "readback_not_spoken":
      return `${issue.field}: readback not spoken`;
    case "no_answer_after_readback":
      return `${issue.field}: no answer to the readback`;
    case "readback_interrupted":
      return `${issue.field}: readback interrupted`;
    case "one_yes_two_values":
      return `${issue.field}: one yes shared with ${issue.alsoAnswered}`;
    case "caller_did_not_agree":
      return `${issue.field}: caller said "${issue.callerSaid}"`;
  }
}

function describeOutcome(
  fields: readonly FieldGrade[],
  issues: readonly ReplayIssue[],
  ready: boolean,
): string {
  const parts = [...fields.map(describeFieldGrade), ...issues.map(describeIssue)];
  return [...parts, `ready=${String(ready)}`].join("; ");
}

function describeMatch(match: MedicationMatch): string {
  if (match.kind === "exact") return `exact: ${match.name} (${match.rxcui})`;
  if (match.kind === "suggestion") {
    return `suggestion: ${match.name} (${match.rxcui}) for "${match.heard}"`;
  }
  return `none: kept as "${match.name}"`;
}

function asFieldGrade(field: ExpectedField): FieldGrade {
  return { id: field.field, grade: field.grade, reasons: [...field.reasons] };
}

function buildChart(input: ChartInput | TimelineInput): {
  chart: Chart;
  issues: readonly ReplayIssue[];
} {
  if (input.kind === "timeline") {
    const replay = replayChart(input.events, { country: EVAL_CONTEXT.country });
    return { chart: replay.chart, issues: replay.issues };
  }
  let chart = emptyChart();
  for (const save of input.saves) chart = saveField(chart, save, EVAL_CONTEXT).chart;
  return { chart, issues: [] };
}

function runGradeCase(item: GradeCase): { expected: string; actual: string } {
  const { chart, issues } = buildChart(item.input);
  const verifications = item.caller === null ? {} : verifyChart(chart, item.caller);
  const graded = gradeChart(chart, verifications);
  const byField = Object.fromEntries(graded.fields.map((field) => [field.id, field])) as Record<
    FieldId,
    FieldGrade
  >;
  return {
    expected: describeOutcome(
      item.expected.fields.map(asFieldGrade),
      item.expected.issues,
      item.expected.ready,
    ),
    actual: describeOutcome(
      item.expected.fields.map((field) => byField[field.field]),
      issues,
      graded.ready,
    ),
  };
}

function runMatchCase(item: MatchCase): { expected: string; actual: string } {
  return {
    expected: describeMatch(item.expected),
    actual: describeMatch(chooseMatch(item.spoken, item.candidates)),
  };
}

export function runCase(item: EvalCase): CaseResult {
  const outcome = item.kind === "grade" ? runGradeCase(item) : runMatchCase(item);
  return {
    id: item.id,
    checks: item.checks,
    category: item.category,
    expected: outcome.expected,
    actual: outcome.actual,
    pass: outcome.expected === outcome.actual,
  };
}

export function runEvals(cases: readonly EvalCase[] = EVAL_CASES): EvalRun {
  const results = cases.map(runCase);
  const byCategory = CATEGORIES.map((category): CategoryTotals => {
    const inCategory = results.filter((result) => result.category === category);
    return {
      category,
      cases: inCategory.length,
      passed: inCategory.filter((result) => result.pass).length,
    };
  });
  return {
    results,
    totals: { cases: results.length, passed: results.filter((result) => result.pass).length },
    byCategory,
  };
}
