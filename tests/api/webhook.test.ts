import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type { SessionDetail } from "@/lib/voice-agent/client";

const queued: Array<() => Promise<unknown> | unknown> = [];
vi.mock("next/server", async (original) => ({
  ...(await original<typeof NextServer>()),
  after: (task: () => unknown) => queued.push(task),
}));

const { POST } = await import("@/app/api/webhooks/assemblyai/route");
const { setServerDeps } = await import("@/lib/server/deps");
const { WEBHOOK_SECRET, testDeps } = await import("@/tests/api/helpers");

const timeline = readFileSync("tests/fixtures/timeline.json", "utf8");

beforeEach(() => {
  queued.length = 0;
});

afterEach(() => {
  setServerDeps(null);
  vi.unstubAllGlobals();
});

function signed(body: string, secret = WEBHOOK_SECRET, extra: Record<string, string> = {}) {
  return new Request("https://twiceheard.example/api/webhooks/assemblyai", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aai-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      ...extra,
    },
    body,
  });
}

const completed = (eventId: string, sessionId = "sess_fixture") =>
  JSON.stringify({
    event_id: eventId,
    event: "session.completed",
    session: { session_id: sessionId },
  });

/** A finished session the platform will hand over, with its timeline ready to fetch. */
function readySession() {
  const session: SessionDetail = {
    id: "sess_fixture",
    agent_id: "agent-sunrise",
    status: "completed",
    artifacts: [{ type: "timeline", url: "https://cdn.assemblyai.com/t.json" }],
  };
  const deps = testDeps();
  vi.mocked(deps.voice.getSession).mockResolvedValue(session);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(timeline)),
  );
  setServerDeps(deps);
  return deps;
}

describe("POST /api/webhooks/assemblyai", () => {
  it("acknowledges a signed completion at once, then processes the call into a graded record", async () => {
    const deps = readySession();

    const response = await POST(signed(completed("evt_1")));
    expect(await response.json()).toEqual({ received: true });
    expect(await deps.calls.get("sess_fixture")).toBeNull();
    expect(queued).toHaveLength(1);
    await queued[0]?.();
    const record = await deps.calls.get("sess_fixture");
    expect(record?.chart.full_name.status).toBe("confirmed");
    expect(record?.hearing).toBe("unavailable");
  });

  it("does the work once when a delivery is retried after it succeeded", async () => {
    const deps = readySession();
    await POST(signed(completed("evt_2")));
    await queued[0]?.();
    expect(await deps.calls.get("sess_fixture")).not.toBeNull();

    const retry = await POST(signed(completed("evt_2")));
    expect(await retry.json()).toEqual({ received: true, duplicate: true });
    await queued[1]?.();
    // The call was already charted, so the retry did not fetch and rebuild it again.
    expect(deps.voice.getSession).toHaveBeenCalledTimes(1);
  });

  it("does the work on a retry when the first delivery failed, so a call is not lost", async () => {
    const deps = readySession();
    vi.mocked(deps.voice.getSession).mockRejectedValueOnce(new Error("platform down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await POST(signed(completed("evt_3")));
    await queued[0]?.();
    expect(await deps.calls.get("sess_fixture")).toBeNull();

    // The platform retries the same delivery. Nothing was charted, so the work runs again.
    await POST(signed(completed("evt_3")));
    await queued[1]?.();
    expect(await deps.calls.get("sess_fixture")).not.toBeNull();
  });

  it("acknowledges events it does not act on", async () => {
    setServerDeps(testDeps());
    const body = JSON.stringify({
      event_id: "evt_3",
      event: "call.connected",
      call: { session_id: null },
    });
    expect((await POST(signed(body))).status).toBe(200);
    expect(queued).toHaveLength(0);
  });

  it("rejects bad signatures, unreadable bodies and oversized deliveries", async () => {
    setServerDeps(testDeps());
    expect((await POST(signed(completed("evt_4"), "x".repeat(40)))).status).toBe(401);
    const unsigned = new Request("https://twiceheard.example/api/webhooks/assemblyai", {
      method: "POST",
      body: completed("evt_5"),
    });
    expect((await POST(unsigned)).status).toBe(401);
    expect((await POST(signed("not json"))).status).toBe(400);
    expect((await POST(signed(JSON.stringify({ event: "session.completed" })))).status).toBe(400);
    expect((await POST(signed("x".repeat(70_000)))).status).toBe(413);
    expect(
      (await POST(signed(completed("evt_6"), WEBHOOK_SECRET, { "content-length": "999999" })))
        .status,
    ).toBe(413);
    expect(queued).toHaveLength(0);
  });
});
