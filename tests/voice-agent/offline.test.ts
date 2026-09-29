import { describe, expect, it } from "vitest";
import { VoiceAgentApiError } from "@/lib/voice-agent/client";
import { offlineSecondHearing, offlineVoiceAgentClient } from "@/lib/voice-agent/offline";

describe("the platform played by this repository", () => {
  it("mints a session so a browser call can be driven with no key and no credit", async () => {
    const voice = offlineVoiceAgentClient();
    expect(await voice.mintToken({ expiresInSeconds: 60, maxSessionSeconds: 900 })).toBe(
      "offline-token",
    );
  });

  it("answers for a session it does not hold the way the real one does, so the page asks again", async () => {
    // A 404 is what the result route already knows how to read as "pending".
    await expect(offlineVoiceAgentClient().getSession("sess_x")).rejects.toBeInstanceOf(
      VoiceAgentApiError,
    );
    await expect(offlineVoiceAgentClient().getSession("sess_x")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses to pretend it created anything on the real account", async () => {
    const voice = offlineVoiceAgentClient();
    const body = { name: "x", tools: [] } as unknown as Parameters<typeof voice.createAgent>[0];
    await expect(voice.createAgent(body)).rejects.toThrow(/needs the real platform/);
    await expect(voice.updateAgent("agent_1", body)).rejects.toThrow(/needs the real platform/);
    await expect(voice.importPhoneNumber("+14155550123", "x.pstn", "k")).rejects.toThrow(
      /needs the real platform/,
    );
    await expect(voice.bindPhoneNumber("+14155550123", "agent_1")).rejects.toThrow(
      /needs the real platform/,
    );
  });

  it("has no recording to hear a second time, and says so rather than inventing one", async () => {
    await expect(offlineSecondHearing().transcribe("https://x/a.ogg", [])).rejects.toThrow(
      /no recording/,
    );
  });
});
