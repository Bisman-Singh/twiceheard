import { cookieValue } from "@/lib/http/guard";
import { CALL_GRANT_COOKIE, callOwner, readCallGrant } from "@/lib/security/call-grant";

/**
 * Who is on the other end of a browser call.
 *
 * Read once from the grant cookie and used by every endpoint the page talks
 * to during and after a call: the clinic decides what the request may touch,
 * and the owner decides which single call's chart it may read back.
 */
export interface Caller {
  clinicId: string;
  owner: string;
}

export function readCaller(request: Request, secret: string, now: Date): Caller | null {
  const grant = cookieValue(request.headers.get("cookie"), CALL_GRANT_COOKIE);
  const clinicId = grant ? readCallGrant(grant, secret, now) : null;
  return grant && clinicId ? { clinicId, owner: callOwner(grant, secret) } : null;
}

/**
 * The longest a claim can be from the call it claims and still have been made
 * while that call was running. The platform caps a browser session at fifteen
 * minutes, so a claim further from the call's start than that was made after
 * the call, by someone who was not on it.
 */
export const LIVE_CLAIM_WINDOW_MS = 15 * 60 * 1000;
/** Two clocks, two machines. A claim a little ahead of the call's start is still that call's. */
const CLOCK_SLACK_MS = 30 * 1000;

/**
 * Whether a claim really belongs to this call.
 *
 * A session id is not a secret: it is in a desk address and in a log line. The
 * claim is what makes a chart readable, so the claim has to have been made by
 * this caller, while this call was live. Without the window, an id learned
 * later would be enough to take a stranger's call, which is what the endpoints
 * exist to prevent.
 */
export function claimIsLive(
  claim: { owner: string; at: number } | null,
  owner: string,
  startedAt: number | null,
): boolean {
  if (!claim || claim.owner !== owner) return false;
  // A call the platform never dated cannot be checked against its own lifetime,
  // and a claim that cannot be checked is not trusted with a patient's chart.
  if (startedAt === null) return false;
  const since = claim.at - startedAt;
  return since >= -CLOCK_SLACK_MS && since <= LIVE_CLAIM_WINDOW_MS;
}
