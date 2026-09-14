import "server-only";
import { Redis } from "@upstash/redis";
import { demoRegistry, type ClinicRegistry } from "@/lib/clinic/registry";
import { memoryIntakeStore, type IntakeStore } from "@/lib/intake/store";
import { createSharedRateLimiter } from "@/lib/http/shared-rate-limit";
import { CALL_START_LIMIT, RateLimiter, type RequestLimiter } from "@/lib/http/rate-limit";
import { createRxNormLookup, type MedicationLookup } from "@/lib/medication/rxnorm";
import { recordingMessenger, type Messenger } from "@/lib/notify/sms";
import { memoryCallStore, type CallStore } from "@/lib/postcall/record";
import { readEnv, type ServerEnv } from "@/lib/server/env";
import {
  memoryFirstDelivery,
  redisCallStore,
  redisFirstDelivery,
  redisIntakeStore,
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
  medications: MedicationLookup;
  sms: Messenger;
  voice: VoiceAgentClient;
  hearing: SecondHearingClient;
  callStarts: RequestLimiter;
  now: () => Date;
}

let deps: ServerDeps | null = null;

export function serverDeps(): ServerDeps {
  deps ??= buildDeps(readEnv(process.env));
  return deps;
}

/** Replace the shared dependencies; tests only. */
export function setServerDeps(next: ServerDeps | null): void {
  deps = next;
}

export function buildDeps(env: ServerEnv): ServerDeps {
  const redis = env.redis ? (new Redis(env.redis) as unknown as RedisLike & Redis) : null;
  return {
    env,
    clinics: demoRegistry(env.agentId),
    intakes: redis ? redisIntakeStore(redis) : memoryIntakeStore(),
    calls: redis ? redisCallStore(redis) : memoryCallStore(),
    firstDelivery: redis ? redisFirstDelivery(redis) : memoryFirstDelivery(),
    medications: createRxNormLookup(),
    // Texts are recorded, not sent, until a messaging provider is configured.
    sms: recordingMessenger(),
    voice: createVoiceAgentClient(env.assemblyAiKey),
    hearing: createSecondHearingClient(env.assemblyAiKey),
    callStarts: redis
      ? createSharedRateLimiter(redis, CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs)
      : new RateLimiter(CALL_START_LIMIT.limit, CALL_START_LIMIT.windowMs),
    now: () => new Date(),
  };
}
