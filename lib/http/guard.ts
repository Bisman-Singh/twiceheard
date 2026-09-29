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

/**
 * The body, read no further than the cap allows.
 *
 * A declared length is a claim, and a chunked request makes none at all, so the
 * bytes are counted as they arrive and the read stops the moment the cap is
 * passed. Without this, a cap could be walked past by simply not declaring one.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string> {
  assertContentLength(request, maxBytes);
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new HttpError(413, "payload_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Parse and validate a JSON body. */
export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const raw = await readCapped(request, maxBytes);
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
  // The kind only. A store or schema error can carry the command it failed on, and that
  // command holds the caller's chart.
  console.error("unhandled api error", {
    kind: error instanceof Error ? error.name : "unknown",
  });
  return Response.json(
    { error: "internal_error", message: "Something went wrong." },
    { status: 500 },
  );
}

/** One cookie's value out of a request's `Cookie` header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
