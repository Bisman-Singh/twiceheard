import { z } from "zod";
import {
  chooseMatch,
  drugWords,
  type Candidate,
  type MedicationMatch,
} from "@/lib/medication/match";

/**
 * Medication lookup against RxNorm, the US National Library of Medicine's
 * public drug vocabulary. No key, read-only, one request per name.
 *
 * The client only gathers candidates; `chooseMatch` decides, so the rule that
 * a lookup may correct spelling but never swap a drug lives in one place. A
 * failed or slow lookup is not an error for the caller: the name is kept as
 * they said it.
 */

export const RXNORM_BASE_URL = "https://rxnav.nlm.nih.gov/REST";
const TIMEOUT_MS = 5_000;
const MAX_CANDIDATES = 8;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const responseSchema = z.object({
  approximateGroup: z
    .object({
      candidate: z
        .array(
          z.object({
            rxcui: z.string(),
            name: z.string().optional(),
            source: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export interface MedicationLookup {
  lookup(spoken: string): Promise<MedicationMatch>;
}

export function createRxNormLookup(fetchImpl: FetchLike = fetch): MedicationLookup {
  return {
    async lookup(spoken) {
      const term = drugWords(spoken);
      if (term.length < 3) return { kind: "none", name: spoken.trim() };
      try {
        const query = new URLSearchParams({ term, maxEntries: String(MAX_CANDIDATES) });
        const response = await fetchImpl(`${RXNORM_BASE_URL}/approximateTerm.json?${query}`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return { kind: "none", name: spoken.trim() };
        const parsed = responseSchema.safeParse(await response.json());
        const raw = parsed.success ? (parsed.data.approximateGroup?.candidate ?? []) : [];
        const candidates: Candidate[] = raw
          .filter((item) => item.source === "RXNORM" && item.name)
          .map((item) => ({ rxcui: item.rxcui, name: item.name as string }));
        return chooseMatch(spoken, candidates);
      } catch {
        return { kind: "none", name: spoken.trim() };
      }
    },
  };
}
