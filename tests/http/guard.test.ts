import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HttpError,
  assertContentLength,
  assertSameOrigin,
  clientAddress,
  jsonError,
  readCapped,
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
    // Only the kind is logged. An error from a store can carry the command it failed on,
    // and that command holds the caller's chart.
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret detail");
    expect(JSON.stringify(spy.mock.calls)).toContain("Error");

    const thrownString = jsonError("not an error at all");
    expect(thrownString.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).toContain("unknown");
    spy.mockRestore();
  });
});

describe("readCapped", () => {
  it("counts the bytes it reads, so a body with no declared length cannot walk past the cap", async () => {
    const big = "x".repeat(2000);
    const chunked = new Request("https://app.example/api/x", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      // A stream carries no content-length, which is exactly the case the cap has to survive.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readCapped(chunked, 100)).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("reads a small body whole, and treats a request with no body as empty", async () => {
    const small = new Request("https://app.example/api/x", { method: "POST", body: "hello" });
    expect(await readCapped(small, 100)).toBe("hello");
    expect(await readCapped(new Request("https://app.example/api/x"), 100)).toBe("");
  });

  it("still refuses an oversized body when the stream refuses to be cancelled", async () => {
    const body = new ReadableStream({
      start(controller) {
        // Left open, so the cap is hit while the stream is still live and cancel really runs.
        controller.enqueue(new TextEncoder().encode("x".repeat(2000)));
      },
      cancel: () => Promise.reject(new Error("cannot cancel")),
    });
    const request = new Request("https://app.example/api/x", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readCapped(request, 100)).rejects.toMatchObject({ code: "payload_too_large" });
  });
});
