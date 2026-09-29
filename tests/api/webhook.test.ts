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

describe("POST /api/webhooks/assemblyai", () => {
  it("acknowledges a signed completion at once, then processes the call into a graded record", async () => {
    const session: SessionDetail = {
      id: "sess_fixture",
      agent_id: "agent-sunrise",
      status: "completed",
      artifacts: [{ type: "timeline", url: "https://recordings.example/t.json" }],
    };
    const deps = testDeps();
    vi.mocked(deps.voice.getSession).mockResolvedValue(session);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(timeline)),
    );
    setServerDeps(deps);

    const response = await POST(signed(completed("evt_1")));
    expect(await response.json()).toEqual({ received: true });
    expect(await deps.calls.get("sess_fixture")).toBeNull();
    expect(queued).toHaveLength(1);
    await queued[0]?.();
    const record = await deps.calls.get("sess_fixture");
    expect(record?.chart.full_name.status).toBe("confirmed");
    expect(record?.hearing).toBe("unavailable");
  });

  it("does the work once however many times a delivery is retried", async () => {
    setServerDeps(testDeps());
    await POST(signed(completed("evt_2")));
    const retry = await POST(signed(completed("evt_2")));
    expect(await retry.json()).toEqual({ received: true, duplicate: true });
    expect(queued).toHaveLength(1);
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
