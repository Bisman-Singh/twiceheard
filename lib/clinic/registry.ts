import { DEMO_CLINIC, type Clinic } from "@/lib/clinic/config";

/**
 * Which clinics this deployment serves, and which stored agent answers for each.
 *
 * A clinic is looked up by id when its tools are called and by agent id when
 * a finished call's webhook arrives; anything not in the registry is refused.
 *
 * The agent id is the agent that answers the clinic's phone line. It lives on
 * the platform's regional host, because that is the only host that can bind a
 * number, and a browser session opens on the global host and cannot see it. So
 * the id is what turns a finished phone call into a clinic, and it is
 * deliberately not what a browser call runs: that runs the same prompt and the
 * same tools inline. `phoneAgentFor` says which it is, and says it in its name.
 */
export interface ClinicRegistry {
  /** Every clinic this deployment serves, for work that is not about one caller. */
  ids(): readonly string[];
  byId(clinicId: string): Clinic | null;
  forAgent(agentId: string | null): Clinic | null;
  phoneAgentFor(clinicId: string): string | null;
}

export interface RegistryEntry {
  clinic: Clinic;
  agentId: string | null;
}

export function staticRegistry(entries: readonly RegistryEntry[]): ClinicRegistry {
  return {
    ids: () => entries.map((entry) => entry.clinic.id),
    byId: (clinicId) => entries.find((entry) => entry.clinic.id === clinicId)?.clinic ?? null,
    forAgent: (agentId) =>
      agentId ? (entries.find((entry) => entry.agentId === agentId)?.clinic ?? null) : null,
    phoneAgentFor: (clinicId) =>
      entries.find((entry) => entry.clinic.id === clinicId)?.agentId ?? null,
  };
}

/** The demo deployment: one fictional clinic, whose phone line the named agent answers. */
export function demoRegistry(agentId: string | undefined): ClinicRegistry {
  return staticRegistry([{ clinic: DEMO_CLINIC, agentId: agentId ?? null }]);
}
