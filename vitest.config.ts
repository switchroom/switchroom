import { defineConfig } from "vitest/config";

// Tests must produce identical results inside an agent container and on
// the host. `src/agents/compose.ts` injects several env vars into every
// agent container (SWITCHROOM_RUNTIME=docker, SWITCHROOM_CONTAINER=1,
// SWITCHROOM_AGENT_NAME, broker/kernel socket paths) so `npm test`
// invoked inside an agent inherits them. Runtime-aware code (e.g.
// `defaultBrokerSocketPath` in src/vault/broker/client.ts, the
// `isContainerContext()` probe in agent-config) then takes the
// in-container branch and tests that expect default behavior fail —
// resolve-socket-path.test.ts:77 wants the legacy fallback, but the
// docker branch returns the operator path. Clear at the vitest process
// root so both forked test workers and any spawnSync children they
// launch see a clean baseline. Operators running `npm test` on a host
// with these set legitimately for production tools won't notice — the
// host's actual processes read the env independently from their own
// systemd / shell context.
for (const k of [
  "SWITCHROOM_RUNTIME",
  "SWITCHROOM_CONTAINER",
  "SWITCHROOM_AGENT_NAME",
  "SWITCHROOM_VAULT_BROKER_SOCK",
  "SWITCHROOM_KERNEL_SOCKET",
]) {
  delete process.env[k];
}

// Buildkite Test Engine: only attach the collector reporter when the
// analytics token is present. Locally (and in CI jobs without the token)
// we fall back to vitest's default reporter so `npm test` stays quiet
// and doesn't spam "Missing BUILDKITE_ANALYTICS_TOKEN" to stderr.
const reporters: (string | [string, Record<string, unknown>])[] = ["default"];
if (process.env.BUILDKITE_ANALYTICS_TOKEN) {
  reporters.push("buildkite-test-collector/vitest/reporter");
}

// Cap the worker pool. Default is one fork per CPU (16 on this box), and each
// fork can hold ~900MB. Six agents simultaneously running `npm test` at the
// default would demand ~80GB of RAM — enough to OOM a 60GB box even with
// generous swap. 4 forks/run keeps a single test run snappy while letting the
// fleet share the machine safely.
const VITEST_MAX_FORKS = Number(process.env.VITEST_MAX_FORKS ?? 4);

export default defineConfig({
  // Treat .yaml as a static asset so `import x from "./foo.yaml" with
  // { type: "text" }` works under Vite/vitest. Bun's compile-time text
  // imports already handle this; this line keeps vitest aligned.
  assetsInclude: ["**/*.yaml"],
  // Force-deduplicate `@mtcute/node` (and its transitive `@mtcute/core`)
  // to a single physical resolution.
  //
  // Bun's workspace installer creates a per-workspace symlink at
  // `telegram-plugin/node_modules/@mtcute/node` → `node_modules/.bun/...`
  // alongside the hoisted `node_modules/@mtcute/node` (also a path into
  // the same `.bun` store). Node-style resolution from
  // `telegram-plugin/uat/driver.ts` walks up and lands on the closer
  // symlink path; resolution from `tests/uat-driver.test.ts` lands on
  // the root path. vitest's `vi.mock("@mtcute/node")` keys on the
  // resolved module spec — two different resolved paths means two
  // distinct module instances, the driver's import escapes the mock,
  // and every `Driver.connect()` blows up with "Invalid session
  // string". `dedupe` makes vite pick a single resolution per package
  // name across the whole graph.
  resolve: {
    dedupe: ["@mtcute/node", "@mtcute/core", "@mtcute/tl", "@mtcute/tl-runtime", "@mtcute/wasm"],
  },
  test: {
    globals: true,
    environment: "node",
    reporters,
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: VITEST_MAX_FORKS,
        minForks: 1,
      },
    },
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
      // Approval-kernel suites use bun:sqlite — run via test:bun.
      "**/src/vault/approvals/kernel.test.ts",
      "**/src/vault/approvals/schema-idempotent.test.ts",
      "**/src/vault/approvals/vd-unlock-dual-dispatch.test.ts",
      "**/src/vault/approvals/vault-grant-dual-dispatch.test.ts",
      // Phase 3b-1 watchdog state/policy tests use bun:sqlite — run via test:bun.
      "**/src/watchdog/state.test.ts",
      "**/src/watchdog/policy.test.ts",
      "**/src/vault/broker/server-grants.test.ts",
      // Write-grant suites (issue #969 P1b) also use bun:sqlite — run via test:bun.
      "**/src/vault/write-grants.test.ts",
      "**/src/vault/broker/server-write-grants.test.ts",
      // Passphrase-attestation suite (issue #969 P1a) — bun:sqlite.
      "**/src/vault/broker/server-passphrase-attest.test.ts",
      // mint_grant passphrase-attestation suite (#1012 Phase 2) — bun:sqlite.
      "**/src/vault/broker/server-mint-grant-passphrase-attest.test.ts",
      // mint_grant posture-attestation suite (#1115 follow-up) — bun:sqlite.
      "**/src/vault/broker/server-mint-grant-posture-attest.test.ts",
      "**/src/vault/broker/client-token.test.ts",
      "**/src/vault/broker/server-unlock.test.ts",
      "**/src/vault/broker/auto-unlock.test.ts",
      // RFC E drive disconnect tests use bun's `mock()` primitive — run
      // via test:bun. The other Phase 1a/1b/1c drive tests use no bun-
      // specific APIs and run fine under vitest.
      "**/src/drive/disconnect.test.ts",
      // drift-detection imports server.ts which uses bun:sqlite for the
      // grants DB. Run via test:bun.
      "**/src/vault/broker/drift-detection.test.ts",
      // `.claude/worktrees/<slug>/` are checkout copies created by sub-agent
      // sessions. Their tests duplicate the canonical ones and run against
      // stale code — never discover them from the canonical repo.
      "**/.claude/worktrees/**",
      // UAT harness scenarios (#863) hit real Telegram and must never run
      // on the default test path. Invoke via `bun run test:uat` from
      // telegram-plugin/. Mocked-mtcute unit tests for the UAT driver
      // live in `tests/uat-*.test.ts` (run under vitest) rather than
      // co-located, because the buildkite pipeline runs `bun test` from
      // `telegram-plugin/` and bun's vitest shim is partial — coverage
      // discussion in PR #994.
      "**/telegram-plugin/uat/**",
      "**/telegram-plugin/tests/history.test.ts",
      // history-reaper.test.ts uses bun:sqlite + bun:test (#1073) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/history-reaper.test.ts",
      // sandbox-hint-posttool.test.ts uses bun:test — run via test:bun.
      "**/telegram-plugin/tests/sandbox-hint-posttool.test.ts",
      "**/telegram-plugin/tests/ipc-server-client.test.ts",
      "**/telegram-plugin/tests/ipc-server-race.test.ts",
      "**/telegram-plugin/tests/gateway-bridge.test.ts",
      "**/telegram-plugin/tests/gateway-startup-mutex.test.ts",
      "**/telegram-plugin/tests/gateway-clean-shutdown-marker.test.ts",
      "**/telegram-plugin/tests/boot-card-dedupe.test.ts",
      "**/telegram-plugin/tests/boot-card-reason.test.ts",
      // boot-card-reason-to-render.test.ts (#1153) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/boot-card-reason-to-render.test.ts",
      // boot-version-string.test.ts (#1170) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/boot-version-string.test.ts",
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
      // telegraph.test.ts uses bun:test (#579 Telegraph Instant View) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/telegraph.test.ts",
      // gateway-update-placeholder-dispatch.test.ts uses bun:test +
      // Bun.connect to a real Unix socket (#553 hotfix) — excluded
      // here, run via test:bun.
      "**/telegram-plugin/tests/gateway-update-placeholder-dispatch.test.ts",
      // recent-outbound-dedup.test.ts uses bun:test (#546 dup fix) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/recent-outbound-dedup.test.ts",
      // Drive (RFC C) tests use bun:test / bun:sqlite — excluded here,
      // run via test:bun.
      "**/src/drive/disconnect.test.ts",
      "**/src/drive/grants.test.ts",
      "**/src/drive/oauth.test.ts",
      "**/src/drive/onboarding.test.ts",
      "**/src/drive/reconciler.test.ts",
      "**/src/drive/vault-slots.test.ts",
      "**/src/drive/wrapper.test.ts",
      // Approval-kernel tests (RFC B) use bun:test + in-memory bun:sqlite.
      "**/src/vault/approvals/kernel.test.ts",
      "**/src/vault/broker/server-approvals.test.ts",
      // reaction-trigger tests (#1074) use bun:test — run via test:bun.
      "**/telegram-plugin/tests/reaction-trigger.test.ts",
      "**/telegram-plugin/tests/reaction-trigger-flow.test.ts",
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
