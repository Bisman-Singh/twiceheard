import "server-only";
import { z } from "zod";

/**
 * The environment, checked once and read from here only.
 *
 * Secrets are required to be long enough to be secrets. Redis is optional:
 * without it the deployment runs on in-memory stores, which is right for a
 * laptop and wrong for serverless, and `storesAreShared` says which it is.
 */

const secret = z.string().min(32, "must be at least 32 characters");

const envSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1),
  /** Derives each clinic's tool key. */
  EARSHOT_SECRET: secret,
  /** Signs AssemblyAI webhook deliveries; set the same value on the subscription. */
  EARSHOT_WEBHOOK_SECRET: secret,
  /** The stored agent that answers for the demo clinic. */
  EARSHOT_AGENT_ID: z.string().min(1).optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().min(1).optional(),
});

export interface ServerEnv {
  assemblyAiKey: string;
  secret: string;
  webhookSecret: string;
  agentId: string | undefined;
  redis: { url: string; token: string } | null;
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
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  return {
    assemblyAiKey: env.ASSEMBLYAI_API_KEY,
    secret: env.EARSHOT_SECRET,
    webhookSecret: env.EARSHOT_WEBHOOK_SECRET,
    agentId: env.EARSHOT_AGENT_ID,
    redis: url && token ? { url, token } : null,
  };
}
