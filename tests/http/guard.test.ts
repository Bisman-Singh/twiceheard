import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HttpError,
  assertContentLength,
  assertSameOrigin,
  clientAddress,
  jsonError,
  readJson,
} from "@/lib/http/guard";

const request = (headers: Record<string, string>, body?: string) =>
  new Request("https://app.example/api/x", { method: "POST", headers, body });

describe("assertSameOrigin", () => {
  it("accepts same-origin and direct navigations", () => {
    expect(() => assertSameOrigin(request({ "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(request({ "sec-fetch-site": "none" }))).not.toThrow();
  });

  it("accepts a matching Origin header when Sec-Fetch-Site is absent", () => {
    expect(() =>
      assertSameOrigin(request({ origin: "https://app.example", host: "app.example" })),
    ).not.toThrow();
  });

  it("rejects cross-site callers and unparsable origins", () => {
    expect(() => assertSameOrigin(request({ "sec-fetch-site": "cross-site" }))).toThrow(HttpError);
    expect(() =>
      assertSameOrigin(request({ origin: "https://evil.example", host: "app.example" })),
    ).toThrow("forbidden_origin");
    expect(() => assertSameOrigin(request({ origin: "not a url", host: "app.example" }))).toThrow(
      HttpError,
    );
    expect(() => assertSameOrigin(request({}))).toThrow(HttpError);
  });
});

describe("assertContentLength and readJson", () => {
  const schema = z.object({ text: z.string().min(1) });

  it("rejects declared and actual oversized bodies", async () => {
    expect(() => assertContentLength(request({ "content-length": "999" }), 10)).toThrow(
      "payload_too_large",
    );
    await expect(
      readJson(request({}, JSON.stringify({ text: "x".repeat(50) })), schema, 10),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects malformed JSON and schema violations with 400", async () => {
    await expect(readJson(request({}, "{oops"), schema, 1000)).rejects.toMatchObject({
      status: 400,
      code: "invalid_json",
    });
    await expect(
      readJson(request({}, JSON.stringify({ text: "" })), schema, 1000),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
    });
  });

  it("returns the validated body", async () => {
    await expect(
      readJson(request({}, JSON.stringify({ text: "ok" })), schema, 1000),
    ).resolves.toEqual({
      text: "ok",
    });
  });
});

describe("clientAddress", () => {
  it("prefers the platform's x-real-ip, then the first forwarded address, then unknown", () => {
    expect(clientAddress(request({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientAddress(request({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientAddress(request({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "9.9.9.9" }))).toBe(
      "3.3.3.3",
    );
    expect(clientAddress(request({ "x-forwarded-for": " " }))).toBe("unknown");
    expect(clientAddress(request({}))).toBe("unknown");
  });
});

describe("jsonError", () => {
  it("serialises HttpError with its status and hides other errors", async () => {
    const known = jsonError(new HttpError(429, "rate_limited", "Slow down."));
    expect(known.status).toBe(429);
    await expect(known.json()).resolves.toEqual({ error: "rate_limited", message: "Slow down." });

    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unknown = jsonError(new Error("secret detail"));
    expect(unknown.status).toBe(500);
    await expect(unknown.json()).resolves.toEqual({
      error: "internal_error",
      message: "Something went wrong.",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
