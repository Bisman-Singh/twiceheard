# Architecture

Next.js App Router, TypeScript strict, React and Tailwind. Eight API routes, four pages, and a library
that holds all the rules. Nothing clinical is left to the model: it collects, reads back, books, and
hands anything else to a person.

## One call, on the phone

The clinic's number points at a stored agent on the Voice Agent API. The agent body is built by
`lib/voice-agent/agent.ts` from the clinic record, and it declares every tool as an HTTP tool, so a
phone call needs no client in the loop.

1. The caller dials. The platform plays the greeting from the agent body and starts the session.
2. On its first reply the agent calls `start_intake`. AssemblyAI posts to
   `/api/tools/{clinicId}/start_intake` with the clinic's derived key in a header. The handler creates
   an intake, stores it, and returns a six-character intake id, today's date in the clinic's time zone,
   the opening hours and the doctors. The id uses an alphabet with no look-alike characters, because
   the model has to repeat it on every later call.
3. The caller gives a value. The agent calls `save_field` with status `heard`. The route validates the
   key, the body and the arguments, then `lib/intake/chart.ts` normalises the value and returns the
   readback sentence. The sentence is built here rather than by the model, and the agent is
   instructed to speak it exactly as given. Nothing in the platform enforces that, which is why
   `lib/postcall/replay.ts` checks after the call that what was actually said matches it.
4. The caller says yes. The agent calls `save_field` again with the same value and status `confirmed`.
   The reducer accepts it only because that exact value was read back. A different value is demoted
   back to `heard` and read again. A value that is still not right after three tries is left
   `unresolved` for the front desk.
5. `check_medication` asks RxNorm for a standard spelling. `find_slots` returns at most three open
   times from `lib/scheduling/slots.ts`. `book_appointment` refuses until name, date of birth and
   phone are confirmed, then claims the slot atomically and asks the messenger to send a confirmation.
6. `finish_intake` reports any critical field still unconfirmed, so the agent can ask once more.
   `escalate` ends the intake when the caller describes an emergency.

## One call, in the browser

AssemblyAI cannot call HTTP tools on a laptop, so `/call` takes a second path that ends in the same
handlers.

1. The page posts to `/api/voice/session`. The route mints a short-lived token server side, so the
   browser never holds the API key, and sets the signed call grant cookie. If the deployment has a
   stored agent it answers `mode: "agent"` with the agent id. If it does not, it answers
   `mode: "relay"` with the same agent configured inline by `lib/voice-agent/session.ts`, declaring the
   same tools with no HTTP target.
2. `lib/call/session-client.ts` opens the microphone, loads the audio worklet in
   `public/pcm-processor.js`, which resamples to 24 kHz PCM16 off the main thread, and opens the
   WebSocket with the token.
3. On `session.ready` the page learns the platform's session id and claims it through
   `/api/call/claim`, which binds that call to this browser.
4. The platform sends `tool.call`. The page runs nothing itself. It posts the tool name and arguments
   to `/api/voice/tool`, which reads the grant cookie to decide which clinic this is and then calls the
   same `runTool` the phone path calls. The result goes back over the socket, and only between replies,
   which is when the platform accepts it.
5. The page shows the conversation as it happens and an intake slip beside it, so a person watching can
   see a value read back before the caller agrees to it.

The two paths share the prompt, the greeting, the keyterms, the tool definitions and every handler.
Only the delivery differs.

## After the call

The chart the clinic sees is not the live one. It is rebuilt from what the call proves.

1. **The trigger.** In production the platform posts `session.completed` to
   `/api/webhooks/assemblyai`. The route verifies the HMAC over the raw body, deduplicates the
   delivery, answers at once, and processes the session afterwards. On a laptop no webhook can reach
   the machine, so the first `/api/call/result` from the page does the work instead. Either way a
   session is processed once, because a finished record is never processed again.
2. **Session history.** `processSession` fetches the session from the Voice Agent API and finds its
   artifacts. If the timeline is not attached yet it throws `ArtifactsNotReady`, and the webhook path
   retries after 5 seconds and then 20.
3. **Timeline replay.** `lib/postcall/timeline.ts` reduces the timeline to an ordered list of events:
   what the caller said, which tools ran with which arguments, what the agent said.
   `lib/postcall/replay.ts` replays those events into a fresh chart. A confirmation is only honoured
   when the readback sentence actually appears in what the agent said, and when the caller's last words
   before it were an agreement. A confirmation that fails either check becomes a plain `heard` and the
   reason is kept as a `ReplayIssue`.
4. **Second hearing.** The recording's link goes to the pre-recorded transcription API, which
   transcribes it again with the caller and the agent on separate channels and a confidence per word.
   `lib/verify/hearing.ts` looks for each chart value in the caller's own words: a name as a run of
   words in order, a date as day, month and year close together in any order people say them, a phone
   number as a run of digits however the words were split, a list by each item's key word, and an empty
   list by a clear negative. It reports `agrees`, `differs` or `absent`, with the lowest confidence
   among the matching words. The transcript is then deleted.
5. **Grading.** `lib/intake/grade.ts` takes the worse of the live verdict and the hearing verdict for
   every field, and records the reason for anything short of green. The chart is `ready` when every
   critical field is green.
6. **The record.** `lib/postcall/record.ts` defines what is kept: the chart, the grades and reasons,
   the replay issues, the per-field verifications, whether the second hearing ran, what was booked or
   escalated, and timing. No audio and no transcript. If the second hearing is unavailable the record
   is still written, graded on the conversation alone and flagged as such, because a late chart is
   worse for a clinic than an honestly partial one.

The page polls `/api/call/result` every 4 seconds while the record is pending and gives up after two
minutes, then says plainly that the clinic still has the call.

## Module map

| Path               | What lives there                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/`             | Four pages and eight API routes. Routes do authorisation, validation and wiring, nothing else.                                               |
| `components/call/` | The call panel, the live intake slip, and the graded chart shown back to the caller.                                                         |
| `lib/call/`        | The browser side of a call: microphone, socket, playback queue, tool relay, result polling.                                                  |
| `lib/clinic/`      | The clinic schema, the fictional demo clinic, and the registry that maps ids and agent ids to clinics.                                       |
| `lib/http/`        | Same-origin check, body caps, JSON validation, error shaping, client address, rate limiters, and reading the caller out of the grant cookie. |
| `lib/intake/`      | The field specs, normalisation, the chart reducer, readback sentences, grading, and the live intake store.                                   |
| `lib/medication/`  | Drug name matching rules and the RxNorm lookup.                                                                                              |
| `lib/notify/`      | The messenger interface, the booking message, and the recording fake.                                                                        |
| `lib/postcall/`    | Timeline parsing, chart replay, the second hearing, the call record and the retry policy.                                                    |
| `lib/scheduling/`  | Open slots in the clinic's own time zone, slot ids, and how a time is spoken.                                                                |
| `lib/security/`    | Tool key derivation, constant-time comparison, webhook signatures, call grants and call owners.                                              |
| `lib/server/`      | The validated environment and the dependency set every route asks for.                                                                       |
| `lib/store/`       | The Redis implementations of the shared stores.                                                                                              |
| `lib/verify/`      | Finding a value in the caller's own words, and the transcription client that feeds it.                                                       |
| `lib/voice-agent/` | The prompt, the tool definitions, the stored agent body, the inline session, and the REST client.                                            |
| `proxy.ts`         | The per-request nonce and Content Security Policy.                                                                                           |

## Interfaces and fakes

Every outside service sits behind an interface with a fake, and every shared store has an in-memory
twin with the same contract.

| Interface                                                    | Real                               | Fake                                                   |
| ------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| `VoiceAgentClient`                                           | REST calls to the Voice Agent API  | test double per case                                   |
| `SecondHearingClient`                                        | the pre-recorded transcription API | test double per case                                   |
| `MedicationLookup`                                           | RxNorm                             | test double per case                                   |
| `Messenger`                                                  | not built yet                      | `recordingMessenger`, which records what it would send |
| `IntakeStore`, `CallStore`, `FirstDelivery`, `SessionOwners` | Redis                              | in-memory equivalents                                  |
| `RequestLimiter`                                             | shared window in Redis             | per-instance sliding window                            |

`lib/server/deps.ts` builds the whole set once per server instance, from the environment. Routes never
construct a client or a store; they ask for one. Tests swap the entire set with `setServerDeps`, so
every route is exercised against fakes with no network and no Redis. `fetch` is injected into each
client for the same reason, and clocks are injected as `now: () => Date`, so time-dependent behaviour
is tested rather than waited for.

That is also why the product runs end to end on a laptop with nothing but an API key. The same
property makes the rules testable: normalisation, readback, grading, replay and the second hearing are
pure functions over plain data, and the adapters around them do nothing but fetch.
