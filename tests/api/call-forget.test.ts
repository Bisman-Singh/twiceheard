import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as claim } from "@/app/api/call/claim/route";
import { POST as forget } from "@/app/api/call/forget/route";
import { CALL_GRANT_COOKIE, CALL_GRANT_TTL_MS, issueCallGrant } from "@/lib/security/call-grant";
import { setServerDeps, type ServerDeps } from "@/lib/server/deps";
import { callRecord } from "@/tests/fixtures/record";
import { NOW, SECRET, sameOriginPost, testDeps } from "@/tests/api/helpers";

const SESSION = "sess_fixture";
const PATIENT = "Arjun Mehta";

/** A grant as one browser holds it; a later moment is a different browser. */
const cookie = (clinicId = "sunrise-family", issuedAt: Date = NOW) => ({
  cookie: `${CALL_GRANT_COOKIE}=${issueCallGrant(clinicId, SECRET, issuedAt)}`,
});

const OTHER_BROWSER = cookie("sunrise-family", new Date(NOW.getTime() + 1000));
const EXPIRED = cookie("sunrise-family", new Date(NOW.getTime() - CALL_GRANT_TTL_MS - 1));

const post = (
  route: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = cookie(),
) => route(sameOriginPost(path, body, headers));

const askForget = (
  body: unknown = { sessionId: SESSION },
  headers: Record<string, string> = cookie(),
) => post(forget, "/api/call/forget", body, headers);

/** A finished call already in the store, as the caller's page would have just shown it. */
async function callAlreadyTaken(clinicId = "sunrise-family", overrides: Partial<ServerDeps> = {}) {
  const deps = testDeps(overrides);
  setServerDeps(deps);
  await deps.calls.save(
    callRecord({ full_name: { value: PATIENT, status: "confirmed" } }, {}, { clinicId }),
  );
  return deps;
}

afterEach(() => {
  setServerDeps(null);
  vi.restoreAllMocks();
});

describe("POST /api/call/forget", () => {
  it("erases the caller's own call from the caller's page and from the clinic's desk alike", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await callAlreadyTaken();
    await post(claim, "/api/call/claim", { sessionId: SESSION });

    const response = await askForget();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(await deps.calls.get(SESSION)).toBeNull();
    expect(await deps.calls.list("sunrise-family", 10)).toEqual([]);
  });

  it("writes down the clinic and that a record went, and nothing else about it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await callAlreadyTaken();
    await post(claim, "/api/call/claim", { sessionId: SESSION });
    await askForget();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("call record deleted", { clinicId: "sunrise-family" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PATIENT);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SESSION);
  });

  it("will not let one browser erase a call another browser made", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await callAlreadyTaken();
    await post(claim, "/api/call/claim", { sessionId: SESSION });

    const refused = await askForget({ sessionId: SESSION }, OTHER_BROWSER);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "not_yours" });
    expect(await deps.calls.get(SESSION)).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("will not let a caller erase a record that belongs to another clinic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await callAlreadyTaken("another-clinic");
    await post(claim, "/api/call/claim", { sessionId: SESSION });

    // The answer says nothing about a record this caller was never entitled to see.
    const response = await askForget();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(await deps.calls.get(SESSION)).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers a second ask the same way as the first, so a retry after a dropped reply is safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await callAlreadyTaken();
    await post(claim, "/api/call/claim", { sessionId: SESSION });

    expect((await askForget()).status).toBe(200);
    const again = await askForget();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "deleted" });
    // A call that was never recorded in the first place answers the same way.
    expect((await askForget({ sessionId: "sess_never_happened" })).status).toBe(200);
    expect(await deps.calls.get(SESSION)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses another site, a caller with no grant, an expired grant and a malformed body", async () => {
    const deps = await callAlreadyTaken();
    await post(claim, "/api/call/claim", { sessionId: SESSION });

    const crossSite = await askForget(
      { sessionId: SESSION },
      { ...cookie(), "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: "forbidden_origin" });

    const noGrant = await askForget({ sessionId: SESSION }, {});
    expect(noGrant.status).toBe(401);
    expect(await noGrant.json()).toMatchObject({ error: "no_call_in_progress" });

    const expired = await askForget({ sessionId: SESSION }, EXPIRED);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: "no_call_in_progress" });

    expect((await askForget({ sessionId: SESSION, extra: 1 })).status).toBe(400);
    expect(await deps.calls.get(SESSION)).not.toBeNull();
  });
});
