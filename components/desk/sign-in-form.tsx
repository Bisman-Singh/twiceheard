"use client";

import { useActionState } from "react";
import { signInAction } from "@/app/desk/actions";

/**
 * The desk's sign-in.
 *
 * One field, because a clinic's code is the whole credential. The failure
 * message never says whether a code was close, and the same message covers a
 * wrong code whichever clinic it was aimed at.
 *
 * `demoCode` is the published code of the fictional demonstration clinic, or
 * null where there is none to publish. It is printed, never filled in: the
 * field stays required and the server still has to agree with what was typed.
 * It is deliberately kept out of the field's description, so the description a
 * screen reader reads on a refusal stays the reason it was refused.
 */
export function SignInForm({ demoCode }: { demoCode: string | null }) {
  const [problem, submit, pending] = useActionState(signInAction, "");
  return (
    <form action={submit} className="max-w-sm border-t-2 border-[var(--text)] pt-5">
      {demoCode && (
        <p className="mb-4 border-l-2 border-[var(--accent)] pl-3 text-sm">
          A clinic code is required. For this demonstration, use{" "}
          <code className="font-semibold tracking-widest">{demoCode}</code>.
        </p>
      )}
      <label htmlFor="code" className="block font-semibold">
        Clinic code
      </label>
      <p id="code-help" className="mt-1 text-sm text-[var(--muted)]">
        Ten characters, from the clinic&apos;s setup sheet.
      </p>
      <input
        id="code"
        name="code"
        type="text"
        required
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        aria-describedby={problem ? "code-help code-problem" : "code-help"}
        aria-invalid={problem ? true : undefined}
        className="mt-2 w-full border-2 border-[var(--text)] bg-transparent px-3 py-2 font-mono tracking-widest"
      />
      {problem && (
        <p id="code-problem" role="alert" className="mt-2 text-sm text-[var(--red-text)]">
          {problem}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-4 border-2 border-[var(--text)] px-5 py-2 font-semibold disabled:opacity-60"
      >
        {pending ? "Checking" : "Open the desk"}
      </button>
    </form>
  );
}
