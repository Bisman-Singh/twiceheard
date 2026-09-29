# Demo video script

Three minutes, eight shots, 178 seconds of content. The video has to show one thing above all: a real
call going in, and a graded chart coming out, including a field that does not come out green.

## Before you record

- Have the dev server running and the browser call page open in a clean window, light theme.
- Make the call for real. Do not re-voice it afterwards and do not cut the pauses out of the call
  audio. The pauses are what a readback sounds like.
- Record the whole call in one take, including the post-call wait, then cut from that one file. Shots
  2 and 3 must come from the same recording so the timestamps line up.
- Use a run whose chart ends with at least one field marked "to check". If the run comes out all
  green, keep the recording and make another call, or use the earlier recorded run in which the
  medication was downgraded. Do not stage the failure and do not edit a grade.
- Narration is spoken over the shot unless the shot note says the call's own audio plays.

## Shot 1. The problem, on the page you are about to use

**0:00 to 0:12, 12 seconds. Screen capture.**

On screen: the call page for the demo clinic, showing the line that says every critical detail is
read back before it is recorded. Cursor still.

Say:

> A clinic can let a voice agent take the phone. What it cannot do is act on a name or a phone number
> that only a model says it heard. Twiceheard hears every critical value twice.

## Shot 2. A real call

**0:12 to 0:50, 38 seconds. Real recording, with the call's own audio.**

On screen: the call panel with the conversation appearing turn by turn and the intake slip filling
beside it. Let the call audio carry this shot.

Say over the first four seconds only, then stop talking:

> This call is live. Nothing here is scripted on the product's side.

Then the call plays: the greeting, the name, the date of birth, the phone number.

## Shot 3. The readback, and what the server is doing during it

**0:50 to 1:10, 20 seconds. Real recording for the audio, screen capture for the overlay.**

On screen: the same recording, held on the moment the agent reads the phone number back digit by
digit and the caller answers. Overlay the two lines of text as they are spoken.

Let about eight seconds of the real exchange play, then say:

> The agent did not write that sentence. The server normalised the number, built the readback itself,
> and handed it over to be said word for word. A yes is only accepted for the exact value that was
> read back.

## Shot 4. The chart that comes out

**1:10 to 1:38, 28 seconds. Screen capture.**

On screen: the finished chart shown back to the caller. Hold on the counts line first, then scroll
slowly down the seven fields.

Say:

> This is what the clinic receives. Seven fields, five of them critical. Every line carries a grade
> and, where it is not verified, the reason. That grade is the worse of two hearings. One is the live
> conversation. The other is the recording, transcribed a second time on its own, with the caller and
> the agent on separate channels and a confidence score on every word.

## Shot 5. The field that is not green, which is the point

**1:38 to 2:04, 26 seconds. Screen capture.**

On screen: zoom to the line marked "to check", with its reason text visible in full.

Say:

> Here is the one that matters. The model reported this field as confirmed. After the call, the chart
> is rebuilt from the session record, and that confirmation was checked against what actually
> happened. The caller never agreed to it. So it is not green, it says why, and the desk can ring back
> about one line instead of the whole call. A product that hides this is a product that hands a clinic
> a wrong chart with a confident face on it.

## Shot 6. What the front desk sees

**2:04 to 2:24, 20 seconds. Screen capture.**

On screen: the clinic desk, signed in, showing the list of finished calls with their counts, then one
call opened.

Say:

> The desk signs in with a clinic code and sees the day's calls, newest first, with the counts on each
> line. Anything amber or red is the reason to open it. A clinic can act on a call where every
> critical field is green without calling anyone back.

## Shot 7. The evidence

**2:24 to 2:46, 22 seconds. Screen capture of a terminal.**

On screen: `npm run verify` finishing green, then the evaluation table from `npx vitest run
tests/evals`. Do not speed the terminal up beyond what stays readable.

Say:

> Three hundred and fourteen tests, at one hundred percent statements, branches, functions and lines.
> Twenty three scripted cases across live grading, the recording, the confidence thresholds, the
> readback rule and the medication lookup. All twenty three pass. The harness found a real defect
> before any of this: a yes given to one field could confirm the next one. It was fixed, and that case
> is still in the list.

## Shot 8. Where it actually stands

**2:46 to 2:58, 12 seconds. Screen capture.**

On screen: the repository's "what is not built yet" list, held still.

Say:

> Nothing is deployed and there is no number to dial yet. That is written down in the repository next
> to everything else that is missing. What works, works for real.

## Which shots need what

| Shot | Source                                            |
| ---- | ------------------------------------------------- |
| 1    | Screen capture                                    |
| 2    | Real recording of a live call, with its own audio |
| 3    | Real recording for the audio, overlay added after |
| 4    | Screen capture                                    |
| 5    | Screen capture                                    |
| 6    | Screen capture                                    |
| 7    | Screen capture of a terminal                      |
| 8    | Screen capture                                    |

## Things not to do in this video

- Do not show a phone number on screen. There is not one yet.
- Do not show a real person's details. The clinic and everyone in it are fictional, and the caller is
  synthetic.
- Do not cut the amber field out to make the chart look clean. It is the demonstration.
- Do not claim a latency, a cost or an accuracy figure that is not on screen in the shot.
