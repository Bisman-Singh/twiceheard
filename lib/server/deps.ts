import "server-only";
import { Redis } from "@upstash/redis";
import { demoRegistry, type ClinicRegistry } from "@/lib/clinic/registry";
import { memoryIntakeStore, type IntakeStore } from "@/lib/intake/store";
import { createSharedRateLimiter } from "@/lib/http/shared-rate-limit";
import {
  CALL_START_LIMIT,
  DESK_SIGN_IN_LIMIT,
  RESULT_CHECK_LIMIT,
  RateLimiter,
  type RequestLimiter,
} from "@/lib/http/rate-limit";
import { createRxNormLookup, type MedicationLookup } from "@/lib/medication/rxnorm";
import { recordingMessenger, type Messenger } from "@/lib/notify/sms";
import { memoryCallStore, type CallStore } from "@/lib/postcall/record";
import { readEnv, type ServerEnv } from "@/lib/server/env";
import {
  memoryFirstDelivery,
  memorySessionOwner,
  redisCallStore,
  redisFirstDelivery,
  redisIntakeStore,
  redisSessionOwner,
  type ClaimSession,
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
  claimSession: ClaimSession;
  medications: MedicationLookup;
  sms: Messenger;
  voice: VoiceAgentClient;
  hearing: SecondHearingClient;
  callStarts: RequestLimiter;
  resultChecks: RequestLimiter;
  deskSignIns: RequestLimiter;
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

export function buildDeps(env: ServerEnv): ServerDeps {
  const redis = env.redis ? (new Redis(env.redis) as unknown as RedisLike & Redis) : null;
  return {
    env,
    clinics: demoRegistry(env.agentId),
    intakes: redis ? redisIntakeStore(redis) : memoryIntakeStore(),
    calls: redis ? redisCallStore(redis) : memoryCallStore(),
    firstDelivery: redis ? redisFirstDelivery(redis) : memoryFirstDelivery(),
    claimSession: redis ? redisSessionOwner(redis) : memorySessionOwner(),
    medications: createRxNormLookup(),
    // Texts are recorded, not sent, until a messaging provider is configured.
    sms: recordingMessenger(),
    voice: createVoiceAgentClient(env.assemblyAiKey),
    hearing: createSecondHearingClient(env.assemblyAiKey),
    callStarts: redis
      ? createSharedRateLimiter(redis, CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs)
      : new RateLimiter(CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs),
    resultChecks: redis
      ? createSharedRateLimiter(redis, RESULT_CHECK_LIMIT.limit, RESULT_CHECK_LIMIT.windowMs)
      : new RateLimiter(RESULT_CHECK_LIMIT.limit, RESULT_CHECK_LIMIT.windowMs),
    deskSignIns: redis
      ? createSharedRateLimiter(redis, DESK_SIGN_IN_LIMIT.limit, DESK_SIGN_IN_LIMIT.windowMs)
      : new RateLimiter(DESK_SIGN_IN_LIMIT.limit, DESK_SIGN_IN_LIMIT.windowMs),
    now: () => new Date(),
  };
}
