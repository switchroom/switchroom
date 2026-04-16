import { defineConfig } from "vitest/config";

// Buildkite Test Engine: only attach the collector reporter when the
// analytics token is present. Locally (and in CI jobs without the token)
// we fall back to vitest's default reporter so `npm test` stays quiet
// and doesn't spam "Missing BUILDKITE_ANALYTICS_TOKEN" to stderr.
const reporters: (string | [string, Record<string, unknown>])[] = ["default"];
if (process.env.BUILDKITE_ANALYTICS_TOKEN) {
  reporters.push("buildkite-test-collector/vitest/reporter");
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    reporters,
    // Required by the Buildkite collector so it can record per-test
    // file/line locations. Harmless when the collector is off.
    includeTaskLocation: true,
    // history.test.ts uses bun:sqlite which is a Bun built-in. vitest
    // runs under vite/Node and can't resolve it. The history tests are
    // run separately via `bun test telegram-plugin/tests/history.test.ts`
    // (see the `test` script in package.json).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/telegram-plugin/tests/history.test.ts",
      "**/telegram-plugin/tests/ipc-server-client.test.ts",
      "**/telegram-plugin/tests/gateway-bridge.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["telegram-plugin/**"],
      exclude: [
        "telegram-plugin/tests/**",
        "telegram-plugin/server.ts",
        "telegram-plugin/start.ts",
        "telegram-plugin/pty-tail.ts",
        "telegram-plugin/history.ts",
        "telegram-plugin/session-tail.ts",
      ],
    },
  },
});
