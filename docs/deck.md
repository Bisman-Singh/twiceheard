# Twiceheard deck

Eight slides. One headline per slide, three or four lines under it. Every figure on these slides is
one that was measured, and the last slide says what is not there.

## The call a clinic cannot act on

- A patient gives their name, date of birth and phone number once on the phone, and the desk asks for
  all of it again when they walk in.
- A voice agent can take that call. A clinic still cannot act on a value that only a model claims to
  have heard.
- A wrong digit is a missed appointment. A wrong drug name is worse.
- Read-back on its own does not fix it, because the model also reports whether the caller agreed.

## What Twiceheard does

- Answers the clinic's line, or a call started from a browser, and runs the intake before the visit.
- Collects seven fields. Five are critical, meaning the clinic may not act on them without an explicit
  yes.
- Offers open times from the clinic's own diary, books one, and refuses to book until name, date of
  birth and phone number are confirmed.
- Understands English, Hindi or a mix, replies in simple English, and slows down for numbers.

## Two hearings, never one

- The first hearing is the live call. The server normalises the value, writes the readback sentence
  itself, and hands it over to be said word for word. The model never writes a readback.
- The second hearing is the stored recording, transcribed again on its own, caller and agent on
  separate channels, with a confidence score on every word.
- The second pass looks for each value in the caller's own words: a name as a run of words in order, a
  date as day, month and year close together, a phone number as a run of digits however they were
  split.
- The grade is the worse of the two verdicts. Green means both agreed at 0.8 confidence or better.

## A yes binds to the exact sentence read back

- The chart the clinic sees is not the live one. It is rebuilt after the call from the session record.
- A confirmation survives only if the readback sentence was really spoken, and the caller's last words
  before it were an agreement, and that agreement came after the readback it answers.
- One that fails any of those becomes a plain "heard", and the reason is kept for the front desk.
- In a live run the model reported a medication as confirmed that the caller had not agreed to. The
  replay caught it and downgraded the field, with the reason in plain words.

## What was measured

- `npm run verify` exits 0. 482 tests, at 100% statements, branches, functions and lines over the
  application, components, library, proxy and config.
- 26 scripted evaluation cases across live grading, the recording, the confidence thresholds, the
  readback rule and the medication lookup. All 26 pass.
- Whole calls against the live Voice Agent API, driven through the product's own endpoints. The last
  one came out 7 verified, 0 to check, 0 missing, with an appointment booked. On that call the
  median gap between the caller finishing and the agent speaking was 3.37 s, and the product's own
  tool handlers accounted for 20 ms of it at the median. The rest is the platform's turn.
- Every rule in the grader earns its place: a yes spends on one readback only, digits and number
  words compare as numbers, a readback has to carry its own value, and an empty allergy list needs a
  denial and not just a "no" somewhere in the call.

## What the front desk actually gets

- A chart, not a transcript. Every line carries a grade, and every line short of green carries the
  reason in words a person reads.
- One line to ring back about, instead of a recording to listen to and a form to re-key.
- A call where every critical field is green can be acted on without calling anyone back.

## Security and privacy, written from the code

- No audio stored, no recording proxied, no full transcript kept. The second hearing's transcript is
  deleted once its words have been scored, on every path including a timeout.
- Every endpoint authorises itself: a derived per-clinic key compared in constant time, an HMAC over
  the exact raw webhook body, a signed short-lived grant for a browser call, ownership before a caller
  reads a chart.
- Tool arguments are never trusted. Values are normalised server side, and the chart only accepts a
  confirmation the call record proves. Arguments and results are never logged.
- `docs/privacy.md` lists what is kept, for how long, and the India DPDP points, including the ones
  this build does not satisfy.

## Where it stands today

- A phone call runs the stored agent on the host that holds the number; a browser call runs the same
  prompt and tools inline. Both end at the same handlers and the same chart.
- With no messaging provider configured the messenger reports failure rather than success, so a
  booking never claims a text that nobody sent. One clinic, defined in code. Everyone in it is
  fictional.
- A caller can erase their own chart, and that endpoint is built and authorised. There is no named
  grievance contact and no age check, which a real deployment in India would need first.
- The shared rate limiter fails open by design, on the view that a clinic line that stops answering is
  worse than one that is briefly too generous.
