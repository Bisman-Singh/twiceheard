import type { Clinic } from "@/lib/clinic/config";
import { LISTENING, type Listening } from "@/lib/voice-agent/listening";
import { greeting, keyterms, systemPrompt, transcriptionPrompt } from "@/lib/voice-agent/prompt";
import { TOOL_SPECS } from "@/lib/voice-agent/tools";

/**
 * The session a browser opens when no stored agent can reach us.
 *
 * A stored agent's tools are called by AssemblyAI over the public internet,
 * which cannot reach a laptop. So a local call configures the same agent
 * inline and declares the same tools without an HTTP target: the platform
 * asks the browser to run them, and the browser relays each one to this
 * app's own API, where the same handlers do the same work. The wording, the
 * tools and the rules are identical to the phone; only the delivery differs.
 */

export interface InlineSession {
  system_prompt: string;
  greeting: string;
  output: { voice: string };
  input: {
    keyterms: string[];
    transcription_prompt: string;
    voice_focus: "near-field";
    transcription_mode: Listening["transcription_mode"];
  };
  tools: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execution_mode: "interactive" | "hold";
    timeout_seconds: number;
  }>;
}

export function inlineSession(clinic: Clinic): InlineSession {
  return {
    system_prompt: systemPrompt(clinic),
    greeting: greeting(clinic),
    output: { voice: clinic.voice },
    input: {
      keyterms: keyterms(clinic),
      transcription_prompt: transcriptionPrompt(clinic),
      // A browser caller is on a headset or a laptop mic, close to the microphone.
      voice_focus: "near-field",
      ...LISTENING,
    },
    tools: TOOL_SPECS.map((spec) => ({
      type: "function",
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as unknown as Record<string, unknown>,
      execution_mode: spec.execution_mode,
      timeout_seconds: spec.timeout_seconds,
    })),
  };
}
