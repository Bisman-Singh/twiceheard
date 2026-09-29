import "server-only";
import { cookies, headers } from "next/headers";
import type { Clinic } from "@/lib/clinic/config";
import { clientAddress } from "@/lib/http/guard";
import {
  DESK_COOKIE,
  DESK_SESSION_TTL_MS,
  clinicForCode,
  issueDeskSession,
  readDeskSession,
} from "@/lib/security/desk-session";
import { serverDeps } from "@/lib/server/deps";

/**
 * The desk's side of every request, decided on the server.
 *
 * A page asks who is signed in; it never takes a clinic from the URL or from
 * anything the browser can set. A record is shown only when its clinic is the
 * one in the signed cookie, so knowing a session id is not enough to read
 * another clinic's call.
 */

export type SignInOutcome = "ok" | "wrong_code" | "too_many";

export async function signedInClinic(): Promise<Clinic | null> {
  const deps = serverDeps();
  const jar = await cookies();
  const clinicId = readDeskSession(jar.get(DESK_COOKIE)?.value, deps.env.secret, deps.now());
  return clinicId ? deps.clinics.byId(clinicId) : null;
}

export async function signIn(code: string): Promise<SignInOutcome> {
  const deps = serverDeps();
  const address = clientAddress(new Request("http://desk", { headers: await headers() }));
  if (!(await deps.deskSignIns.allow(address))) return "too_many";
  const clinicId = clinicForCode(code, deps.clinics.ids(), deps.env.secret);
  if (!clinicId) return "wrong_code";
  const jar = await cookies();
  jar.set(DESK_COOKIE, issueDeskSession(clinicId, deps.env.secret, deps.now()), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DESK_SESSION_TTL_MS / 1000,
  });
  return "ok";
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(DESK_COOKIE);
}
