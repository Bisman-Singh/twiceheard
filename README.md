# Twiceheard

Twiceheard answers a clinic's phone line, or a call started from a browser, and runs the intake
before the visit. It asks for the caller's name, date of birth, a phone number, the reason for the
visit, current medications and allergies. It reads every critical value back to the caller before
it records it. It offers real open appointment times, books one, and hands the clinic a chart where
every field is graded `verified`, `check` or `missing`.

It is a submission for the AssemblyAI Voice Agent Hackathon. Nothing is deployed. Everything below
describes what runs locally.

## Every value is heard twice

A field is green only when two independent hearings agree.

**The first hearing is the live conversation.** When the agent hears a value it calls `save_field`
with status `heard`. The server normalises the value, builds the readback sentence itself, and
returns that sentence for the agent to say word for word. Only after the caller says yes may the
agent call `save_field` again with the same value and status `confirmed`. A confirmation for a value
that was never read back is refused, and a confirmation for a value that differs from the one read
back is demoted to `heard` and read back again. That rule lives in `lib/intake/chart.ts`.

**The second hearing happens after the call.** The voice platform stores the recording. Twiceheard
passes its link to AssemblyAI's pre-recorded transcription API, which transcribes it again on its
own, caller and agent on separate channels, with a confidence score on every word.
`lib/verify/hearing.ts` then asks, field by field, whether the value the chart holds is actually in
the caller's own words, and how sure that transcription was about the words carrying it. The audio
goes from the platform's session store to the transcriber. It never passes through Twiceheard.

The grade is the worse of the two verdicts (`lib/intake/grade.ts`).

| Grade      | What it means                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified` | The caller said yes to the exact value read back, and the recording contains it at 0.8 confidence or better.                                              |
| `check`    | Heard but not confirmed, or the recording suggests something else, or the value could not be found in it, or it was found between 0.5 and 0.8 confidence. |
| `missing`  | Not captured at all, still unresolved after three tries, or found in the recording below 0.5 confidence.                                                  |

There is a third check between the two hearings. The chart the clinic sees is not the live one. It
is rebuilt after the call from the session timeline, and each confirmation is tested against what the
call proves: the readback sentence must actually appear in what the agent said, and the caller's last
words before the confirmation must be an agreement. A confirmation that fails either test is replayed
as a plain `heard`, and the reason is kept for the front desk. That is `lib/postcall/replay.ts`.

## Running it locally

Node 24 or newer. The version is pinned in `.nvmrc`.

```bash
npm install
npm run dev            # http://localhost:3000
```

`/` explains the product. `/call` is the browser call for the demo clinic. `/desk` is the clinic's
side: sign in with that clinic's code and every finished call is listed, newest first, with the
chart behind each one. `GET /api/health` reports whether the environment parsed and whether the
stores are shared, and nothing else.

The desk code is derived from `TWICEHEARD_SECRET`, so it changes when that secret changes and one
clinic's code says nothing about another's.

### Environment variables

`lib/server/env.ts` validates the environment once, at first use, and nothing else reads
`process.env`. Put values in `.env.local`, which is ignored by git. Never commit a value.

| Variable                                                | Required                   | What it is for                                                                                                                         |
| ------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ASSEMBLYAI_API_KEY`                                    | yes                        | The Voice Agent API and the transcription API. Server side only.                                                                       |
| `TWICEHEARD_SECRET`                                     | yes, 32 characters or more | Derives each clinic's tool key and desk code, signs the browser call grant and the desk session, and names the browser that holds one. |
| `TWICEHEARD_WEBHOOK_SECRET`                             | yes, 32 characters or more | Verifies the HMAC signature on webhook deliveries. Set the same value on the subscription.                                             |
| `TWICEHEARD_AGENT_ID`                                   | no                         | The stored agent that answers for the demo clinic. Without it, a browser call configures the same agent inline instead.                |
| `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | no                         | Shared stores. `KV_REST_API_URL` and `KV_REST_API_TOKEN` are accepted as aliases.                                                      |

Without Redis the app runs on in-memory stores. That is right for a laptop and wrong for serverless,
where each instance would keep its own copy.

On a laptop there is no stored agent, because AssemblyAI cannot reach `localhost` to call HTTP tools.
`POST /api/voice/session` notices that and returns the same agent configured inline. The platform then
asks the browser to run each tool, and the browser relays it to `POST /api/voice/tool`, where the same
handlers do the same work. The wording, the tools and the rules are identical to the phone path.

### Scripts

| Command                                    | What it does                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                              | Next.js dev server on port 3000.                                                                               |
| `npm run build` / `npm start`              | Production build and server.                                                                                   |
| `npm test`                                 | The test suite.                                                                                                |
| `npm run test:watch`                       | The suite in watch mode.                                                                                       |
| `npm run test:coverage`                    | The suite with coverage and the thresholds enforced.                                                           |
| `npm run typecheck`                        | `tsc --noEmit`.                                                                                                |
| `npm run lint` / `npm run lint:fix`        | ESLint.                                                                                                        |
| `npm run format` / `npm run format:check`  | Prettier.                                                                                                      |
| `npm run verify`                           | Typecheck, lint, format check, coverage and the production build, in that order.                               |
| `npm run e2e`                              | The browser call in a real Chromium, with a synthetic microphone and the platform's socket played by the test. |
| `node scripts/smoke-call.mjs <outDir>`     | One synthetic call against the live Voice Agent API. It reads the key from `.env.local` and spends credit.     |
| `node scripts/e2e-call.mjs <url> <outDir>` | One whole call driven through the running app against the live API, ending in the graded chart. Spends credit. |

## Tests and the coverage bar

Tests run under Vitest in the Node environment. Component and page tests opt into jsdom per file with
a docblock. Accessibility assertions use `vitest-axe`.

Coverage is measured over `app/**`, `components/**`, `lib/**`, `proxy.ts` and `next.config.ts`, with
thresholds of **100% statements, 100% branches, 100% functions and 100% lines** (`vitest.config.mts`).
`npm run test:coverage` fails the run if any metric falls below that, so an untested branch anywhere
fails the build.

`npm run e2e` is separate from that gate. It drives the real browser: Chromium opens a synthetic
microphone, the audio worklet runs, each tool call goes to this app's own endpoint and comes back,
and the platform's socket is answered by the test so the run is the same every time.

CI runs the same gate on every push and pull request to `main`, then the browser test, and adds a
gitleaks scan over the full history, `npm audit --audit-level=high`, and CodeQL with the
`security-and-quality` queries.

TypeScript is strict, with `noUncheckedIndexedAccess`, `noUnusedLocals` and `noFallthroughCasesInSwitch`
on. ESLint bans `any`, non-null assertions and `console.log`, and caps complexity, nesting depth and
function length.

## What is not built yet

- **No text messages are sent.** `lib/notify/sms.ts` defines the messenger interface and the booking
  message, and `lib/server/deps.ts` wires the recording fake. A booking records the text it would send
  and reports success. No provider is connected.
- **No admin screen.** The clinic registry serves one fictional demo clinic defined in
  `lib/clinic/config.ts`. The schema and the registry are built for more than one, but there is no way
  to add or edit a clinic without editing that file.
- **Nothing creates the stored agent or binds a phone number.** `lib/voice-agent/agent.ts` builds the
  agent body, and the client has `createAgent`, `updateAgent`, `importPhoneNumber` and
  `bindPhoneNumber`, but only the tests call them. There is no route, script or command that sets up a
  deployment, and there is no live phone number.
- **One clinic code per clinic, and no staff accounts.** The desk signs in with a code derived from
  the server secret, so there is no per-person login, no roles and no audit of who looked at what.

A caller can delete the chart of the call they just made from `/call`, which erases the record and
its index entry. The desk has no deletion control, and there is no way to correct a value after a
call. See `docs/privacy.md`.

## AI disclosure

Twiceheard uses AssemblyAI's Voice Agent API for the live call, and AssemblyAI's pre-recorded
transcription API for the second hearing, requesting the `universal-3-5-pro` speech model with
`universal-2` as a fallback. The agent's replies come from the model the Voice Agent API runs behind
that session.

What goes to AssemblyAI:

- the caller's audio and the agent's audio, in real time, for the duration of the call;
- the system prompt, the greeting, the keyterms list and the transcription prompt, all built from the
  clinic record, so they contain the clinic's name, its doctors' names and its formulary;
- the tool definitions, the arguments the model produces for each tool call, and the result each tool
  returns, which during an intake include the caller's name, date of birth, phone number, reason for
  the visit, medications and allergies;
- the recording's own link, when the second hearing is submitted.

AssemblyAI stores the session recording and timeline, which Twiceheard reads after the call. The
second hearing's transcript is deleted from AssemblyAI once its words have been scored, on every path
including a timeout.

Medication names also go to RxNorm, the US National Library of Medicine's public drug vocabulary, as a
search term only. That lookup may correct a spelling, and it can never swap one drug for another; a
close match becomes a question for the caller, and only their yes changes what is recorded.

## Licence

MIT. See `LICENSE`.
