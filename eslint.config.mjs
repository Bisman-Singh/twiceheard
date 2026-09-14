import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
      complexity: ["error", 10],
      "max-depth": ["error", 3],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Operator scripts print their results; that is their whole job.
    files: ["scripts/**/*.{mjs,ts}"],
    rules: {
      "no-console": "off",
      complexity: "off",
      "max-lines-per-function": "off",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "**/*.d.ts"]),
]);

export default eslintConfig;
