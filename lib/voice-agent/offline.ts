import "server-only";
import {
  VoiceAgentApiError,
  type SessionDetail,
  type VoiceAgentClient,
} from "@/lib/voice-agent/client";
import type { SecondHearingClient } from "@/lib/verify/transcribe";

/**
 * The voice platform, played by this repository.
 *
 * The browser end to end test drives a whole call with the platform's socket
 * intercepted, but the session it opens is still minted by the real service, so
 * the test could only ever run for someone holding a key. That is not a test a
 * continuous integration run can have, and it is not the architecture this
 * project describes either: every outside service is supposed to sit behind an
 * interface with a fake, so the whole product runs with no network.
 *
 * This is that fake. It never runs in production: `buildDeps` refuses to select
 * it there, so there is no configuration mistake that can put it in front of a
 * caller. What it deliberately does not do is invent a chart. `getSession`
 * reports a call whose recording has not been published, which is the platform's
 * honest answer while a call is still settling, and the product's own "ask
 * again" path takes it from there.
 */
export function offlineVoiceAgentClient(): VoiceAgentClient {
  const refuse = (what: string) => {
    throw new Error(`${what} needs the real platform; run it with a key`);
  };
  return {
    async mintToken() {
      return "offline-token";
    },
    async getSession(sessionId: string): Promise<SessionDetail> {
      // A session nobody has published is a 404 here too, which is the shape the
      // result route already knows how to answer: pending, ask again.
      throw new VoiceAgentApiError(404, `offline platform holds no session ${sessionId}`);
    },
    async createAgent() {
      return refuse("creating an agent");
    },
    async updateAgent() {
      return refuse("updating an agent");
    },
    async importPhoneNumber() {
      return refuse("importing a number");
    },
    async bindPhoneNumber() {
      return refuse("binding a number");
    },
  };
}

/** No recording exists offline, so there is nothing to hear a second time. */
export function offlineSecondHearing(): SecondHearingClient {
  return {
    async transcribe() {
      throw new Error("no recording to hear again offline");
    },
  };
}
