// Lets a script import the app's own modules by their "@/..." names.
//
// The setup script has to build exactly the agent body the app serves, so it imports
// lib/voice-agent/agent.ts rather than repeating it. Node strips the types itself; this
// hook only turns "@/x" into a path and puts back the extension TypeScript leaves out.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const root = pathToFileURL(`${process.cwd()}/`).href;

register(
  `data:text/javascript,
  import { existsSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  const root = ${JSON.stringify(root)};
  const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts"];
  export async function resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    const base = new URL(specifier.slice(2), root);
    for (const extension of EXTENSIONS) {
      const candidate = new URL(base.href + extension);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    return next(base.href, context);
  }`,
  import.meta.url,
);

// Imported for the side effect above; this keeps the linter and the reader in agreement.
export const aliasRoot = fileURLToPath(root);
export const aliasReady = existsSync(aliasRoot);
