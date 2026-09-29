# Privacy

Twiceheard is a demonstration. The clinic in it is fictional, and so is everyone who works there. The
call page says so on the button, and asks callers not to give real medical details. Please take that
seriously. Nothing here is a service, and nothing here is deployed.

This page describes what the code actually does with what a caller says. It is written from the code,
not from an intention.

## What a caller gives

During an intake the agent asks for seven things. Five of them are treated as critical, which means
the clinic cannot act on them without the caller's explicit yes.

| Field               | Critical | Stored as                                             |
| ------------------- | -------- | ----------------------------------------------------- |
| Full name           | yes      | the words the caller agreed to                        |
| Date of birth       | yes      | `YYYY-MM-DD`                                          |
| Phone number        | yes      | E.164, so `+91` or `+1` and the national number       |
| Reason for visit    | no       | free text, capped at 300 characters                   |
| Current medications | yes      | a list, or an empty list meaning the caller said none |
| Allergies           | yes      | a list, or an empty list meaning the caller said none |
| Preferred time      | no       | free text, capped at 300 characters                   |

The caller's voice is also carried, for the length of the call. If the caller describes an emergency or
asks for a person, the model writes one short sentence saying why, capped at 300 characters.

## Where it goes

**AssemblyAI**, which runs the Voice Agent API and the transcription API. The caller's audio and the
agent's audio go there in real time. So do the tool calls, which carry the values above as the model
produces them. AssemblyAI stores the session recording and the timeline for the call. After the call,
Twiceheard sends the recording's link to the transcription API for the second hearing. The audio goes
from AssemblyAI's session store to AssemblyAI's transcriber and never passes through Twiceheard.

**RxNorm**, the US National Library of Medicine's public drug vocabulary. Only a medication name goes
there, as a search term, with no key and no identifier attached. It is not sent a name, a number or an
intake id.

**Redis**, when a deployment configures it. Live intakes, taken appointment times, finished call
records, webhook delivery ids and session owners live there. Without Redis they live in the server
process's memory and disappear when it stops.

**No messaging provider.** A booking records the text message it would send and reports success. No
phone number leaves the app to a messaging provider today.

## What is kept, and for how long

These are the values in the code, in `lib/intake/store.ts` and `lib/store/redis.ts`.

| What                                                                       | How long                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| The live intake during a call, which holds the chart as it is being filled | 6 hours from the last write                               |
| A taken appointment time                                                   | 30 days                                                   |
| A webhook delivery id, so a retry is not processed twice                   | 24 hours                                                  |
| The link between a call and the browser that made it                       | 1 hour                                                    |
| The browser's call grant cookie                                            | 20 minutes                                                |
| The finished call record                                                   | **no expiry is set**; it is kept until someone deletes it |

The call record is the one that outlives the call. It holds the chart, the grade and the reason for
each grade, what was booked, whether the call was escalated, and timing figures. It therefore holds
the caller's name, date of birth, phone number, reason for visit, medications and allergies.

## What is not kept

- **No audio.** Twiceheard never stores a recording and never proxies one. The recording stays with
  AssemblyAI, under AssemblyAI's own terms and retention.
- **No transcript.** The second hearing's transcript is deleted from AssemblyAI as soon as its words
  have been scored, on every path including a timeout. What survives is a verdict per field and a
  confidence number.
- **No logged patient detail.** A tool call is logged as the clinic id, the tool name, whether it
  succeeded and how long it took. Arguments and results are not logged. Errors from the voice platform
  are logged as a status and a short code.

There are two exceptions, and they are deliberate. The call record keeps the escalation sentence the
model wrote, capped at 300 characters. When a caller did not agree to a value that was read back, the
record keeps up to 200 characters of what they said at that moment, so the front desk can see why the
field was downgraded rather than being told only that it was.

## Asking for deletion

A caller can delete their own call from the page they called on. Once the chart is shown, the page
offers to delete it. The first press only asks the question; answering it is what deletes, so no
single click erases anything. The page then says the call is gone.

`POST /api/call/forget` is the route behind that. It takes the request from this site only, it
requires the call grant cookie the call itself issued, and it requires that the session named in the
request is one this browser claimed while the call was live. That is the same test the chart is read
back under, in `app/api/call/result/route.ts`, because reading this record and erasing it are the same
entitlement. One caller cannot delete another caller's call, and a grant for one clinic cannot reach
another clinic's records. Asking twice is not an error: a record that has already gone answers the
same way as one erased just now, so a retry after a dropped reply is safe, and the answer never says
whether some other clinic holds that id.

Deleting removes the call record itself and its place in the clinic's index, in Redis and in the
in-memory store alike, so the call leaves the clinic's desk as well as the caller's page. Nothing is
kept in its place. The deletion is logged as the clinic id and the fact that a record went, and
nothing else. `lib/postcall/record.ts` and `lib/store/redis.ts` hold both stores.

Two things this cannot delete, because the app never held them. The recording and the session
timeline stay with AssemblyAI, under their retention; a caller who wants those removed has to ask
AssemblyAI, and the repository owner would carry that request. The second hearing's transcript is not
one of them: it is already deleted there as soon as its words have been scored.

**TODO for the repository owner: put a grievance contact here.** The India Digital Personal Data
Protection Act requires a named contact who answers questions and complaints about personal data, and
requires that the contact be published. Replace this paragraph with a name or role and an email
address before anyone is invited to call a real number.

## The India DPDP points

**Consent.** The agent's greeting says the call is recorded, before it asks for anything, and names
the reason: to prepare for the visit. The call page repeats it beside the button. The greeting is
built in `lib/voice-agent/prompt.ts`, so it cannot be skipped by a prompt change on one path and not
the other. A caller who does not want to continue can hang up, and nothing is stored until the agent
calls a tool.

**Purpose limitation.** The data is collected to prepare an appointment and to hand the clinic a chart
it can act on. It is used for that and for grading the chart against the recording. It is not used to
train anything, it is not sold, and there is no analytics or advertising code in the app.

**Data minimisation.** The seven fields above are the whole form. The agent is told not to give
medical advice, not to discuss fees, and to hand anything outside the intake to a person, so the call
does not wander into detail nobody asked for.

**Children.** Anyone under 18 needs verifiable consent from a parent or legal guardian before their
data may be processed, and their data may not be used for tracking or targeted advertising. Twiceheard
does not check this today. Date of birth is validated as a real past date within 120 years, and
nothing in the code refuses a caller who turns out to be a child or asks for a parent. A real
deployment would have to solve that before taking calls.

**Rights.** A real deployment would also need a way for a caller to see, correct and delete what is
held about them. Showing the chart back to the caller who just called is a start, and it is only a
start.

## What this page is not

It is not a privacy policy, and it is not legal advice. It is a description of the code as it stands,
written so that anyone reading the repository can check each claim against the file it names.
