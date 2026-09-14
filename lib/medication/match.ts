/**
 * Deciding whether a drug database match is the medication the caller named.
 *
 * Approximate search is dangerous on a phone line. Tested against the public
 * RxNorm API, an Indian brand of metformin came back as "glycogen" and a
 * common Indian paracetamol brand as an unrelated compound, both ranked
 * first. So a close match is never applied silently. It becomes a question
 * for the caller ("is that metformin?"), and only their yes changes what is
 * recorded. A match is close only within one edit per four letters after
 * the first, at most two; anything further is a different drug, and the
 * caller's own word is kept and flagged for the clinician.
 */

export interface Candidate {
  name: string;
  rxcui: string;
}

export type MedicationMatch =
  | { kind: "exact"; name: string; rxcui: string }
  | { kind: "suggestion"; name: string; rxcui: string; heard: string }
  | { kind: "none"; name: string };

/** "glycomet" (8 letters) may differ by one edit, "metphormin" (10) by two, nothing by more. */
export function allowedEdits(word: string): number {
  return Math.min(2, Math.max(0, Math.floor((word.length - 1) / 4)));
}

/** "Telmisartan 40 mg twice daily" is looked up as "telmisartan". */
export function drugWords(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|µg|g|ml|iu|units?)?\b/g, " ")
    .replace(
      /\b(tablets?|tabs?|capsules?|caps?|syrup|drops|once|twice|thrice|daily|a day|at night|in the morning|od|bd|tds)\b/g,
      " ",
    )
    .replace(/[^\p{L}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

export function chooseMatch(spoken: string, candidates: readonly Candidate[]): MedicationMatch {
  const heard = drugWords(spoken);
  if (heard.length === 0) return { kind: "none", name: spoken.trim() };
  let best: { candidate: Candidate; edits: number } | null = null;
  for (const candidate of candidates) {
    const edits = editDistance(heard, drugWords(candidate.name));
    if (!best || edits < best.edits) best = { candidate, edits };
  }
  if (!best) return { kind: "none", name: spoken.trim() };
  const name = drugWords(best.candidate.name);
  if (best.edits === 0) return { kind: "exact", name, rxcui: best.candidate.rxcui };
  return best.edits <= allowedEdits(heard)
    ? { kind: "suggestion", name, rxcui: best.candidate.rxcui, heard }
    : { kind: "none", name: spoken.trim() };
}
