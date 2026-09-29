import "server-only";
import { z } from "zod";

/**
 * The environment, checked once and read from here only.
 *
 * Secrets are required to be long enough to be secrets. Redis is optional:
 * without it the deployment runs on in-memory stores, which is right for a
 * laptop and wrong for serverless, and `/api/health` reports which it is as
 * `stores`. Messaging is optional the same way: without it the agent stops
 * promising a text it cannot send.
 */

const secret = z.string().min(32, "must be at least 32 characters");

const envSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
  /** Derives each clinic's tool key. */
  TWICEHEARD_SECRET: secret,
  /** Signs AssemblyAI webhook deliveries; set the same value on the subscription. */
  TWICEHEARD_WEBHOOK_SECRET: secret,
  /** The stored agent that answers for the demo clinic. */
  TWICEHEARD_AGENT_ID: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),
  /** All three together, or none: a booking text needs an account, a token and a number. */
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "must be an E.164 number, like +14155550123")
    .optional(),
});

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * A group of variables that only means anything whole. Half a pair is a typo,
 * not a decision to run without the thing, and treating it as a decision is how
 * a deployment ends up silently on in-memory stores or silently unable to text.
 */
function readGroup<T extends Record<string, string | undefined>>(
  group: T,
): { [K in keyof T]: string } | null {
  const entries = Object.entries(group);
  const given = entries.filter(([, value]) => value !== undefined);
  if (given.length === 0) return null;
  if (given.length !== entries.length) {
    throw new EnvError(entries.map(([name]) => name).join(", "));
  }
  return Object.fromEntries(given) as { [K in keyof T]: string };
}

/** Either pair names the same database, so the first one set wins whole. */
function readRedis(env: ParsedEnv): ServerEnv["redis"] {
  const upstash = readGroup({
    UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
  });
  if (upstash) {
    return { url: upstash.UPSTASH_REDIS_REST_URL, token: upstash.UPSTASH_REDIS_REST_TOKEN };
  }
  const kv = readGroup({
    KV_REST_API_URL: env.KV_REST_API_URL,
    KV_REST_API_TOKEN: env.KV_REST_API_TOKEN,
  });
  return kv ? { url: kv.KV_REST_API_URL, token: kv.KV_REST_API_TOKEN } : null;
}

export interface ServerEnv {
  assemblyAiKey: string;
  secret: string;
  webhookSecret: string;
  agentId: string | undefined;
  redis: { url: string; token: string } | null;
  sms: { accountSid: string; authToken: string; from: string } | null;
}

export class EnvError extends Error {
  constructor(readonly variables: string) {
    super(`environment variables missing or invalid: ${variables}`);
    this.name = "EnvError";
  }
}

export function readEnv(source: Record<string, string | undefined>): ServerEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
  }
  const env = parsed.data;
  const twilio = readGroup({
    TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
    TWILIO_NUMBER: env.TWILIO_NUMBER,
  });
  return {
    assemblyAiKey: env.ASSEMBLYAI_API_KEY,
    secret: env.TWICEHEARD_SECRET,
    webhookSecret: env.TWICEHEARD_WEBHOOK_SECRET,
    agentId: env.TWICEHEARD_AGENT_ID,
    redis: readRedis(env),
    sms: twilio
      ? {
          accountSid: twilio.TWILIO_ACCOUNT_SID,
          authToken: twilio.TWILIO_AUTH_TOKEN,
          from: twilio.TWILIO_NUMBER,
        }
      : null,
  };
}
