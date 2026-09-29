// Turns a deployment into an agent the platform can call.
//
// It builds the stored agent from the app's own code, so the prompt, the tools and the
// per-clinic tool key can never drift from what the deployment serves. By default it
// only prints what it would send and writes the body to a file. Nothing reaches the
// platform, and no phone number is touched, until --apply is passed.
//
// Usage:
//   node --import ./scripts/alias-hook.mjs scripts/setup-agent.ts \
//     --base-url https://example.com [--env .env.production] [--clinic sunrise-family] \
//     [--number +14155550123 --termination-uri example.pstn.twilio.com] [--apply]
//
// --env is the environment file holding the key and the secret of the deployment
// --base-url serves from. It defaults to .env.local, which is right for a laptop and
// wrong for production, whose secret is its own.
//
// The agent id it prints has to go into the deployment's environment as
// TWICEHEARD_AGENT_ID, or a browser call will keep configuring the agent inline.
import { readFileSync, writeFileSync } from "node:fs";
import { demoRegistry } from "@/lib/clinic/registry";
import { toolKeyFor } from "@/lib/security/keys";
import { agentBody } from "@/lib/voice-agent/agent";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * The same shape the runtime gets: quotes stripped, `export` ignored, comments
 * dropped. Keeping the quotes on a value written as `TWICEHEARD_SECRET="9f3a..."`
 * would sign the agent's tool key with a different secret from the one the
 * deployment derives, and every tool call on every phone call would come back
 * 401 with nothing in the logs but "unauthorized".
 */
function env(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rest] = match as unknown as [string, string, string];
    const quoted = /^(['"`])([\s\S]*?)\1\s*$/.exec(rest.trim());
    out[name] = quoted ? (quoted[2] as string) : (rest.split(" #")[0] as string).trim();
  }
  return out;
}

const apply = process.argv.includes("--apply");
const baseUrl = arg("base-url");
const clinicId = arg("clinic") ?? "sunrise-family";
const number = arg("number");
const terminationUri = arg("termination-uri");
const out = arg("out") ?? "demo/agent-body.json";

if (!baseUrl?.startsWith("https://")) {
  throw new Error("--base-url must be the deployment's https origin");
}

// The tool key is derived from the secret, so it has to be the secret the
// deployment itself holds. Point this at the environment the --base-url serves
// from, or the agent will be created with a key that deployment refuses.
const envPath = arg("env") ?? ".env.local";
const local = env(envPath);
const key = local.ASSEMBLYAI_API_KEY;
const secret = local.TWICEHEARD_SECRET;
if (!key || !secret)
  throw new Error(`ASSEMBLYAI_API_KEY and TWICEHEARD_SECRET must be in ${envPath}`);

const clinic = demoRegistry(local.TWICEHEARD_AGENT_ID).byId(clinicId);
if (!clinic) throw new Error(`unknown clinic ${clinicId}`);

const body = agentBody(clinic, { baseUrl, toolKey: toolKeyFor(clinicId, secret) });
// The body carries the clinic's tool key, which is the whole credential for the tool
// endpoints, so it is written where only this user can read it.
writeFileSync(out, JSON.stringify(body, null, 2), { mode: 0o600 });

const toolUrls = body.tools.map((tool) => tool.http?.url).filter(Boolean);
console.log(`clinic:        ${clinic.id} (${clinic.name})`);
console.log(`tools:         ${body.tools.length}, all pointed at ${baseUrl}`);
console.log(`first tool:    ${toolUrls[0] ?? "none"}`);
console.log(`existing id:   ${local.TWICEHEARD_AGENT_ID ?? "none, a new agent would be created"}`);
console.log(`number:        ${number ?? "none"}`);
console.log(`body written:  ${out}`);

if (!apply) {
  console.log("\nDry run. Nothing was sent. Pass --apply to create or update the agent.");
  process.exit(0);
}

// One host for both, or the number cannot be bound to the agent.
const AGENTS = "https://agents.us.assemblyai.com";
const PHONE = AGENTS;

async function send(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method} ${url} -> ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const existing = local.TWICEHEARD_AGENT_ID;
const agent = existing
  ? await send(`${AGENTS}/v1/agents/${encodeURIComponent(existing)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
  : await send(`${AGENTS}/v1/agents`, { method: "POST", body: JSON.stringify(body) });
const agentId = String(agent.id);
console.log(`\n${existing ? "updated" : "created"} agent ${agentId}`);

if (number && terminationUri) {
  // Importing a number the account already holds answers 500 rather than saying so,
  // which would leave the number bound to whatever agent it was bound to before.
  // Re-running this script is how an agent is updated, so it has to survive that:
  // import, and if the import fails, only carry on once the number is really there.
  const imported = await send(`${PHONE}/v1/phone-numbers/import`, {
    method: "POST",
    headers: { "Idempotency-Key": `import:${number}` },
    body: JSON.stringify({ phone_number: number, termination_uri: terminationUri }),
  }).catch(async (error: unknown) => {
    const held = (await send(`${PHONE}/v1/phone-numbers`, { method: "GET" })) as unknown;
    const list = Array.isArray(held) ? held : [];
    if (!list.some((item) => (item as { phone_number?: string }).phone_number === number))
      throw error;
    console.log(`${number} is already on the account; rebinding it`);
    return null;
  });
  void imported;
  await send(`${PHONE}/v1/phone-numbers/${encodeURIComponent(number)}/agent`, {
    method: "PUT",
    body: JSON.stringify({ agent_id: agentId }),
  });
  console.log(`bound ${number} to ${agentId} over ${terminationUri}`);
}

console.log(`\nSet TWICEHEARD_AGENT_ID=${agentId} in the deployment's environment.`);
