# Deploying Twiceheard

The order matters. The stored agent has to know the deployment's address before the platform can
call a tool, and the deployment has to know the agent's id before a browser call uses it.

## 1. Shared stores

Without Redis the app keeps intakes, slot claims and call records in the process that served the
request. On a laptop that is one process and everything works. On serverless it is not: the tool
call that saves a field and the request that reads the chart can land on different instances, and
the call falls apart. Configure Redis before the first real call.

Set either pair, they are read the same way:

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- `KV_REST_API_URL` and `KV_REST_API_TOKEN`

`GET /api/health` reports `stores: "shared"` once it is configured, and `"in-process"` until then.

## 2. Environment

| Variable                    | Value                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- |
| `ASSEMBLYAI_API_KEY`        | The platform key. Server side only, never a build-time public.                    |
| `TWICEHEARD_SECRET`         | 32 characters or more. Rotating it rotates every clinic's tool key and desk code. |
| `TWICEHEARD_WEBHOOK_SECRET` | 32 characters or more. The same value goes on the webhook subscription.           |
| `TWICEHEARD_AGENT_ID`       | Set in step 4, once the agent exists.                                             |
| Redis pair                  | Step 1.                                                                           |

Generate each secret with `openssl rand -hex 32` and never reuse one between environments.

## 3. Deploy

Build and deploy to production. Preview deployments sit behind the platform's own authentication,
so the voice platform cannot reach a preview's tool endpoints. Only production works for a real call.

## 4. The stored agent

From a checkout, with `.env.local` holding the key and the secret:

```bash
node --import ./scripts/alias-hook.mjs scripts/setup-agent.ts --base-url https://YOUR-DOMAIN
```

That prints what it would send and writes the agent body to a file. Nothing is created. Read the
tool URLs it prints, confirm they point at the deployment, then run it again with `--apply`.

Put the agent id it returns into the deployment's environment as `TWICEHEARD_AGENT_ID` and deploy
again. A browser call then runs the stored agent instead of configuring one inline.

## 5. A phone number

The platform takes calls over SIP, so the number's carrier has to send them there.

1. Create a SIP trunk with the carrier and point its origination at `sip:sip.assemblyai.com`.
2. Attach the number to that trunk.
3. Run step 4 again with `--number +NNNNNNNNNNN --termination-uri YOUR-TRUNK.pstn.example --apply`.

The carrier bills the inbound minutes and the platform bills the session, so a number that is
published anywhere should have a spend cap on both sides before it is announced.

## 6. The completion webhook

Subscribe the platform's session completion event to `https://YOUR-DOMAIN/api/webhooks/assemblyai`
and set the subscription's signing secret to `TWICEHEARD_WEBHOOK_SECRET`. Deliveries are verified
by HMAC and a delivery id is remembered so a retry cannot process a call twice.

Without the webhook nothing breaks: a caller's own page asks for its chart and the work happens
then. The webhook is what makes a chart appear at the desk for a call nobody is watching.

## 7. Checks after deploying

```bash
curl -s https://YOUR-DOMAIN/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-DOMAIN/            # 200
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-DOMAIN/no-such-page # 404
```

Then make one browser call at `/call`, watch the chart come back, and open `/desk` with the clinic
code to confirm the same call is listed there.

## Why the region is pinned

`vercel.json` pins the functions to `iad1`. Every tool call on a live phone call is made by the
voice platform, whose agent and phone APIs are on its US host, and the caller waits in silence while
that round trip happens. Putting the functions next to the platform keeps that trip short. Create
the Redis database in the same region for the same reason: a tool handler reads the intake and
writes it back, so a distant store costs the caller two crossings per saved value.

The caller's own browser only fetches a session once, at the start, so its distance from the
functions costs one request, not one per turn.
