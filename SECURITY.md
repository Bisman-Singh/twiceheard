# Security

## Reporting a vulnerability

Please open a private security advisory on this repository. On GitHub that is the **Security** tab,
then **Report a vulnerability**. It creates a private thread with the maintainer.

Do not open a public issue, a pull request or a discussion for a vulnerability. There is no bounty.
Include what you did, what happened, and what you expected. A minimal reproduction helps more than a
scanner report.

Twiceheard is a demonstration. It holds no production data, and callers are told
not to give real medical details. Reports are still welcome.

## What the code enforces

Everything below is in the repository and covered by tests in `tests/`.

### Every endpoint decides for itself who may call it

None of these trusts the client to say who it is.

| Route                               | What authorises the request                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/voice/session`           | Same-origin check, then a per-address rate limit.                                                    |
| `POST /api/voice/tool`              | Same-origin check, the signed call grant cookie, and a per-grant rate limit.                         |
| `POST /api/tools/{clinicId}/{tool}` | The clinic's derived tool key, compared in constant time.                                            |
| `POST /api/call/claim`              | Same-origin check, then the grant cookie. This is the only route that may take ownership.            |
| `POST /api/call/result`             | Same-origin check, the grant cookie, a per-owner rate limit, and an ownership check that only reads. |
| `POST /api/call/forget`             | Same as the result route, and the store compares the clinic on the record before deleting.           |
| `POST /api/webhooks/assemblyai`     | An HMAC signature over the exact raw body.                                                           |
| `GET /api/health`                   | None. It returns shape only: whether the environment parsed and whether the stores are shared.       |

The desk is not an API route but it is an authenticated surface, and the highest-value read in the
app, because it lists every finished call for a clinic. `/desk` and `/desk/calls/{sessionId}` read a
signed session cookie on the server (`lib/desk/session.ts`). A page never takes a clinic from the URL
or from anything a browser can set, and a record whose clinic differs from the signed-in one is
`notFound()`, which is also what a signed-out visitor gets, so the two cannot be told apart from
outside. Signing in exchanges a per-clinic code, derived from the server secret, for that cookie, and
the attempt is rate limited by address.

The two tool routes run the same handlers with the same clinic-scoped dependencies. The route decides
who is asking; `lib/tools/handlers.ts` decides what happens.

### Same-origin check

`assertSameOrigin` in `lib/http/guard.ts` accepts a request whose `Sec-Fetch-Site` is `same-origin`
or `none`, which is a direct navigation. Failing that, it accepts a request whose `Origin` header
parses to exactly the `Host` header. Anything else gets 403 `forbidden_origin`. An unparsable
`Origin` is rejected rather than ignored.

The tool endpoint for the phone path deliberately does not use this check. AssemblyAI calls it from
its own servers, so origin means nothing there and the key is the proof instead.

### The browser call grant

A browser cannot hold the clinic's tool key, so a call started from this site gets a short-lived
signed grant instead (`lib/security/call-grant.ts`).

- The value is `{clinicId}.{expiresAt}.{signature}`, where the signature is HMAC-SHA256 over
  `call-grant:{clinicId}.{expiresAt}` keyed by `TWICEHEARD_SECRET`.
- It lives 20 minutes. `readCallGrant` returns the clinic only when the signature verifies and the
  expiry is in the future, and it compares the signature in constant time.
- It is set as the `twiceheard_call` cookie with `HttpOnly`, `SameSite=Strict`, `Path=/` and a
  `Max-Age` matching the grant. `Secure` is added when `NODE_ENV` is `production`, because localhost
  is a secure context but is not served over https in development.
- Page JavaScript cannot read it, and `SameSite=Strict` keeps another site from sending it.

### One server secret, one key per clinic

`toolKeyFor` in `lib/security/keys.ts` derives a clinic's tool key as HMAC-SHA256 over
`tool-key:{clinicId}`, keyed by `TWICEHEARD_SECRET`. No per-clinic key is stored anywhere.

Rotating the one secret rotates every clinic at once, and a leaked clinic key cannot be used to work
out another clinic's. The key travels in the `x-twiceheard-tool-key` header, which the platform stores
write-only on the stored agent. The route compares it with `timingSafeEqual` on equal-length buffers,
before it reads the request body.

### Webhook signatures

`validWebhookSignature` recomputes `sha256=<hex HMAC-SHA256 of the raw body>` with
`TWICEHEARD_WEBHOOK_SECRET` and compares it with the `x-aai-signature` header in constant time. The
webhook route reads the raw text, checks the length cap, verifies the signature, and only then parses
the JSON. Nothing in the body influences anything before the signature is verified.

Deliveries are deduplicated by `event_id` and remembered for 24 hours, so a retry is acknowledged
without doing the work twice. Post-call processing runs after the response has been sent.

### One caller cannot read another caller's chart

A platform session id is the only handle a browser has on its own call, and it is not a secret.

- The moment the call goes live, the page claims the session (`POST /api/call/claim`). The claim
  stores an owner derived as HMAC-SHA256 over `call-owner:{grant}`, so the grant itself never leaves
  the cookie jar.
- The claim is a `SET NX`, which Redis runs atomically, and the in-memory equivalent behaves the same
  way. First claim wins. A second browser gets 409.
- **Claiming and checking are separate.** Reading a chart and deleting one both use a check that only
  reads the owner, so asking about a call can never make the asker its owner. Only `/api/call/claim`
  may take ownership, and only while a call is live.
- A call that no browser claimed has no owner, and a call that arrived over the phone never has one.
  Those records are not readable or deletable through the caller's endpoints at all; they belong to
  the clinic and are read at the desk.
- Even with a matching owner, a saved record whose `clinicId` differs from the grant's clinic is not
  returned.
- The owner record expires after one hour. After that the record is no longer reachable through the
  caller's endpoints by anyone, which is the safe direction to fail in.

### Rate limits

`lib/http/rate-limit.ts` holds the limits and a sliding-window limiter kept in process memory.
`lib/http/shared-rate-limit.ts` puts the same window in Redis when Redis is configured, so the limit
means the same thing from every instance.

- Starting a call: 5 per client address per 10 minutes. A token is credit on the voice platform, and a
  public page is otherwise an open tap. The limit is checked before the body is parsed, so an invalid
  request still counts.
- Asking for a result: 60 per owner per 10 minutes. The page polls while its chart is being worked out.
- Relaying a tool call: 80 per grant per 10 minutes. A grant is free to obtain, so the meter belongs on
  using a call as well as on starting one. Without it, one grant could drive the clinic's whole
  appointment diary. An intake also records the browser that started it, so one browser cannot drive
  another's intake even within the limit.
- Signing in at the desk: 5 per client address per 10 minutes.

The in-memory limiter tracks at most 10,000 addresses. A flood of fresh addresses evicts the oldest
rather than growing memory.

### Every body is validated

`readJson` checks the declared `Content-Length`, reads the text, checks the real length, parses the
JSON, and validates it against a zod schema. Each failure has its own status: 413 `payload_too_large`,
400 `invalid_json`, 400 `invalid_request`.

Body caps are per route: 1 KiB for a session request, 16 KiB for a tool call, 2 KiB for a claim or a
result request, 64 KiB for a webhook delivery. Route schemas are `strictObject` where the shape is
fixed, so an unexpected field is an error rather than something ignored.

Tool arguments get a second layer in `lib/tools/handlers.ts`: a schema per tool, with length caps on
every string. A bad argument never throws on a live call; it comes back as a sentence telling the
agent what to do instead, because a thrown error on a phone call is a silence the caller has to sit
through.

### The model is never trusted

- A value is normalised server-side before it is stored, and the readback sentence is built from the
  normalised value by `lib/intake/readback.ts`, not by the model.
- A field cannot be confirmed unless that exact value was read back first. After the call the whole
  conversation is on record, so each confirmation is re-checked against it, and one that does not hold
  up is downgraded.
- A booking is refused until the name, date of birth and phone number are confirmed.
- A slot id is parsed and matched against the times the clinic actually offers at that moment, so the
  model can only book something this app produced. Claiming a slot is atomic, so two callers cannot
  take the same time.
- A medication lookup can correct a spelling, never swap a drug. Beyond one edit per four letters, at
  most two, the caller's own word is kept and flagged.

### Content Security Policy and other headers

`proxy.ts` sets a per-request CSP with a fresh nonce, which lets the policy drop `'unsafe-inline'` for
scripts entirely. Only the scripts Next.js emits for that exact response may run. Pages therefore
render dynamically.

```
default-src 'self'; script-src 'self' 'nonce-...' 'strict-dynamic'; style-src 'self' 'nonce-...';
img-src 'self' blob:; font-src 'self'; connect-src 'self' wss://agents.assemblyai.com;
media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
```

The one outside connection allowed is the Voice Agent API's WebSocket. In development the policy also
allows `'unsafe-eval'` for scripts and inline styles, which the dev tooling needs; production gets
neither. API routes are excluded from the matcher, because they return JSON and set no scripts.

`next.config.ts` adds the headers that do not vary per request: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` and a
two-year HSTS. `poweredByHeader` is off. Every `/api/*` response carries `Cache-Control: no-store`, so
no shared cache or proxy keeps a copy of a patient's call.

### What is never logged

- A tool call logs the clinic id, the tool name, whether it succeeded and how long it took. Arguments
  and results are not logged, because both can hold a patient's details.
- Voice Agent API errors carry the HTTP status and the platform's error code truncated to 80
  characters. The API key is never logged, and neither is a request body.
- A post-call failure logs the session id, the attempt number and the error's class name.
- An unhandled route error is logged server-side and answered with a generic message, so a platform
  error never reaches the caller as detail.
- ESLint bans `console.log` outright; only `warn` and `error` are allowed outside `scripts/`.

### What is never stored

- No audio. The recording stays in the voice platform's session store, and the second hearing reads it
  from there by link.
- No full transcript. The second hearing's transcript is deleted from AssemblyAI once the words have
  been scored, on every path including a timeout, and the call record keeps a verdict and a confidence
  per field rather than the words.
- No secret in a tracked file, no secret in a `NEXT_PUBLIC_` variable, and no API key in the client
  bundle. The browser gets a token minted server-side that can be redeemed for 60 seconds and opens a
  session capped at 15 minutes.

The call record does keep the chart values themselves, which are patient details, and two short pieces
of quoted speech: the escalation reason the model wrote, capped at 300 characters, and, when a caller
did not agree to a readback, up to 200 characters of what they said at that moment. `docs/privacy.md`
covers retention.

### Supply chain

Dependencies are pinned to exact versions. GitHub Actions are pinned by commit SHA. CI runs gitleaks
over the full history, `npm audit --audit-level=high`, and CodeQL with the `security-and-quality`
queries on every push, every pull request and weekly. Dependabot proposes grouped minor and patch
updates; majors are reviewed by hand.

## Known limits

These are design decisions, written down rather than hidden.

- The shared rate limiter fails open. If Redis cannot be reached the request is allowed and a warning
  is logged, because a clinic line that stops answering is worse than one that is briefly too
  generous.
- Without Redis, every limit and every store is per instance. That is correct on a laptop and wrong on
  serverless, and `lib/server/env.ts` is where a deployment says which it has.
- The client address falls back to the first `X-Forwarded-For` entry when `X-Real-IP` is absent. On a
  host that does not set `X-Real-IP` from the connection, a client can forge that fallback.
- The desk signs in with one code per clinic, not per person. There are no accounts, no roles and no
  record of who read what. A clinic that wanted an audit trail would need all three.
- A body's size is enforced by counting the bytes as they are read, not by trusting the declared
  length, but the bytes up to the cap are still buffered in memory before the cap trips.
- The second hearing on the caller's own path is bounded to fit inside that route's time budget. A
  hearing that takes longer is abandoned, its transcript deleted, and the page asks again, which can
  mean a recording is submitted for transcription more than once.
- Artifact links are followed only over https and only to the platform's own hosts.
