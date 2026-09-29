# Twiceheard: how work is done here

Phone-first clinic intake. A voice agent answers the clinic's line, collects what the
doctor needs before the visit, books the appointment, and hands the clinic a chart where
every field is either verified or flagged.

## Stack

- TypeScript strict everywhere. Next.js App Router, React, Tailwind v4.
- Voice: AssemblyAI Voice Agent API (stored agents, HTTP tools) for the phone line and the
  browser call button; Universal-3.5 Pro pre-recorded transcription for the second hearing.
- Data: Upstash Redis in production for live intakes, slot claims, call records and webhook
  dedupe; in-memory equivalents for tests and local runs.
- Outside services, each behind an interface with a fake: RxNorm (medication names),
  a messaging provider over Twilio's Messages API, the voice platform.

## Commands

```bash
npm run dev            # local app on :3000
npm run verify         # typecheck, lint, format check, tests with coverage, production build
npm test               # tests only
node scripts/smoke-call.mjs <outDir>   # one synthetic call against the live voice API
```

## Definition of done

A change is done when all of this is true, not before:

1. `npm run verify` exits 0. That includes 100% statements, branches, functions and lines.
   The thresholds are the bar, not an aspiration.
2. The behaviour is proved by a test that fails without the change.
3. Anything touching a live service has been run against that service at least once, and
   the output is in the session, not assumed.
4. No secret, no patient detail and no transcript text in logs, errors or committed files.
5. Every async thing a person sees has four states: loading, empty, error, success.

## Never do

- Never leave a stub that reports success, mock data in a real path, a `TODO: implement`,
  or a comment saying what production would do. Build it or leave it out and say so.
- Never delete, skip or loosen a test to get a green run. Fix the code.
- Never add a dependency without asking first, and never one that has not been checked as
  the real, current package.
- Never write a secret into a tracked file, a `NEXT_PUBLIC_` variable or the client bundle.
- Never trust the model: tool arguments are validated server-side, and the chart only
  accepts a confirmation the call record proves.
- Never give a caller medical advice, and never let an emergency continue as an intake.
- Never claim something works without the command and output that shows it.

## Rules that shape the product

- **A yes binds to the exact value read back.** Confirmations that were never read aloud,
  or that the caller did not agree to, are downgraded when the chart is rebuilt after the
  call. `lib/intake/chart.ts` and `lib/postcall/replay.ts` hold this.
- **Two hearings, never one.** The live conversation, then the recording transcribed again
  with per-word confidence. A field is green only when both agree.
- **A lookup may correct a spelling, never swap a drug.** `lib/medication/match.ts`.
- **Interfaces at every boundary**, with a fake for tests and demo mode, so the whole
  product runs with no network.

## Interface

- No generic template look: no gradients, no card rows, no drop shadows, no web-font
  display faces, no emoji, no rounded-everything. The clinic screens follow the paper an
  OPD desk already uses: ruled lines, square corners, state carried in ink colour.
- Light and dark both ship. Keyboard-only must work. Contrast 4.5:1 or better.
- Real content only: synthetic patients with fictional names, never a fake testimonial.
