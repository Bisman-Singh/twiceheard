# Evaluation harness

Scripted calls, run through the product's own grading code, to prove the rules still hold.

Nothing here talks to a network, a clock or a file. Each case is a situation that can happen
on a call, written as the input the product really receives: either the agent's tool reports,
or a whole call record replayed afterwards, together with the caller's side of the second
hearing. The case states the grade and the reason every field must end with, so a change in
wording fails the run rather than drifting past it.

## Running it

```bash
npx vitest run tests/evals              # green means every case matched
EVALS_REPORT=1 npx vitest run tests/evals   # also writes the table below
```

A failing run prints the same table in the assertion message, so the difference is on screen
without a second command.

## Reading the table

| Column         | What it holds                                                      |
| -------------- | ------------------------------------------------------------------ |
| Case           | The case id, which is also how you find it in `lib/evals/cases.ts` |
| What it checks | The situation in one line                                          |
| Expected       | The grade and reason each field under test must end with           |
| Actual         | What the product gave                                              |
| Result         | `pass` or `fail`                                                   |

A cell reads `field=grade (reason)`, joined with semicolons, followed by any confirmation the
call record does not support and then `ready=true` or `ready=false`. `ready` is the product's
own answer to whether every critical field is green, so the clinic can act without calling
back. Medication cases carry a match instead of a grade: `exact`, `suggestion` or `none`.

The second table counts cases and passes per category: `live` for the conversation alone,
`recording` for the second hearing, `confidence` for the two confidence thresholds, `readback`
for what the call record proves about a yes, and `medication` for the lookup rule. The last
line is the pass rate.

## Adding a case

Add it to `EVAL_CASES` in `lib/evals/cases.ts` with a new id and a category. Nothing else needs
touching: `lib/evals/run.ts` runs whatever the list holds.

A case that fails because the product is wrong stays in the list and stays failing. That is the
point of the harness, and the fix belongs in the product.
