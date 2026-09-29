import type { Clinic } from "@/lib/clinic/config";
import { LISTENING } from "@/lib/voice-agent/listening";
import { greeting, keyterms, systemPrompt, transcriptionPrompt } from "@/lib/voice-agent/prompt";
import { httpTools, type HttpTool } from "@/lib/voice-agent/tools";

/**
 * A clinic's stored agent, as the Voice Agent API expects it.
 *
 * One stored agent per clinic serves both the clinic's phone number and the
 * browser call button, so the two paths can never drift apart. Saving the
 * clinic in the admin screen rebuilds this body and updates the agent; the
 * change takes effect on the next call.
 */

export interface AgentBody {
  name: string;
  system_prompt: string;
  greeting: string;
  voice: { voice_id: string };
  input: {
    keyterms: string[];
    transcription_prompt: string;
    voice_focus: "far-field";
  };
  tools: HttpTool[];
}

export interface Deployment {
  /** Public https origin of this app; AssemblyAI calls the tools here. */
  baseUrl: string;
  /** Per-clinic secret AssemblyAI sends with every tool call. */
  toolKey: string;
}

export function agentBody(clinic: Clinic, deployment: Deployment): AgentBody {
  return {
    name: `twiceheard-${clinic.id}`,
    system_prompt: systemPrompt(clinic),
    greeting: greeting(clinic),
    voice: { voice_id: clinic.voice },
    input: {
      keyterms: keyterms(clinic),
      transcription_prompt: transcriptionPrompt(clinic),
      // Phone lines and laptop microphones both pick up the room; suppress it.
      voice_focus: "far-field",
      ...LISTENING,
    },
    tools: httpTools(deployment.baseUrl, clinic.id, deployment.toolKey),
  };
}
