/**
 * Stands in for the `server-only` marker under Vitest. In Next.js the real
 * module throws when a Client Component imports it; tests import server
 * modules directly, so the marker has to be a no-op here.
 */
export {};
