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
      "**/src/vault/broker/client-token.test.ts",
      "**/src/vault/broker/server-unlock.test.ts",
      "**/src/vault/broker/auto-unlock.test.ts",
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
      // The following tests transitively import bun:sqlite (via grants-db.ts
      // or bun:test) and therefore can't run under vitest/Node. Each is
      // covered by the test:bun script.
      "**/tests/vault-broker-passphrase.test.ts",
      "**/src/cli/vault-get-broker.test.ts",
      "**/src/vault/resolver-via-broker.test.ts",
      "**/src/vault/broker/scope.test.ts",
      "**/src/vault/broker/server.test.ts",
      "**/src/vault/broker/auto-unlock.test.ts",
      "**/telegram-plugin/tests/boot-probes.test.ts",
      "**/telegram-plugin/tests/setup-state.test.ts",
      // registry-turns.test.ts uses bun:sqlite — excluded here, run via test:bun.
      "**/telegram-plugin/tests/registry-turns.test.ts",
      // subagents.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/subagents.test.ts",
      // turns-writer.test.ts uses bun:sqlite — excluded here, run via test:bun.
      "**/telegram-plugin/tests/turns-writer.test.ts",
      // api-registry.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/api-registry.test.ts",
      // turns-schema.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/turns-schema.test.ts",
      // idle-footer-wiring.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/idle-footer-wiring.test.ts",
      // subagent-tracker-hooks.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/subagent-tracker-hooks.test.ts",
      // subagents-bugs.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/subagents-bugs.test.ts",
      // subagents-schema-init-order.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/subagents-schema-init-order.test.ts",
      // resolve-calling-subagent.test.ts uses bun:test + bun:sqlite — excluded here, run via test:bun.
      "**/telegram-plugin/tests/resolve-calling-subagent.test.ts",
      // secret-guard-pretool.test.ts uses bun:test (NDJSON unix-socket
      // integration test for the PreToolUse hook) — excluded here, run via
      // test:bun. Without this exclude, the cross-package vitest pass on
      // tests-core fails to resolve `bun:test` and the build goes red.
      "**/telegram-plugin/tests/secret-guard-pretool.test.ts",
      // forum-topic-placeholder.test.ts uses bun:test — excluded here,
      // run via test:bun.
      "**/telegram-plugin/tests/forum-topic-placeholder.test.ts",
      // update-placeholder-handler.test.ts uses bun:test — excluded here,
      // run via test:bun.
      "**/telegram-plugin/tests/update-placeholder-handler.test.ts",
      // ask-user.test.ts uses bun:test (#574 ask_user MCP tool) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/ask-user.test.ts",
      // interrupt-marker.test.ts uses bun:test (#575 ! interrupt) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/interrupt-marker.test.ts",
      // sticker-aliases.test.ts uses bun:test (#576 sticker/gif) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/sticker-aliases.test.ts",
      // voice-transcribe.test.ts uses bun:test (#578 voice-in spike) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/voice-transcribe.test.ts",
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
