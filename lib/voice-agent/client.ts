import "server-only";
import { z } from "zod";
import type { AgentBody } from "@/lib/voice-agent/agent";

/**
 * The Voice Agent API's REST side: tokens, stored agents, sessions, phone
 * numbers and webhooks.
 *
 * `fetch` is injected so tests never touch the network. Every call has a
 * deadline. Errors carry the status and the platform's error code, never the
 * key and never a request body, which may hold a patient's words.
 */

export const AGENTS_BASE_URL = "https://agents.assemblyai.com";
/** Phone numbers are managed on the US host. */
export const PHONE_BASE_URL = "https://agents.us.assemblyai.com";

const TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class VoiceAgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Voice Agent API ${status} ${code}`);
    this.name = "VoiceAgentApiError";
  }
}

const tokenSchema = z.object({ token: z.string().min(1) });
const agentSchema = z.object({ id: z.string().min(1), name: z.string() });
const artifactSchema = z.object({
  type: z.enum(["audio", "timeline", "metadata"]),
  url: z.string().url(),
  content_type: z.string().optional(),
});
const sessionSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable(),
  status: z.string(),
  duration_seconds: z.number().nullable().optional(),
  artifacts: z.array(artifactSchema).default([]),
});
const errorSchema = z.object({ code: z.string().optional(), error: z.string().optional() });

export type StoredAgent = z.infer<typeof agentSchema>;
export type SessionDetail = z.infer<typeof sessionSchema>;

export interface TokenOptions {
  /** How long the token can be redeemed, 1 to 600 seconds. */
  expiresInSeconds: number;
  /** Hard cap on the session the token opens, 60 to 10800 seconds. */
  maxSessionSeconds: number;
}

export interface VoiceAgentClient {
  mintToken(options: TokenOptions): Promise<string>;
  createAgent(body: AgentBody): Promise<StoredAgent>;
  updateAgent(agentId: string, body: Partial<AgentBody>): Promise<StoredAgent>;
  getSession(sessionId: string): Promise<SessionDetail>;
  importPhoneNumber(
    phoneNumber: string,
    terminationUri: string,
    idempotencyKey: string,
  ): Promise<void>;
  bindPhoneNumber(phoneNumber: string, agentId: string): Promise<void>;
}

export function createVoiceAgentClient(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): VoiceAgentClient {
  if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not set");

  async function call(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    const body: unknown = text ? safeJson(text) : null;
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      const code = parsed.success ? (parsed.data.code ?? parsed.data.error ?? "error") : "error";
      throw new VoiceAgentApiError(response.status, code.slice(0, 80));
    }
    return body;
  }

  return {
    async mintToken({ expiresInSeconds, maxSessionSeconds }) {
      const query = new URLSearchParams({
        expires_in_seconds: String(clamp(expiresInSeconds, 1, 600)),
        max_session_duration_seconds: String(clamp(maxSessionSeconds, 60, 10_800)),
      });
      return tokenSchema.parse(await call(`${AGENTS_BASE_URL}/v1/token?${query}`)).token;
    },
    async createAgent(body) {
      const init = { method: "POST", body: JSON.stringify(body) };
      return agentSchema.parse(await call(`${AGENTS_BASE_URL}/v1/agents`, init));
    },
    async updateAgent(agentId, body) {
      const init = { method: "PUT", body: JSON.stringify(body) };
      return agentSchema.parse(
        await call(`${AGENTS_BASE_URL}/v1/agents/${encodeURIComponent(agentId)}`, init),
      );
    },
    async getSession(sessionId) {
      return sessionSchema.parse(
        await call(`${AGENTS_BASE_URL}/v1/sessions/${encodeURIComponent(sessionId)}`),
      );
    },
    async importPhoneNumber(phoneNumber, terminationUri, idempotencyKey) {
      await call(`${PHONE_BASE_URL}/v1/phone-numbers/import`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ phone_number: phoneNumber, termination_uri: terminationUri }),
      });
    },
    async bindPhoneNumber(phoneNumber, agentId) {
      await call(`${PHONE_BASE_URL}/v1/phone-numbers/${encodeURIComponent(phoneNumber)}/agent`, {
        method: "PUT",
        body: JSON.stringify({ agent_id: agentId }),
      });
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
