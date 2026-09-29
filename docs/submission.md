# Twiceheard submission text

The text to paste into the lablab submission form. Every claim here is checkable against a file in
this repository or against a run recorded in the demo video.

## One-line description

A clinic intake voice agent that hears every critical value twice, once in the live call and once
from the recording, and tells the front desk which fields it could not verify.

## Longer description

Phone intake gets done twice in most clinics. The patient says it once on the phone, and then a
receptionist types it again, or the desk simply asks for all of it a second time when the patient
walks in. A voice agent can take that call. What a clinic cannot do is act on a name, a date of birth
or a phone number that only a model claims to have heard. A wrong digit is a missed appointment, and
a wrong drug name is worse.

Twiceheard answers the clinic's line, or a call started from a browser, and runs the intake before
the visit. It asks for seven things: full name, date of birth, phone number, reason for visit,
current medications, allergies and preferred time. Five of those are critical, which means the clinic
is not allowed to act on them without the caller's explicit yes. It offers open appointment times
from the clinic's own diary, books one, and hands over a chart in which every field is marked
verified, to check, or missing, with the reason written out for a person to read.

The output is not a transcript and not a summary. It is a graded chart. A green line means two
hearings agreed. Anything else carries the reason it is not green, so the desk knows
exactly which caller to ring back and about what.

The caller may speak English, Hindi or a mix of the two. The agent understands all of it and replies
in simple English, slowing down for numbers.

## How it works

**The first hearing is the live conversation.** When the agent hears a value it calls `save_field`
with status `heard`. The server normalises the value, builds the readback sentence itself, and
returns that sentence for the agent to say word for word. The model never writes the readback. Only
after the caller says yes may the agent call `save_field` again with the same value and status
`confirmed`. A confirmation for a value that was never read back is refused. A confirmation for a
value that differs from the one read back is demoted and read back again. That rule is in
`lib/intake/chart.ts`.

**The chart is then rebuilt from what the call proves.** The chart the clinic sees is not the live
one. After the call, `lib/postcall/replay.ts` replays the session timeline into a fresh chart and
tests every confirmation against the record. The readback sentence must actually appear in what the
agent said. The caller's last words before the confirmation must be an agreement, and they must come
after the readback they are supposed to answer, so a yes given to one field cannot confirm the next.
A confirmation that fails any of those tests is replayed as a plain `heard`, and the reason is kept
for the front desk.

**The two hearings are not independent, and this document says so.** Both run on the same vendor's model
family over the same audio, so their errors will be correlated, and correlated exactly where it
matters: a strong accent, a noisy line, a voice affected by illness. What the second pass adds is
real but narrower than independence. It sees the whole recording rather than a stream, decodes in
batch, has the caller and the agent on separate channels, and returns a confidence for every word.
It catches what streaming gets wrong. Making the claim true would mean a second vendor's model,
which is a change worth making and has not been made.

**The second hearing happens after the call.** The voice platform stores the recording. Twiceheard
sends its link to AssemblyAI's pre-recorded transcription API, which transcribes it again on its own,
caller and agent on separate channels, with a confidence score on every word. `lib/verify/hearing.ts`
then asks, field by field, whether the value the chart holds is really in the caller's own words: a
name as a run of words in order, a date as day, month and year close together in any order people say
them, a phone number as a run of digits however the words were split, a list by each item's key word,
and an empty list by a clear negative. It answers agrees, differs or absent, with the lowest
confidence among the words that carried the value. The transcript is deleted once the words have been
scored. The audio goes from the platform's session store to the transcriber and never passes through
Twiceheard.

**The grade is the worse of the two verdicts** (`lib/intake/grade.ts`). A value stands behind a yes at
0.8 confidence or better. Between 0.5 and 0.8 the field drops to "to check". Below 0.5 the second
hearing is not sure the words were said at all, and the field is treated as missing. A chart is ready
only when every critical field is green.

Around that core, the parts a clinic would actually notice. A booking is refused until name, date of
birth and phone number are confirmed. A slot id is parsed and matched against the times the clinic
really offers at that moment, and claiming a slot is atomic, so two callers cannot take the same
time. A medication lookup against RxNorm may correct a spelling and can never swap one drug for
another; a close match becomes a question for the caller, and only their yes changes what is
recorded. A caller who describes an emergency ends the intake and is handed to a person. The agent is
told never to give medical advice.

The phone path and the browser path share the prompt, the greeting, the tool definitions and every
handler. On the phone, the platform calls HTTP tools directly, so no client is in the loop. In the
browser the same tools are declared inline and relayed through the server to the same handlers. Only
the delivery differs.

## What is genuinely different about it

Voice intake products transcribe the call and hand over what the model reported. This one refuses to
take the model's word for anything, and the mechanism is in this repository to check: a readback that
has to have been spoken, a yes that has to answer that readback and no other, a second transcription
of the same recording with per-word confidence, and a field that ends amber with its reason when the
two hearings disagree. Every one of those is a rule in code with a test behind it, not a claim.

Twiceheard does not have a dialable number either, and that is listed below as a gap. What it does
have is the rest of that combination, built rather than described.

Three things are unusual about the mechanism itself.

1. **A yes binds to one exact sentence.** Most read-back designs treat any agreement as confirmation.
   Here the agreement has to answer the readback it follows, and the readback has to have been spoken.
   Both are checked after the call against the record, not taken from the model's own report.
2. **The same audio is transcribed twice by two different paths.** The live conversation is one
   hearing. The stored recording, transcribed again with per-word confidence and the speakers on
   separate channels, is a second one. It is not independent, as the section above says, but it
   decodes in batch from the whole file rather than from a stream, so it catches what streaming gets
   wrong. Agreement between the two is what green means.
3. **The honest state is a shipped state.** A field the product could not verify is not hidden and not
   guessed. It is handed to the desk with the reason, which is the outcome a clinic can actually work
   with.

## Technology used

- AssemblyAI Voice Agent API for the live call, with stored agents and HTTP tools for the phone path
  and the same agent configured inline for the browser path.
- AssemblyAI pre-recorded transcription for the second hearing, requesting the `universal-3-5-pro`
  speech model with `universal-2` as a fallback, with dual-channel audio and per-word confidence.
- Next.js 16 App Router, React 19, TypeScript in strict mode, Tailwind. No UI framework beyond that.
- Upstash Redis for live intakes, slot claims, call records, webhook dedupe and session ownership,
  with in-memory equivalents behind the same interfaces for tests and local runs.
- zod for every request body and every tool argument, validated server side.
- RxNorm, the US National Library of Medicine's public drug vocabulary, for medication spelling only.
- Vitest with vitest-axe for the test suite, plus a scripted evaluation harness that runs the
  product's own grading code.

Every outside service sits behind an interface with a fake, and every shared store has an in-memory
twin with the same contract, so the whole product runs end to end with no network.

## What was measured

- `npm run verify` exits 0. It runs typecheck, lint, format check, the test suite with coverage, and
  the production build. 444 tests pass, at 100% statements, 100% branches, 100% functions and 100%
  lines over `app`, `components`, `lib`, `proxy.ts` and `next.config.ts`.
- 27 further tests run in a real browser: the whole call with a synthetic microphone, a 360 pixel
  screen, a keyboard-only pass, and the dark colour scheme.
- The evaluation harness holds 25 scripted cases across five categories: live, recording, confidence,
  readback and medication. All 25 pass. Each case states the grade and the exact reason every field
  must end with, so a change in wording fails the run instead of drifting past it.
- Six whole calls were made against the live Voice Agent API, driven through the product's own
  endpoints by a synthetic caller using speech synthesis with an Indian English voice. The last one
  came out 7 verified, 0 to check and 0 missing, with an appointment booked for a named doctor. On
  that call the median gap between a caller finishing and the agent speaking was 3.37 s, and the 95th
  percentile 4.49 s. The product's own tool handlers took 20 ms of that at the median, so the gap is
  the platform's turn and not this application's work. It is still slower than the paid products in
  this market, which sit between 1.7 and 2.5 s, and it is listed below as the main thing still wrong.
  The figure is measured with a harness that prepares every one of the caller's lines before the
  call opens. Synthesising speech mid-call blocks the audio pump, and a blocked pump adds about two
  seconds to every gap and charges them to the agent, so any latency number taken that way is
  measuring the harness.
- One of those calls was made from a real browser and recorded end to end: the microphone, the audio
  worklet, the tool relay through this app's own endpoints, and the chart at the end.
- In the first live run the model reported a medication as confirmed when the caller had not agreed
  to it. The post-call replay caught it and downgraded the field to amber with the reason "The caller
  did not agree to the value that was read back." That is the product's central claim, demonstrated
  against a real call rather than argued, and it is what the demonstration video shows.

Every rule below exists because a real call made the case for it. Each one is enforced in code and
pinned by a test that fails without it.

- **A yes confirms one readback and no other.** A yes given to one field could otherwise be spent on
  the next, and one "yes, both of those are correct" could carry two values. The replay records which
  turn each agreement was spent on, so a second field leaning on the same word is flagged rather than
  charted.
- **Digits and number words are the same number.** A transcriber writes a phone number as digits
  where the agent was given words to say, and a date read back as "12 March 1990" comes back as
  "March twelfth, nineteen ninety". Both compare as numbers, so wording is forgiven and a transposed
  digit is not.
- **A readback has to carry its own value.** Matching most of the sentence is not enough, because the
  frame is most of the sentence: a name read back as Sharma against a chart holding Mehta would have
  passed. The words of the value have to have been said; only the frame may be paraphrased.
- **An empty list needs a real denial.** "No allergies" is only verified by an utterance that is a
  denial and nothing else, scored by its weakest word. A goodbye of "no, that's all" verifies
  nothing, and that is the entry where being wrong is most dangerous.
- **Claiming a call and reading it back are separate acts.** A session id is not a secret: it appears
  in a desk address. A claim is refused once a call is charted, it records when it was made, and only
  a claim made while the call was running can read the chart back, so naming a session is not enough
  to see a stranger's intake. The tool relay is metered for the same reason.

## Security and privacy stance

- No audio is stored by Twiceheard and no recording is proxied through it. No full transcript is
  kept; the second hearing's transcript is deleted from AssemblyAI once its words have been scored, on
  every path including a timeout.
- Every endpoint decides for itself who may call it: a derived per-clinic key compared in constant
  time for the platform's tool calls, an HMAC signature over the exact raw body for webhooks, a signed
  short-lived grant cookie for a browser call, and session ownership before a caller can read a chart.
- One server secret derives every clinic's key, so rotating it rotates every clinic, and a leaked
  clinic key reveals nothing about another clinic's.
- Tool arguments are never trusted. Values are normalised server side, readbacks are built from the
  normalised value, and the chart only accepts a confirmation the call record proves.
- Arguments and results are never logged. A tool call is logged as the clinic id, the tool name,
  whether it succeeded and how long it took.
- A per-request Content Security Policy with a fresh nonce lets the policy drop `'unsafe-inline'` for
  scripts entirely. The only outside connection allowed is the Voice Agent API's WebSocket.
- `docs/privacy.md` describes what is kept and for how long, written from the code, including the
  points India's Digital Personal Data Protection Act turns on.

## What is not built yet

Written plainly, because a judge should not have to find it out.

- **Nothing is deployed and there is no phone number to dial.** The client can create a stored agent,
  import a number and bind it, but nothing in the app or in a script calls those methods. There is no
  deployment and no live line. The demo call is made from the browser page, which runs the same
  handlers.
- **Text messages need a provider.** The Twilio adapter is written and wired; with no credentials
  configured the messenger reports failure rather than success, so the agent never promises a text
  that is not coming.
- **One clinic, defined in code.** The schema and the registry are built for more than one, but there
  is no screen for adding or editing a clinic. The demo clinic and everyone in it are fictional.
- **No correction, and no named grievance contact.** A caller can delete the chart of the call they
  just made, but cannot change a value afterwards, and the privacy page still needs a named contact
  before anyone is invited to call a real number.
- **No age check.** India's DPDP Act requires verifiable parental consent for anyone under 18.
  Twiceheard does not check this, and a real deployment would have to solve it before taking calls.
- **Known limits are written down rather than hidden.** The shared rate limiter fails open, because a
  clinic line that stops answering is worse than one that is briefly too generous. Without Redis every
  store and every limit is per instance, which is right on a laptop and wrong on serverless. None of
  the security posture has been exercised against the public internet, because nothing is public.

Callers to the demo are asked not to give real medical details, and the page says so beside the
button.
