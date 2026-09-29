import { describe, expect, it } from "vitest";
import { DEMO_CLINIC } from "@/lib/clinic/config";
import { agentBody } from "@/lib/voice-agent/agent";
import { greeting, systemPrompt } from "@/lib/voice-agent/prompt";
import { inlineSession } from "@/lib/voice-agent/session";
import { TOOL_SPECS } from "@/lib/voice-agent/tools";

describe("inlineSession", () => {
  const session = inlineSession(DEMO_CLINIC);

  it("says the same things a stored agent says, so the two paths cannot drift", () => {
    const stored = agentBody(DEMO_CLINIC, { baseUrl: "https://twiceheard.example", toolKey: "k" });
    expect(session.system_prompt).toBe(systemPrompt(DEMO_CLINIC));
    expect(session.greeting).toBe(greeting(DEMO_CLINIC));
    expect(session.input.keyterms).toEqual(stored.input.keyterms);
    expect(session.input.transcription_prompt).toBe(stored.input.transcription_prompt);
    expect(session.output.voice).toBe(DEMO_CLINIC.voice);
  });

  it("declares every tool with no HTTP target, so the platform asks the page to run them", () => {
    expect(session.tools).toHaveLength(TOOL_SPECS.length);
    expect(session.tools.map((tool) => tool.name)).toEqual(TOOL_SPECS.map((spec) => spec.name));
    for (const tool of session.tools) {
      expect(tool).not.toHaveProperty("http");
      expect(tool.type).toBe("function");
    }
    const saveField = session.tools.find((tool) => tool.name === "save_field");
    expect(saveField?.execution_mode).toBe("hold");
    expect((saveField?.parameters as { required: string[] }).required).toContain("intake_id");
  });

  it("listens for a short pause, not a long one, so a turn feels like a phone call", () => {
    // With the platform's defaults a real call answered a median of 3.55 s after the
    // caller stopped, most of it the one second of silence the default waits for.
    expect(session.input.transcription_mode).toBe("min_latency");
    // The platform's end of turn detection is semantic and adapts to the speaker. Pinning
    // fixed silence thresholds over it measured slower, so nothing here overrides it.
    expect(session.input).not.toHaveProperty("turn_detection");
    const stored = agentBody(DEMO_CLINIC, { baseUrl: "https://twiceheard.example", toolKey: "k" });
    // The phone and the browser hear the same way, or one of them drifts.
    expect(stored.input.transcription_mode).toBe(session.input.transcription_mode);
    expect(stored.input).not.toHaveProperty("turn_detection");
  });

  it("assumes a caller close to the microphone, unlike a phone line", () => {
    expect(session.input.voice_focus).toBe("near-field");
    const stored = agentBody(DEMO_CLINIC, { baseUrl: "https://twiceheard.example", toolKey: "k" });
    expect(stored.input.voice_focus).toBe("far-field");
  });
});
