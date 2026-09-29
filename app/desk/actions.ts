"use server";

import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/desk/session";

/**
 * Sign in and out, as form submissions.
 *
 * Both are server actions so the desk works with no JavaScript: the form
 * posts, the cookie is set on the server, and the page is rendered again for
 * the clinic that was signed in.
 */

export async function signInAction(_state: string, form: FormData): Promise<string> {
  const outcome = await signIn(String(form.get("code") ?? ""));
  if (outcome === "ok") redirect("/desk");
  return outcome === "too_many"
    ? "Too many attempts. Wait a few minutes and try again."
    : "That code does not match a clinic.";
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/desk");
}
