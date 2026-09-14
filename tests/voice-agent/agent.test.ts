import { describe, expect, it } from "vitest";
import { DEMO_CLINIC, type Clinic } from "@/lib/clinic/config";
import { FIELD_IDS } from "@/lib/intake/fields";
import { agentBody } from "@/lib/voice-agent/agent";
import {
  emergencyNumber,
  greeting,
  keyterms,
  systemPrompt,
  transcriptionPrompt,
} from "@/lib/voice-agent/prompt";
import { TOOL_KEY_HEADER, TOOL_SPECS, httpTools } from "@/lib/voice-agent/tools";

const deployment = { baseUrl: "https://earshot.example", toolKey: "k".repeat(40) };
const usClinic: Clinic = { ...DEMO_CLINIC, country: "US", timezone: "America/New_York" };

describe("tools", () => {
  it("defines seven tools with unique names, all requiring the intake id except the first", () => {
    const names = TOOL_SPECS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(7);
    for (const tool of TOOL_SPECS.filter((spec) => spec.name !== "start_intake")) {
      expect(tool.parameters.required, tool.name).toContain("intake_id");
    }
  });

  it("offers exactly the intake fields to save_field", () => {
    const saveField = TOOL_SPECS.find((tool) => tool.name === "save_field");
    expect(saveField?.parameters.properties.field?.enum).toEqual([...FIELD_IDS]);
    expect(saveField?.execution_mode).toBe("hold");
  });

  it("points every tool at this clinic's https endpoint with the key header", () => {
    const tools = httpTools(deployment.baseUrl, "sunrise-family", deployment.toolKey);
    expect(tools[1]?.http).toEqual({
      url: "https://earshot.example/api/tools/sunrise-family/save_field",
      http_method: "POST",
      headers: [{ name: TOOL_KEY_HEADER, value: deployment.toolKey }],
    });
    expect(() => httpTools("http://localhost:3000", "sunrise-family", "k")).toThrow(/https/);
  });
});

describe("prompt", () => {
  it("leads with the readback rule and grounds the agent in the clinic", () => {
    const prompt = systemPrompt(DEMO_CLINIC);
    expect(prompt.startsWith("READ BACK BEFORE YOU CONFIRM.")).toBe(true);
    expect(prompt).toContain("Sunrise Family Clinic");
    expect(prompt).toContain("call one one two now");
    expect(systemPrompt(usClinic)).toContain("call nine one one now");
    expect(emergencyNumber(usClinic)).toBe("nine one one");
  });

  it("tells the caller the call is recorded before anything is collected", () => {
    expect(greeting(DEMO_CLINIC)).toMatch(/This call is recorded/);
  });

  it("describes the call to the transcriber by country", () => {
    expect(transcriptionPrompt(DEMO_CLINIC)).toContain("in India");
    expect(transcriptionPrompt(usClinic)).toContain("in the United States");
  });

  it("biases transcription toward the clinic's own names, deduplicated and within limits", () => {
    const terms = keyterms({
      ...DEMO_CLINIC,
      formulary: [...DEMO_CLINIC.formulary, "metformin", "x".repeat(50)],
    });
    expect(terms[0]).toBe("Sunrise Family Clinic");
    expect(terms).toContain("Dr. Rahul Iyer");
    expect(terms.filter((term) => term === "metformin")).toHaveLength(1);
    expect(terms.every((term) => term.length <= 50)).toBe(true);
    const many = keyterms({
      ...DEMO_CLINIC,
      formulary: Array.from({ length: 80 }, (_, i) => `drug-${i}`),
      doctors: Array.from({ length: 20 }, (_, i) => ({
        id: `d-${i}`,
        name: `Doctor ${i}`,
        specialty: "GP",
      })),
    });
    expect(many).toHaveLength(100);
  });
});

describe("agentBody", () => {
  it("builds the stored agent a clinic's number and call button share", () => {
    const body = agentBody(DEMO_CLINIC, deployment);
    expect(body.name).toBe("earshot-sunrise-family");
    expect(body.voice).toEqual({ voice_id: "anna" });
    expect(body.input.voice_focus).toBe("far-field");
    expect(body.input.keyterms).toContain("Dr. Neha Kapoor");
    expect(body.tools).toHaveLength(7);
    expect(body.greeting).toBe(greeting(DEMO_CLINIC));
  });
});
