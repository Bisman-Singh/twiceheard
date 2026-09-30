/**
 * The four lines a visitor can read out, so the demonstration works without
 * anyone having to guess what the agent is listening for.
 *
 * The patient is invented, and the lines are the answers to the questions the
 * agent actually asks, in the order it asks them. One is Hinglish, because the
 * agent takes English, Hindi or a mix and nothing else on the page shows that.
 * Laid out like the rest of the clinic screens: ruled lines, square corners,
 * nothing decorative.
 */

const LINES: readonly { readonly say: string; readonly asked: string }[] = [
  {
    say: "My name is Priya Sharma, P-R-I-Y-A.",
    asked: "When it asks for your full name. Spelling it gives the recording a name to check.",
  },
  {
    say: "Date of birth fourteen March nineteen eighty-eight.",
    asked: "When it asks for your date of birth. It reads the date back before it keeps it.",
  },
  {
    say: "Main metformin leti hoon, paanch sau.",
    asked: "When it asks what you take. This one is Hinglish.",
  },
  {
    say: "Kal subah agar slot hai.",
    asked: "When it asks when you would like to come in. It then offers up to three times.",
  },
];

export function SayThis() {
  return (
    <section aria-labelledby="say-this" className="border border-[var(--line)] p-4">
      <h2 id="say-this" className="text-sm font-semibold uppercase tracking-wide">
        Say this on the call
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        Priya Sharma is an invented patient, so none of this belongs to anyone. The agent also asks
        for a phone number and why you are coming in; answer those in your own words, and keep them
        invented too.
      </p>
      <ol className="mt-3 border-t border-[var(--line)]">
        {LINES.map((line) => (
          <li key={line.say} className="border-b border-[var(--line)] py-2">
            <p className="font-semibold">
              &ldquo;{line.say}&rdquo;
              <span className="ml-2 block font-normal text-sm text-[var(--muted)] sm:inline">
                {line.asked}
              </span>
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-3 max-w-2xl text-sm">
        The third line is Hinglish for &ldquo;I take metformin, five hundred&rdquo;. The agent
        understands English, Hindi or the two mixed, and answers in English.
      </p>
    </section>
  );
}
