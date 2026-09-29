import "server-only";
import { z } from "zod";
import type { HeardWord, Utterance } from "@/lib/verify/hearing";

/**
 * The second hearing's transcription: the call recording, transcribed again
 * on its own with Universal-3.5 Pro, caller and agent on separate channels,
 * every word scored.
 *
 * The recording is passed by its link, so the audio goes from AssemblyAI's
 * session store to AssemblyAI's transcriber and never passes through
 * Twiceheard. When the words have been read, the transcript is deleted: the
 * chart keeps a verdict and a confidence per field, not the words.
 */

export const TRANSCRIPT_BASE_URL = "https://api.assemblyai.com/v2";
/** Recording channel 1 is the caller, 2 the agent. */
const CALLER_CHANNEL = "1";
const AGENT_CHANNEL = "2";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Heard {
  caller: Utterance[];
  agent: Utterance[];
}

export interface SecondHearingClient {
  transcribe(audioUrl: string, keyterms: readonly string[]): Promise<Heard>;
}

export class SecondHearingError extends Error {
  constructor(readonly reason: "rejected" | "failed" | "timed_out") {
    super(`second hearing ${reason}`);
    this.name = "SecondHearingError";
  }
}

const wordSchema = z.object({
  text: z.string(),
  confidence: z.number(),
  start: z.number(),
  end: z.number(),
});
const transcriptSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "processing", "completed", "error"]),
  utterances: z
    .array(
      z.object({
        channel: z.union([z.string(), z.number()]).nullable().optional(),
        words: z.array(wordSchema),
      }),
    )
    .nullable()
    .optional(),
});

export interface HearingOptions {
  pollMs: number;
  deadlineMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULTS: HearingOptions = {
  pollMs: 3_000,
  deadlineMs: 240_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

export function createSecondHearingClient(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  options: Partial<HearingOptions> = {},
): SecondHearingClient {
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not set");
  const settings = { ...DEFAULTS, ...options };
  const request = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${TRANSCRIPT_BASE_URL}${path}`, {
      ...init,
      headers: { Authorization: apiKey, "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
    });

  async function read(path: string, init?: RequestInit) {
    const response = await request(path, init);
    if (!response.ok) throw new SecondHearingError(response.status < 500 ? "rejected" : "failed");
    return transcriptSchema.parse(await response.json());
  }

  async function waitFor(transcript: z.infer<typeof transcriptSchema>) {
    const started = settings.now();
    let current = transcript;
    while (current.status === "queued" || current.status === "processing") {
      if (settings.now() - started > settings.deadlineMs) throw new SecondHearingError("timed_out");
      await settings.sleep(settings.pollMs);
      current = await read(`/transcript/${encodeURIComponent(current.id)}`);
    }
    return current;
  }

  return {
    async transcribe(audioUrl, keyterms) {
      const body = {
        audio_url: audioUrl,
        speech_models: ["universal-3-5-pro", "universal-2"],
        multichannel: true,
        keyterms_prompt: keyterms.slice(0, 100),
      };
      const submitted = await read("/transcript", { method: "POST", body: JSON.stringify(body) });
      try {
        const done = await waitFor(submitted);
        if (done.status === "error") throw new SecondHearingError("failed");
        return split(done.utterances ?? []);
      } finally {
        // On every path once the job exists, including a timeout: the words do not stay with the provider.
        const path = `/transcript/${encodeURIComponent(submitted.id)}`;
        await request(path, { method: "DELETE" }).catch(() => null);
      }
    },
  };
}

function split(
  utterances: ReadonlyArray<{ channel?: string | number | null; words: HeardWord[] }>,
): Heard {
  const onChannel = (channel: string) =>
    utterances
      .filter((utterance) => String(utterance.channel) === channel)
      .map((utterance) => utterance.words);
  return { caller: onChannel(CALLER_CHANNEL), agent: onChannel(AGENT_CHANNEL) };
}
