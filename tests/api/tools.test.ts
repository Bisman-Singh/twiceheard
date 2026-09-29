import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tools/[clinicId]/[tool]/route";
import { toolKeyFor } from "@/lib/security/keys";
import { setServerDeps } from "@/lib/server/deps";
import { TOOL_KEY_HEADER } from "@/lib/voice-agent/tools";
import { SECRET, testDeps } from "@/tests/api/helpers";

afterEach(() => {
  setServerDeps(null);
  vi.restoreAllMocks();
});

const KEY = toolKeyFor("sunrise-family", SECRET);

function call(clinicId: string, tool: string, body: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers[TOOL_KEY_HEADER] = key;
  const request = new Request(`https://twiceheard.example/api/tools/${clinicId}/${tool}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ clinicId, tool }) });
}

describe("POST /api/tools/{clinicId}/{tool}", () => {
  it("runs a call's tools end to end with the clinic's key, logging no patient details", async () => {
    setServerDeps(testDeps());
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = await call("sunrise-family", "start_intake", {});
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const { intake_id: intakeId } = (await started.json()) as { intake_id: string };
    const saved = await call("sunrise-family", "save_field", {
      intake_id: intakeId,
      field: "full_name",
      value: "Arjun Mehta",
      status: "heard",
    });
    expect(await saved.json()).toEqual({
      ok: true,
      say: "I have your name as Arjun Mehta. Is that right?",
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("save_field");
    expect(logged).not.toContain("Arjun");
  });

  it("refuses unknown clinics and tools before checking anything else", async () => {
    setServerDeps(testDeps());
    expect((await call("another-clinic", "start_intake", {})).status).toBe(404);
    expect((await call("sunrise-family", "delete_everything", {})).status).toBe(404);
  });

  it("refuses a missing, wrong or other clinic's key", async () => {
    setServerDeps(testDeps());
    expect((await call("sunrise-family", "start_intake", {}, null)).status).toBe(401);
    expect((await call("sunrise-family", "start_intake", {}, "nope")).status).toBe(401);
    expect(
      (await call("sunrise-family", "start_intake", {}, toolKeyFor("another-clinic", SECRET)))
        .status,
    ).toBe(401);
  });

  it("rejects bodies that are not a small JSON object", async () => {
    setServerDeps(testDeps());
    expect((await call("sunrise-family", "start_intake", "not json")).status).toBe(400);
    expect((await call("sunrise-family", "start_intake", [1, 2])).status).toBe(400);
    expect((await call("sunrise-family", "start_intake", { pad: "x".repeat(20_000) })).status).toBe(
      413,
    );
  });
});
