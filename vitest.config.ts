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
    // grants.test.ts and server-grants.test.ts also use bun:sqlite —
    // excluded here, run via test:bun.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src/vault/grants.test.ts",
      "**/src/vault/broker/server-grants.test.ts",
      // `.claude/worktrees/<slug>/` are checkout copies created by sub-agent
      // sessions. Their tests duplicate the canonical ones and run against
      // stale code — never discover them from the canonical repo.
      "**/.claude/worktrees/**",
      "**/telegram-plugin/tests/history.test.ts",
      "**/telegram-plugin/tests/ipc-server-client.test.ts",
      "**/telegram-plugin/tests/ipc-server-race.test.ts",
      "**/telegram-plugin/tests/gateway-bridge.test.ts",
      "**/telegram-plugin/tests/gateway-startup-mutex.test.ts",
      "**/telegram-plugin/tests/gateway-clean-shutdown-marker.test.ts",
      "**/telegram-plugin/tests/foreman-state.test.ts",
      "**/telegram-plugin/tests/boot-card-dedupe.test.ts",
      "**/telegram-plugin/tests/boot-card-reason.test.ts",
      "**/telegram-plugin/tests/progress-update.test.ts",
      "**/telegram-plugin/tests/quota-cache.test.ts",
      "**/telegram-plugin/tests/silent-reply-guard.test.ts",
      "**/telegram-plugin/tests/unhandled-rejection-policy.test.ts",
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
