import { afterEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/desk/session", () => session);

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

const { signInAction, signOutAction } = await import("@/app/desk/actions");

const form = (code: string) => {
  const data = new FormData();
  data.set("code", code);
  return data;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("the desk sign-in action", () => {
  it("opens the desk when the code is right", async () => {
    session.signIn.mockResolvedValue("ok");
    await expect(signInAction("", form("ABCD234XYZ"))).rejects.toThrow("REDIRECT /desk");
  });

  it("says what went wrong without saying which clinic was aimed at", async () => {
    session.signIn.mockResolvedValue("wrong_code");
    expect(await signInAction("", form("AAAAAAAAAA"))).toBe("That code does not match a clinic.");
    session.signIn.mockResolvedValue("too_many");
    expect(await signInAction("", form("AAAAAAAAAA"))).toBe(
      "Too many attempts. Wait a few minutes and try again.",
    );
  });

  it("treats a form with no code as an empty code rather than failing", async () => {
    session.signIn.mockResolvedValue("wrong_code");
    await signInAction("", new FormData());
    expect(session.signIn).toHaveBeenCalledWith("");
  });

  it("signs the desk out and sends it back to the sign-in", async () => {
    await expect(signOutAction()).rejects.toThrow("REDIRECT /desk");
    expect(session.signOut).toHaveBeenCalled();
  });
});
