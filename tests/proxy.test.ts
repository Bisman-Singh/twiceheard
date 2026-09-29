import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCsp, config, proxy } from "@/proxy";
import nextConfig, { securityHeaders } from "@/next.config";

afterEach(() => vi.unstubAllEnvs());

describe("proxy", () => {
  it("sets a nonce-based CSP that allows the voice socket and nothing else outside", () => {
    const response = proxy(new NextRequest("https://twiceheard.example/"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' wss://agents.assemblyai.com;");
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("issues a different nonce per request", () => {
    const first = proxy(new NextRequest("https://twiceheard.example/")).headers.get(
      "Content-Security-Policy",
    );
    const second = proxy(new NextRequest("https://twiceheard.example/")).headers.get(
      "Content-Security-Policy",
    );
    expect(first).not.toBe(second);
  });

  it("relaxes only what development tooling needs", () => {
    expect(buildCsp("abc", true)).toContain("'unsafe-eval'");
    expect(buildCsp("abc", false)).toContain("style-src 'self' 'nonce-abc'");
    vi.stubEnv("NODE_ENV", "development");
    expect(
      proxy(new NextRequest("https://twiceheard.example/")).headers.get("Content-Security-Policy"),
    ).toContain("'unsafe-eval'");
  });

  it("covers every page, including a prefetch, and skips API routes and static assets", () => {
    const pattern = new RegExp(`^${config.matcher[0] ?? ""}$`);
    expect(pattern.test("/")).toBe(true);
    expect(pattern.test("/dashboard")).toBe(true);
    expect(pattern.test("/api/tools/sunrise-family/save_field")).toBe(false);
    expect(pattern.test("/_next/static/chunk.js")).toBe(false);
    // No condition excuses a request from the policy, whatever headers it carries.
    expect(config.matcher.every((entry) => typeof entry === "string")).toBe(true);
  });
});

describe("next.config security headers", () => {
  it("applies the static headers everywhere, no-store to the API, and allows only this site's microphone", async () => {
    expect(await nextConfig.headers?.()).toEqual([
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ]);
    const permissions = securityHeaders.find(
      (header) => header.key === "Permissions-Policy",
    )?.value;
    expect(permissions).toBe("camera=(), microphone=(self), geolocation=(), payment=()");
    expect(securityHeaders.map((header) => header.key)).toContain("Strict-Transport-Security");
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
