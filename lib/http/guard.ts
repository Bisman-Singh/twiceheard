import type { ZodType } from "zod";

/**
 * Request guards shared by every API route.
 *
 * Nothing here trusts the client: origin is checked, bodies are size-capped
 * before parsing, and every payload is validated against a schema.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

/** Only browsers on this site may call the API. */
export function assertSameOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && safeHost(origin) === host) return;
  throw new HttpError(403, "forbidden_origin");
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Reject oversized bodies using the declared length before reading them. */
export function assertContentLength(request: Request, maxBytes: number): void {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "payload_too_large");
}

/** Parse and validate a JSON body. */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<T> {
  assertContentLength(request, maxBytes);
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, "payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpError(400, "invalid_request", result.error.issues[0]?.message);
  }
  return result.data;
}

/**
 * The caller's address for rate limiting. Vercel sets `x-real-ip` from the
 * connection, so it wins; the first `x-forwarded-for` entry is only a
 * fallback for other hosts, where a client could forge it.
 */
export function clientAddress(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

export function jsonError(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error("unhandled api error", error);
  return Response.json(
    { error: "internal_error", message: "Something went wrong." },
    { status: 500 },
  );
}
