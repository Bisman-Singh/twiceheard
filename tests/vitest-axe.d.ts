import type { AxeMatchers } from "vitest-axe/matchers";

// Teaches TypeScript about the `toHaveNoViolations()` matcher added in vitest.setup.ts.
declare module "vitest" {
  interface Assertion extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
