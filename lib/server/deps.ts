import "server-only";
import { Redis } from "@upstash/redis";
import { demoRegistry, type ClinicRegistry } from "@/lib/clinic/registry";
import { memoryIntakeStore, type IntakeStore } from "@/lib/intake/store";
import { createSharedRateLimiter } from "@/lib/http/shared-rate-limit";
import {
  CALL_START_LIMIT,
  DESK_SIGN_IN_LIMIT,
  RESULT_CHECK_LIMIT,
  TOOL_CALL_LIMIT,
  RateLimiter,
  type RequestLimiter,
} from "@/lib/http/rate-limit";
import { createRxNormLookup, type MedicationLookup } from "@/lib/medication/rxnorm";
import { refusingMessenger, twilioMessenger, type Messenger } from "@/lib/notify/sms";
import { memoryCallStore, type CallStore } from "@/lib/postcall/record";
import { readEnv, type ServerEnv } from "@/lib/server/env";
import {
  memoryFirstDelivery,
  memorySessionOwners,
  redisCallStore,
  redisFirstDelivery,
  redisIntakeStore,
  redisSessionOwners,
  type SessionOwners,
  type FirstDelivery,
  type RedisLike,
} from "@/lib/store/redis";
import { createSecondHearingClient, type SecondHearingClient } from "@/lib/verify/transcribe";
import { createVoiceAgentClient, type VoiceAgentClient } from "@/lib/voice-agent/client";

/**
 * Everything a route needs, built once per server instance.
 *
 * Routes never construct clients or stores; they ask for these. Tests swap
 * the whole set with `setServerDeps`, so every route is exercised against
 * fakes with no network and no Redis.
 */
export interface ServerDeps {
  env: ServerEnv;
  clinics: ClinicRegistry;
  intakes: IntakeStore;
  calls: CallStore;
  firstDelivery: FirstDelivery;
  sessions: SessionOwners;
  medications: MedicationLookup;
  sms: Messenger;
  voice: VoiceAgentClient;
  hearing: SecondHearingClient;
  /** The same second hearing, bounded to fit inside the caller-facing route's budget. */
  quickHearing: SecondHearingClient;
  callStarts: RequestLimiter;
  resultChecks: RequestLimiter;
  deskSignIns: RequestLimiter;
  toolCalls: RequestLimiter;
  now: () => Date;
}

/**
 * Held on the process, not in this module. A framework compiles server
 * components and route handlers separately, so a module-level value is not one
 * value, and the in-memory stores would differ between a page and the API that
 * wrote to them. With Redis configured the stores are shared anyway; this is
 * what makes a laptop behave like one deployment.
 */
const SHARED = Symbol.for("twiceheard.server-deps");
const holder = globalThis as { [SHARED]?: ServerDeps };

export function serverDeps(): ServerDeps {
  holder[SHARED] ??= buildDeps(readEnv(process.env));
  return holder[SHARED];
}

/** Replace the shared dependencies; tests only. */
export function setServerDeps(next: ServerDeps | null): void {
  if (next) holder[SHARED] = next;
  else delete holder[SHARED];
}

/**
 * Without a provider the messenger refuses rather than pretending. The booking
 * still stands and the agent tells the caller the front desk will confirm by
 * phone, instead of promising a text that is never going to arrive.
 */
function messenger(env: ServerEnv): Messenger {
  return env.sms ? twilioMessenger(env.sms) : refusingMessenger();
}

/**
 * One retry, fifty milliseconds apart.
 *
 * The client's own default is six attempts with exponential backoff, about 4.3
 * seconds of sleeping per command. `save_field` runs two commands, and it is the
 * one tool the platform holds in silence with an eight second limit, so the
 * default turns a brief Redis problem into nine seconds of dead air on a live
 * call and a failed tool anyway. A blip should cost a field, not the call.
 *
 * A per-request timeout would be better still and is not available here: this
 * client takes a single `AbortSignal`, and one signal shared by every command
 * would abort all of them for good the first time it fired.
 */
export const REDIS_RETRY = { retries: 1, backoff: () => 50 } as const;

export function buildDeps(env: ServerEnv): ServerDeps {
  const redis = env.redis
    ? (new Redis({ ...env.redis, retry: REDIS_RETRY }) as unknown as RedisLike & Redis)
    : null;
  return {
    env,
    clinics: demoRegistry(env.agentId),
    intakes: redis ? redisIntakeStore(redis) : memoryIntakeStore(),
    calls: redis ? redisCallStore(redis) : memoryCallStore(),
    firstDelivery: redis ? redisFirstDelivery(redis) : memoryFirstDelivery(),
    sessions: redis ? redisSessionOwners(redis) : memorySessionOwners(),
    medications: createRxNormLookup(),
    sms: messenger(env),
    voice: createVoiceAgentClient(env.assemblyAiKey),
    hearing: createSecondHearingClient(env.assemblyAiKey),
    // A caller's own request cannot outlive its function, or the transcript it asked for
    // would be left behind at the transcriber with nothing to delete it.
    quickHearing: createSecondHearingClient(env.assemblyAiKey, fetch, { deadlineMs: 45_000 }),
    callStarts: redis
      ? createSharedRateLimiter(redis, CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs)
      : new RateLimiter(CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs),
    resultChecks: redis
      ? createSharedRateLimiter(redis, RESULT_CHECK_LIMIT.limit, RESULT_CHECK_LIMIT.windowMs)
      : new RateLimiter(RESULT_CHECK_LIMIT.limit, RESULT_CHECK_LIMIT.windowMs),
    toolCalls: redis
      ? createSharedRateLimiter(redis, TOOL_CALL_LIMIT.limit, TOOL_CALL_LIMIT.windowMs)
      : new RateLimiter(TOOL_CALL_LIMIT.limit, TOOL_CALL_LIMIT.windowMs),
    deskSignIns: redis
      ? createSharedRateLimiter(redis, DESK_SIGN_IN_LIMIT.limit, DESK_SIGN_IN_LIMIT.windowMs)
      : new RateLimiter(DESK_SIGN_IN_LIMIT.limit, DESK_SIGN_IN_LIMIT.windowMs),
    now: () => new Date(),
  };
}
