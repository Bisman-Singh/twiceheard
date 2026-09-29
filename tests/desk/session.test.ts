import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "@/lib/http/rate-limit";
import { DESK_COOKIE, deskCode, issueDeskSession } from "@/lib/security/desk-session";
import { setServerDeps } from "@/lib/server/deps";
import { NOW, SECRET, testDeps } from "@/tests/api/helpers";

const jar = vi.hoisted(() => ({
  store: new Map<string, string>(),
  get: vi.fn((name: string) => {
    const value = jar.store.get(name);
    return value === undefined ? undefined : { name, value };
  }),
  set: vi.fn((name: string, value: string) => jar.store.set(name, value)),
  delete: vi.fn((name: string) => jar.store.delete(name)),
}));
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => requestHeaders.current,
}));

const { signIn, signOut, signedInClinic } = await import("@/lib/desk/session");

afterEach(() => {
  jar.store.clear();
  vi.clearAllMocks();
  setServerDeps(null);
  requestHeaders.current = new Headers();
});

describe("who the desk is signed in as", () => {
  it("is nobody until a code is typed, and the clinic afterwards", async () => {
    setServerDeps(testDeps());
    expect(await signedInClinic()).toBeNull();

    expect(await signIn(deskCode("sunrise-family", SECRET))).toBe("ok");
    expect(jar.set).toHaveBeenCalledWith(
      DESK_COOKIE,
      expect.stringContaining("sunrise-family."),
      expect.objectContaining({ httpOnly: true, sameSite: "strict", path: "/" }),
    );
    expect((await signedInClinic())?.id).toBe("sunrise-family");

    await signOut();
    expect(await signedInClinic()).toBeNull();
  });

  it("keeps the cookie off http only in development, where localhost has no https", async () => {
    setServerDeps(testDeps());
    await signIn(deskCode("sunrise-family", SECRET));
    expect(jar.set).toHaveBeenCalledWith(DESK_COOKIE, expect.any(String), {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    vi.stubEnv("NODE_ENV", "production");
    await signIn(deskCode("sunrise-family", SECRET));
    expect(jar.set).toHaveBeenLastCalledWith(
      DESK_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true }),
    );
    vi.unstubAllEnvs();
  });

  it("refuses a wrong code and stops a run of guesses", async () => {
    setServerDeps(testDeps({ deskSignIns: new RateLimiter(2, 600_000, () => NOW.getTime()) }));
    expect(await signIn("AAAAAAAAAA")).toBe("wrong_code");
    expect(await signIn("AAAAAAAAAA")).toBe("wrong_code");
    // The right code is refused too once the limit is reached, which is the point of the limit.
    expect(await signIn(deskCode("sunrise-family", SECRET))).toBe("too_many");
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("counts guesses per caller, not for everyone at once", async () => {
    setServerDeps(testDeps({ deskSignIns: new RateLimiter(1, 600_000, () => NOW.getTime()) }));
    requestHeaders.current = new Headers({ "x-real-ip": "203.0.113.5" });
    expect(await signIn("AAAAAAAAAA")).toBe("wrong_code");
    expect(await signIn("AAAAAAAAAA")).toBe("too_many");
    requestHeaders.current = new Headers({ "x-real-ip": "198.51.100.9" });
    expect(await signIn(deskCode("sunrise-family", SECRET))).toBe("ok");
  });

  it("ignores a session for a clinic this deployment no longer serves", async () => {
    setServerDeps(testDeps());
    jar.store.set(DESK_COOKIE, issueDeskSession("harbour-road", SECRET, NOW));
    expect(await signedInClinic()).toBeNull();
  });
});
