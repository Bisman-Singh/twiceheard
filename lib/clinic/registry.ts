import { DEMO_CLINIC, type Clinic } from "@/lib/clinic/config";

/**
 * Which clinics this deployment serves, and which stored agent answers for each.
 *
 * A clinic is looked up by id when its tools are called and by agent id when
 * a finished call's webhook arrives; anything not in the registry is refused.
 */
export interface ClinicRegistry {
  byId(clinicId: string): Clinic | null;
  forAgent(agentId: string | null): Clinic | null;
  agentFor(clinicId: string): string | null;
}

export interface RegistryEntry {
  clinic: Clinic;
  agentId: string | null;
}

export function staticRegistry(entries: readonly RegistryEntry[]): ClinicRegistry {
  return {
    byId: (clinicId) => entries.find((entry) => entry.clinic.id === clinicId)?.clinic ?? null,
    forAgent: (agentId) =>
      agentId ? (entries.find((entry) => entry.agentId === agentId)?.clinic ?? null) : null,
    agentFor: (clinicId) => entries.find((entry) => entry.clinic.id === clinicId)?.agentId ?? null,
  };
}

/** The demo deployment: one fictional clinic, answered by the agent named in the environment. */
export function demoRegistry(agentId: string | undefined): ClinicRegistry {
  return staticRegistry([{ clinic: DEMO_CLINIC, agentId: agentId ?? null }]);
}
