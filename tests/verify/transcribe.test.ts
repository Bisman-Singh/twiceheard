import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  SecondHearingError,
  TRANSCRIPT_BASE_URL,
  createSecondHearingClient,
  type FetchLike,
} from "@/lib/verify/transcribe";

const KEY = "raw-key-not-real";
const fixture = JSON.parse(readFileSync("tests/fixtures/second-hearing.json", "utf8")) as {
  utterances: Array<{ channel: string; words: unknown[] }>;
};

function scripted(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn<FetchLike>(async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "DELETE") return new Response(null, { status: 200 });
    const [status, body] = responses.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  });
  return { impl, calls };
}

const fast = { pollMs: 1, sleep: async () => undefined };

describe("createSecondHearingClient", () => {
  it("refuses to start without a key", () => {
    expect(() => createSecondHearingClient("")).toThrow(/ASSEMBLYAI_API_KEY/);
  });

  it("submits the recording link, waits for the words, splits the channels and deletes the transcript", async () => {
    const { impl, calls } = scripted([
      [200, { id: "t1", status: "queued" }],
      [200, { id: "t1", status: "processing" }],
      [200, { id: "t1", status: "completed", utterances: fixture.utterances }],
    ]);
    const heard = await createSecondHearingClient(KEY, impl, fast).transcribe(
      "https://cdn.assemblyai.com/a.ogg",
      ["Arjun Mehta", ...Array.from({ length: 150 }, (_, i) => `term ${i}`)],
    );
    expect(heard.caller).toHaveLength(5);
    expect(heard.agent).toHaveLength(6);
    const submitted = JSON.parse(String(calls[0]?.init.body));
    expect(calls[0]?.url).toBe(`${TRANSCRIPT_BASE_URL}/transcript`);
    expect(submitted).toMatchObject({
      audio_url: "https://cdn.assemblyai.com/a.ogg",
      speech_models: ["universal-3-5-pro", "universal-2"],
      multichannel: true,
    });
    expect(submitted.keyterms_prompt).toHaveLength(100);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(KEY);
    expect(calls.at(-1)).toMatchObject({
      url: `${TRANSCRIPT_BASE_URL}/transcript/t1`,
      init: { method: "DELETE" },
    });
  });

  it("waits between polls with a real timer by default", async () => {
    const { impl } = scripted([
      [200, { id: "t6", status: "processing" }],
      [200, { id: "t6", status: "completed", utterances: [] }],
    ]);
    const heard = await createSecondHearingClient(KEY, impl, { pollMs: 1 }).transcribe("u", []);
    expect(heard).toEqual({ caller: [], agent: [] });
  });

  it("treats missing utterances as silence", async () => {
    const { impl } = scripted([[200, { id: "t2", status: "completed", utterances: null }]]);
    expect(
      await createSecondHearingClient(KEY, impl, fast).transcribe("https://x.example/a", []),
    ).toEqual({
      caller: [],
      agent: [],
    });
  });

  it("reports a rejected request, a failed job and a job that outlives the deadline, deleting what it can", async () => {
    const rejected = scripted([[400, { error: "bad audio_url" }]]);
    await expect(
      createSecondHearingClient(KEY, rejected.impl, fast).transcribe("u", []),
    ).rejects.toMatchObject({
      reason: "rejected",
    });

    const outage = scripted([[503, {}]]);
    await expect(
      createSecondHearingClient(KEY, outage.impl, fast).transcribe("u", []),
    ).rejects.toMatchObject({
      reason: "failed",
    });

    const failed = scripted([[200, { id: "t3", status: "error" }]]);
    const error = await createSecondHearingClient(KEY, failed.impl, fast)
      .transcribe("u", [])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecondHearingError);
    expect((error as SecondHearingError).reason).toBe("failed");
    expect(failed.calls.at(-1)?.init.method).toBe("DELETE");

    let clock = 0;
    const slow = scripted(
      Array.from({ length: 10 }, () => [200, { id: "t4", status: "processing" }]),
    );
    const client = createSecondHearingClient(KEY, slow.impl, {
      ...fast,
      deadlineMs: 5,
      now: () => (clock += 3),
    });
    await expect(client.transcribe("u", [])).rejects.toMatchObject({ reason: "timed_out" });
    expect(slow.calls.at(-1)).toMatchObject({
      url: `${TRANSCRIPT_BASE_URL}/transcript/t4`,
      init: { method: "DELETE" },
    });
  });

  it("does not fail the hearing when deleting the transcript fails", async () => {
    const impl = vi.fn<FetchLike>(async (_url, init = {}) =>
      init.method === "DELETE"
        ? Promise.reject(new Error("network"))
        : new Response(JSON.stringify({ id: "t5", status: "completed", utterances: [] })),
    );
    await expect(createSecondHearingClient(KEY, impl, fast).transcribe("u", [])).resolves.toEqual({
      caller: [],
      agent: [],
    });
  });
});
