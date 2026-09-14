import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Tests run in the fast Node environment by default. Component and page tests
 * opt into jsdom per file with a `// @vitest-environment jsdom` docblock.
 *
 * Coverage is measured over the whole application (routes, components and
 * library code alike) with a 100% threshold on every metric, so an untested
 * branch anywhere fails the build.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    // axe over a full result page can take a few seconds on a loaded machine.
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "lib/**/*.ts",
        "proxy.ts",
        "next.config.ts",
      ],
      exclude: ["**/*.d.ts"],
      reporter: ["text-summary", "html", "lcov"],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
});
