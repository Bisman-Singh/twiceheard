import { describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http/guard";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { ArtifactsNotReady, type PostCallDeps } from "@/lib/postcall/process";
import { memoryCallStore } from "@/lib/postcall/record";
import {
  MAX_ARTIFACT_BYTES,
  RETRY_DELAYS_MS,
  fetchArtifact,
  postCallDeps,
  processWithRetry,
} from "@/lib/postcall/run";
import type { ServerDeps } from "@/lib/server/deps";
import type { SessionDetail } from "@/lib/voice-agent/client";

const session: SessionDetail = {
  id: "sess_1",
  agent_id: null,
  status: "completed",
  artifacts: [],
};

/** Only the parts of the post-call set the retry policy itself reaches. */
function deps(getSession: PostCallDeps["getSession"]): PostCallDeps {
  return {
    getSession,
    clinicForAgent: () => null,
    fetchJson: async () => ({}),
    hearing: { transcribe: vi.fn() },
    calls: memoryCallStore(),
    now: () => new Date("2026-09-14T12:05:00Z"),
  };
}

const jsonResponse = (body: string) => new Response(body, { status: 200 });

describe("processWithRetry", () => {
  it("waits for the platform to attach the artifacts, on its own clock", async () => {
    vi.useFakeTimers();
    const getSession = vi
      .fn<PostCallDeps["getSession"]>()
      .mockRejectedValueOnce(new ArtifactsNotReady())
      .mockResolvedValue(session);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = processWithRetry("sess_1", deps(getSession));
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);

    // The session belongs to no clinic, so the second attempt ends in a clean null.
    expect(await pending).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    vi.useRealTimers();
  });

  it("gives up after the last delay, and says only what kind of failure it was", async () => {
    const getSession = vi.fn(async () => {
      throw new ArtifactsNotReady();
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waited: number[] = [];

    const record = await processWithRetry("sess_1", deps(getSession), async (ms) => {
      waited.push(ms);
    });

    expect(record).toBeNull();
    expect(waited).toEqual([...RETRY_DELAYS_MS]);
    expect(errors).toHaveBeenCalledWith("post-call processing failed", {
      sessionId: "sess_1",
      attempt: RETRY_DELAYS_MS.length + 1,
      kind: "ArtifactsNotReady",
    });
    errors.mockRestore();
  });

  it("does not retry a failure that a wait cannot fix", async () => {
    const getSession = vi.fn(async () => {
      throw "the platform is down";
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await processWithRetry("sess_1", deps(getSession), async () => undefined)).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith("post-call processing failed", {
      sessionId: "sess_1",
      attempt: 1,
      kind: "unknown",
    });
    errors.mockRestore();
  });
});

describe("fetchArtifact", () => {
  it("follows a link to the platform and its session bucket, and nowhere else", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"session_id":"sess_1"}'));
    expect(await fetchArtifact("https://cdn.assemblyai.com/t.json", fetchImpl)).toEqual({
      session_id: "sess_1",
    });
    expect(
      await fetchArtifact("https://aai-sessions.s3.us-west-2.amazonaws.com/t", fetchImpl),
    ).toEqual({ session_id: "sess_1" });
    for (const link of [
      "http://cdn.assemblyai.com/t.json",
      "https://assemblyai.com.example.net/t.json",
    ]) {
      await expect(fetchArtifact(link, fetchImpl)).rejects.toMatchObject({
        status: 502,
        code: "artifact_unavailable",
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses an artifact the platform could not serve, or one too big to be a timeline", async () => {
    const missing = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(
      fetchArtifact("https://cdn.assemblyai.com/t.json", missing),
    ).rejects.toBeInstanceOf(HttpError);
    const huge = vi.fn(async () => jsonResponse("x".repeat(MAX_ARTIFACT_BYTES + 1)));
    await expect(fetchArtifact("https://cdn.assemblyai.com/t.json", huge)).rejects.toMatchObject({
      code: "artifact_too_large",
    });
  });
});

describe("postCallDeps", () => {
  it("draws the post-call set from the server's own", async () => {
    const getSession = vi.fn(async () => session);
    const forAgent = vi.fn(() => DEMO_CLINIC);
    const now = () => new Date("2026-09-14T12:05:00Z");
    const server = {
      voice: { getSession },
      clinics: { forAgent },
      hearing: { transcribe: vi.fn() },
      calls: memoryCallStore(),
      now,
    } as unknown as ServerDeps;
    const fetchImpl = vi.fn(async () => jsonResponse("[1]"));

    const post = postCallDeps(server, fetchImpl);
    expect(await post.getSession("sess_1")).toEqual(session);
    expect(post.clinicForAgent("agent-sunrise")).toEqual(DEMO_CLINIC);
    expect(await post.fetchJson("https://cdn.assemblyai.com/t.json")).toEqual([1]);
    expect(post.now).toBe(now);
    expect(getSession).toHaveBeenCalledWith("sess_1");
    expect(forAgent).toHaveBeenCalledWith("agent-sunrise");
  });
});
