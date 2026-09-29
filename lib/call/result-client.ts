import type { CallRecord } from "@/lib/postcall/record";

/**
 * The caller's own chart, asked for from the page.
 *
 * The session is claimed the moment the call goes live, which is what later
 * entitles this browser and no other to read the chart back. After the call
 * the answer is "pending" until the platform has attached the recording, so
 * the page asks again rather than treating a wait as a failure.
 */

export type CallResult =
  { status: "pending" } | { status: "ready"; record: CallRecord } | { status: "unavailable" };

export async function claimSession(sessionId: string): Promise<void> {
  await post("/api/call/claim", sessionId);
}

export async function fetchResult(sessionId: string): Promise<CallResult> {
  const response = await post("/api/call/result", sessionId);
  if (!response.ok) return { status: "unavailable" };
  return (await response.json()) as CallResult;
}

function post(path: string, sessionId: string): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}
