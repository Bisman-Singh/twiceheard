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
