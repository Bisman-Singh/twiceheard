const STEPS = [
  {
    title: "The caller talks",
    body: "A patient phones the clinic and speaks naturally, in English, Hindi or a mix of both.",
  },
  {
    title: "Every critical detail is read back",
    body: "Name, date of birth, phone number, medications and allergies are read back word for word. Only a yes to that exact value counts.",
  },
  {
    title: "The appointment is booked",
    body: "Real open times are offered, one is booked, and the caller gets a text message confirming it.",
  },
  {
    title: "The call is heard a second time",
    body: "After the call, the recording is transcribed again on its own. Each detail is checked against the caller's own words and scored.",
  },
];

/** Written out in full so the stylesheet contains them; the CSP forbids inline style attributes. */
const TONES = {
  green: "text-[var(--green-text)]",
  amber: "text-[var(--amber-text)]",
  red: "text-[var(--red-text)]",
} as const;

const GRADES = [
  {
    label: "Verified",
    tone: "green",
    body: "Confirmed by the caller and found in the recording with confidence.",
  },
  {
    label: "Check",
    tone: "amber",
    body: "Heard but not confirmed, or partly unclear in the recording.",
  },
  {
    label: "Missing",
    tone: "red",
    body: "Not captured, not confirmed after several tries, or unclear in the recording.",
  },
] as const;

export default function Home() {
  return (
    <article className="space-y-12">
      <header className="space-y-4">
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--accent)]">
          Twiceheard
        </p>
        <h1 className="text-4xl font-bold leading-tight">
          Clinic intake by phone, with nothing on the chart you cannot check.
        </h1>
        <p className="max-w-2xl text-lg text-[var(--muted)]">
          A voice agent answers the clinic&apos;s phone, collects what the doctor needs before the
          visit, and books the appointment. Every critical detail is confirmed out loud and then
          verified against the recording, so the front desk knows which fields to trust.
        </p>
      </header>

      <section aria-labelledby="how" className="space-y-4">
        <h2 id="how" className="text-2xl font-semibold">
          How a call works
        </h2>
        <ol className="border-t border-[var(--line)]">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[2rem_1fr] gap-x-4 border-b border-[var(--line)] py-4"
            >
              <span className="font-mono text-sm text-[var(--muted)]">{index + 1}</span>
              <div>
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-1 text-[var(--muted)]">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="grades" className="space-y-4">
        <h2 id="grades" className="text-2xl font-semibold">
          What the clinic sees for each field
        </h2>
        <ul className="border-t border-[var(--line)]">
          {GRADES.map((grade) => (
            <li
              key={grade.label}
              className="grid grid-cols-[7rem_1fr] gap-x-4 border-b border-[var(--line)] py-4 max-sm:grid-cols-1"
            >
              <h3 className={`font-semibold ${TONES[grade.tone]}`}>{grade.label}</h3>
              <p className="text-[var(--muted)]">{grade.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-[var(--line)] pt-6 text-sm text-[var(--muted)]">
        Twiceheard does not give medical advice. It collects and confirms details for the clinic,
        and sends anyone describing an emergency to emergency services.
      </footer>
    </article>
  );
}
