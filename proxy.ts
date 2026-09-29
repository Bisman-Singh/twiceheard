import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request Content Security Policy with a fresh nonce.
 *
 * A nonce lets the policy drop `'unsafe-inline'` for scripts entirely: only
 * the scripts Next.js emits for this exact response may run. Pages therefore
 * render dynamically (see `app/layout.tsx`), a cost this small app can afford.
 * The one outside connection allowed is the Voice Agent API's WebSocket.
 * API routes are excluded; they return JSON and set no scripts.
 */

export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob:",
    "font-src 'self'",
    // The browser call button talks to the Voice Agent API directly, and to nothing else.
    "connect-src 'self' wss://agents.assemblyai.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Every document gets the policy, including a prefetch. Excusing prefetches, which the
  // framework's own example does for caching, would hand out the page with no policy to
  // anyone who sets one header. Pages are rendered per request anyway, so a fresh nonce
  // costs nothing.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
