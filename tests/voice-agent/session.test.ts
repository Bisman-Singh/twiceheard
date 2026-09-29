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

  it("leaves listening to the platform, because tuning it made the product worse", () => {
    // Nothing here overrides how the platform listens. Fixed silence thresholds turned
    // off its entity-aware waiting and measured slower, and the fastest transcription
    // mode drops the barge-in guard to zero, which makes a readback interruptible and so
    // lowers the grade of calls that were actually correct.
    expect(session.input).not.toHaveProperty("turn_detection");
    expect(session.input).not.toHaveProperty("transcription_mode");
    const stored = agentBody(DEMO_CLINIC, { baseUrl: "https://twiceheard.example", toolKey: "k" });
    // The phone and the browser hear the same way, or one of them drifts.
    expect(stored.input).not.toHaveProperty("turn_detection");
    expect(stored.input).not.toHaveProperty("transcription_mode");
  });

  it("assumes a caller close to the microphone, unlike a phone line", () => {
    expect(session.input.voice_focus).toBe("near-field");
    const stored = agentBody(DEMO_CLINIC, { baseUrl: "https://twiceheard.example", toolKey: "k" });
    expect(stored.input.voice_focus).toBe("far-field");
  });
});
