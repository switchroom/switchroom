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
//
// SWITCHROOM_RICH_RENDER (#3014) is the same hazard: the Bot API rich
// renderer is ON BY DEFAULT (escape hatch, not opt-in — mirrors the send
// gate), and an agent that opted OUT via its `env:` block exports
// `SWITCHROOM_RICH_RENDER=0` into its container. `npm test` run inside
// such a container would inherit the kill-switch, flip
// `renderOutboundChunks` to raw passthrough, and break the tests that
// pin the rendered (mdast round-tripped) body — green in CI (var unset →
// default ON) but red in an opted-out agent container. Scrub it so every
// run exercises the real default; the kill-switch tests
// (render-outbound-chunks, rich-render) set `=0` explicitly per-case.
for (const k of [
  "SWITCHROOM_RUNTIME",
  "SWITCHROOM_CONTAINER",
  "SWITCHROOM_AGENT_NAME",
  "SWITCHROOM_VAULT_BROKER_SOCK",
  "SWITCHROOM_KERNEL_SOCKET",
  "SWITCHROOM_RICH_RENDER",
]) {
  delete process.env[k];
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
    reporters: ["default"],
    // Hermeticity gate (#3612). `AuthBroker` force-probes candidate
    // accounts through `fetchQuota` (10s default abort) inside request
    // paths the broker harnesses deadline at 3s, so an un-seamed broker in
    // a unit test is a pure-latency CI coin flip — it went red on main as
    // `Error: rpc timeout` twice (#3609, #3613), each time fixed one file
    // at a time. This setup file installs a rejecting `globalThis.fetch`
    // for every test file that can reach `fetchQuota`, so the class cannot
    // regrow one new test at a time. `npm run lint:auth-test-hermeticity`
    // fails if this entry is removed or the guard stops covering a file
    // that needs it.
    setupFiles: [
      "./tests/vitest-setup/auth-net-guard.mjs",
      "./tests/vitest-setup/agent-state-dir-guard.mjs",
      // Hindsight bank hermeticity: the fleet's Hindsight is shared
      // production state, and it auto-creates a bank on miss — one stray
      // request from a test process mints a bank in the live instance. On
      // 2026-07-30 a harness sweep minted 11, one of them named `clerk`,
      // colliding with a live agent and erasing the annotation that
      // documented where that agent's memory really lives. This setup file
      // scrubs the ambient Hindsight URLs and rejects any fetch to a fleet
      // Hindsight origin. `npm run lint:hindsight-bank-hermeticity` fails if
      // this entry (or either bunfig preload) is removed.
      "./tests/vitest-setup/hindsight-bank-guard.mjs",
    ],
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
      "**/src/vault/grants-db.test.ts",
      // Approval-kernel suites use bun:sqlite — run via test:bun.
      "**/src/vault/approvals/kernel.test.ts",
      "**/src/vault/approvals/approval-origin.test.ts",
      "**/src/vault/approvals/kernel-operator-acl.test.ts",
      "**/src/vault/approvals/kernel-listener-acl.test.ts",
      // Self-approval-bypass regression suite binds a real kernel socket
      // (bootstrap → bun:sqlite) — run via test:bun.
      "**/src/vault/approvals/self-approval-bypass.test.ts",
      "**/src/vault/approvals/schema-idempotent.test.ts",
      "**/src/vault/approvals/vd-unlock-dual-dispatch.test.ts",
      "**/src/vault/approvals/vault-grant-dual-dispatch.test.ts",
      // Phase 3b-1 watchdog state/policy tests use bun:sqlite — run via test:bun.
      "**/src/watchdog/state.test.ts",
      "**/src/watchdog/policy.test.ts",
      "**/src/vault/broker/server-grants.test.ts",
      // Read-path unusable-token fall-through suite (#1487) — bun:sqlite,
      // run via test:bun (same as the sibling server-grants suites).
      "**/src/vault/broker/server-token-fallthrough.test.ts",
      // Write-grant suites (issue #969 P1b) also use bun:sqlite — run via test:bun.
      "**/src/vault/write-grants.test.ts",
      "**/src/vault/broker/server-write-grants.test.ts",
      // Scope/format durability across rotation (#3143-A) — bun:sqlite.
      "**/src/vault/broker/server-scope-persist.test.ts",
      // Tokenless-write entry-scope enforcement (#3143-B/C) — bun:sqlite.
      "**/src/vault/broker/server-tokenless-scope.test.ts",
      // Passphrase-attestation suite (issue #969 P1a) — bun:sqlite.
      "**/src/vault/broker/server-passphrase-attest.test.ts",
      // mint_grant passphrase-attestation suite (#1012 Phase 2) — bun:sqlite.
      "**/src/vault/broker/server-mint-grant-passphrase-attest.test.ts",
      // mint_grant posture-attestation suite (#1115 follow-up) — bun:sqlite.
      "**/src/vault/broker/server-mint-grant-posture-attest.test.ts",
      // LiteLLM apply-level e2e — drives a real broker (bun:sqlite grants DB).
      "**/src/litellm/provision-apply-e2e.test.ts",
      // admin-only-keys posture-enforcement suite — bun:sqlite (pre-seeds
      // a grants DB to exercise retain-but-not-add). Run via test:bun.
      "**/src/vault/broker/server-admin-only-keys.test.ts",
      "**/src/vault/broker/client-token.test.ts",
      "**/src/vault/broker/server-unlock.test.ts",
      "**/src/vault/broker/server-per-agent-unlock.test.ts",
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
      // co-located, because CI runs `bun test` from `telegram-plugin/`
      // and bun's vitest shim is partial — coverage discussion in
      // PR #994.
      "**/telegram-plugin/uat/**",
      "**/telegram-plugin/tests/history.test.ts",
      // reply-to-buffer-history.test.ts seeds a real history.db via bun:sqlite
      // (recordOutbound → lookup → recordInbound) — excluded here, run via bun.
      "**/telegram-plugin/tests/reply-to-buffer-history.test.ts",
      // boot-briefing-builder.test.ts seeds a real history.db via bun:sqlite
      // (gateway boot briefing) — excluded here, run via test:bun.
      "**/telegram-plugin/tests/boot-briefing-builder.test.ts",
      // cross-turn-card-gate.test.ts imports history.ts (bun:sqlite) to seed a
      // real outbound row — must run under bun, not vitest. (#PR1 lever 4)
      "**/telegram-plugin/tests/cross-turn-card-gate.test.ts",
      // emission-authority-open-gate.test.ts imports history.ts (bun:sqlite) for
      // the real cross-turn predicate in the PR-4b flag-parity proof — run under
      // bun, not vitest.
      "**/telegram-plugin/tests/emission-authority-open-gate.test.ts",
      // emission-authority-ping-gate.test.ts uses the bun-only dynamic-reimport
      // seam (query-string module re-eval) to flip the read-once kill-switch per
      // flag state in the PR-4c over-ping flag-parity proof — run under bun, not
      // vitest (vitest rejects the variable dynamic import).
      "**/telegram-plugin/tests/emission-authority-ping-gate.test.ts",
      // emission-authority-card-drain-gate.test.ts uses the bun-only
      // dynamic-reimport seam (query-string module re-eval) to flip the
      // read-once kill-switch per flag state in the PR-4d card-drain
      // flag-parity proof — run under bun, not vitest (vitest rejects the
      // variable dynamic import).
      "**/telegram-plugin/tests/emission-authority-card-drain-gate.test.ts",
      // per-topic-current-turn.test.ts uses the bun-only dynamic-reimport seam
      // (query-string module re-eval) to flip the read-once kill-switch per flag
      // state in the PR-4e per-topic-map behavioural proof — run under bun, not
      // vitest (vitest rejects the variable dynamic import).
      "**/telegram-plugin/tests/per-topic-current-turn.test.ts",
      // history-reaper.test.ts uses bun:sqlite + bun:test (#1073) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/history-reaper.test.ts",
      // catch-all-forwarded-history.test.ts uses bun:sqlite (history) +
      // bun:test (#3300) — excluded here, run via test:bun.
      "**/telegram-plugin/tests/catch-all-forwarded-history.test.ts",
      // sandbox-hint-posttool.test.ts uses bun:test — run via test:bun.
      "**/telegram-plugin/tests/sandbox-hint-posttool.test.ts",
      // tts-normalize.test.ts (#2760 Phase 1) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/tts-normalize.test.ts",
      // voice-presynth.test.ts (#2763) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/voice-presynth.test.ts",
      // voice-send.test.ts (file_id reuse) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/voice-send.test.ts",
      // fleet-fallback-gate.test.ts uses bun:test — run via test:bun.
      "**/telegram-plugin/tests/fleet-fallback-gate.test.ts",
      "**/telegram-plugin/tests/ipc-server-client.test.ts",
      "**/telegram-plugin/tests/ipc-server-race.test.ts",
      // ipc-client-reconnect-rejection.test.ts (fleet-audit B2) drives the
      // real bridge ipc-client (Bun.connect) — bun built-in, run via bun.
      "**/telegram-plugin/tests/ipc-client-reconnect-rejection.test.ts",
      // ipc-server-buzz-dedup.test.ts (Buzz Phase 1) drives a real
      // createIpcServer (Bun.listen) over a tmp UDS to exercise the hub-side
      // Buzz dedup ring — Bun.listen is a bun built-in, so run via bun.
      "**/telegram-plugin/tests/ipc-server-buzz-dedup.test.ts",
      // ipc-server-buzz-peer.test.ts (Buzz Phase 2b, S7 role-disjointness)
      // drives a real Unix socket through createIpcServer → Bun.listen, a bun
      // built-in — run via bun (tests/ substring in bun-test-ci.sh), never under
      // vitest where `Bun` is undefined.
      "**/telegram-plugin/tests/ipc-server-buzz-peer.test.ts",
      // ipc-server-query-pending-permission.test.ts (#2971) drives a real
      // createIpcServer (Bun.listen) over a tmp UDS — run via test:bun.
      "**/telegram-plugin/tests/ipc-server-query-pending-permission.test.ts",
      // ipc-server-check-pre-approved.test.ts (#2975 Stage 2) drives a real
      // createIpcServer (Bun.listen) over a tmp UDS — run via test:bun.
      "**/telegram-plugin/tests/ipc-server-check-pre-approved.test.ts",
      // rollout-narration-edit-socket.test.ts (#4065) drives a real
      // createIpcServer (Bun.listen) over a tmp UDS against the real hostd
      // narration relay — Bun.listen is a bun built-in, so run via bun.
      "**/telegram-plugin/tests/rollout-narration-edit-socket.test.ts",
      "**/telegram-plugin/tests/gateway-bridge.test.ts",
      "**/telegram-plugin/tests/gateway-startup-mutex.test.ts",
      "**/telegram-plugin/tests/gateway-clean-shutdown-marker.test.ts",
      "**/telegram-plugin/tests/boot-card-dedupe.test.ts",
      "**/telegram-plugin/tests/boot-card-reason.test.ts",
      // boot-card-reason-to-render.test.ts (#1153) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/boot-card-reason-to-render.test.ts",
      // boot-version-string.test.ts (#1170) imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/boot-version-string.test.ts",
      // webhook-ingest-server.test.ts imports bun:test + exercises the
      // bun:ffi SO_PEERCRED gate (null under node) — run via test:bun.
      "**/telegram-plugin/gateway/webhook-ingest-server.test.ts",
      "**/telegram-plugin/tests/progress-update.test.ts",
      // progress-fallback-cap.test.ts imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/progress-fallback-cap.test.ts",
      // progress-cap.test.ts imports bun:test — run via test:bun.
      "**/telegram-plugin/tests/progress-cap.test.ts",
      "**/telegram-plugin/tests/quota-cache.test.ts",
      "**/telegram-plugin/tests/unhandled-rejection-policy.test.ts",
      // The following tests transitively import bun:sqlite (via grants-db.ts
      // or bun:test) and therefore can't run under vitest/Node. Each is
      // covered by the test:bun script.
      "**/tests/vault-broker-passphrase.test.ts",
      // setup-recall-pool-provision.test.ts imports stepMemoryBackend from
      // ./setup.js, whose static graph reaches vault/grants-db.ts (bun:sqlite)
      // via the vault-broker → broker/server chain — run via test:bun.
      "**/src/cli/setup-recall-pool-provision.test.ts",
      "**/src/cli/vault-get-broker.test.ts",
      "**/src/vault/resolver-via-broker.test.ts",
      "**/src/vault/broker/scope.test.ts",
      "**/src/vault/broker/server.test.ts",
      "**/src/vault/broker/auto-unlock.test.ts",
      "**/telegram-plugin/tests/boot-probes.test.ts",
      // context-occupancy.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/context-occupancy.test.ts",
      // tool-filter.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/tool-filter.test.ts",
      // boot-probes-connections.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/boot-probes-connections.test.ts",
      "**/telegram-plugin/tests/setup-state.test.ts",
      // registry-turns.test.ts uses bun:sqlite — excluded here, run via test:bun.
      "**/telegram-plugin/tests/registry-turns.test.ts",
      // subagents.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/subagents.test.ts",
      // turns-writer.test.ts uses bun:sqlite — excluded here, run via test:bun.
      "**/telegram-plugin/tests/turns-writer.test.ts",
      // resume-inbound-builder.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/resume-inbound-builder.test.ts",
      // skill-proposal-card.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/skill-proposal-card.test.ts",
      // api-registry.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/api-registry.test.ts",
      // turns-schema.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/turns-schema.test.ts",
      // idle-footer-wiring.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/idle-footer-wiring.test.ts",
      // subagent-tracker-hooks.test.ts uses bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/subagent-tracker-hooks.test.ts",
      // subagent-watcher-parent-turn-key.test.ts uses bun:sqlite + bun:test — run via test:bun.
      "**/telegram-plugin/tests/subagent-watcher-parent-turn-key.test.ts",
      // subagent-nested-dispatch.test.ts uses bun:sqlite + bun:test — run via test:bun.
      "**/telegram-plugin/tests/subagent-nested-dispatch.test.ts",
      // worker-origin-gap-dispatch.test.ts (msg-6897 misroute regression) uses
      // bun:sqlite + bun:test — run via test:bun.
      "**/telegram-plugin/tests/worker-origin-gap-dispatch.test.ts",
      // nested-worker-visibility-harness.test.ts uses bun:sqlite + bun:test — run via test:bun.
      "**/telegram-plugin/tests/nested-worker-visibility-harness.test.ts",
      // subagents-bugs.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/registry/subagents-bugs.test.ts",
      // subagents-schema-init-order.test.ts uses bun:sqlite + bun:test — excluded here, run via test:bun.
      "**/telegram-plugin/tests/subagents-schema-init-order.test.ts",
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
      // voice-transcribe-sidecar.test.ts uses bun:test (PR-B2 local STT) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/voice-transcribe-sidecar.test.ts",
      // voice-synthesize-sidecar.test.ts uses bun:test (PR-C2 local TTS) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/voice-synthesize-sidecar.test.ts",
      // voice-normalize-text.test.ts + voice-out-one-send.test.ts use
      // bun:test (voice-out speech normalization + one-send) — excluded
      // here, run via test:bun.
      "**/telegram-plugin/tests/voice-normalize-text.test.ts",
      "**/telegram-plugin/tests/voice-out-one-send.test.ts",
      // voice-ondemand.test.ts uses bun:test (on-demand 🔊 Listen button) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/voice-ondemand.test.ts",
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
      "**/src/vault/approvals/kernel-operator-acl.test.ts",
      "**/src/vault/broker/server-approvals.test.ts",
      // reaction-trigger tests (#1074) use bun:test — run via test:bun.
      "**/telegram-plugin/tests/reaction-trigger.test.ts",
      "**/telegram-plugin/tests/reaction-trigger-flow.test.ts",
      // reaction-dispatch tests (#2291) use bun:test — run via test:bun.
      "**/telegram-plugin/tests/reaction-dispatch.test.ts",
      // status-query-telemetry.test.ts uses bun:test (truthful-telemetry PR) —
      // excluded here, run via test:bun.
      "**/telegram-plugin/tests/status-query-telemetry.test.ts",
      // agent-state-dir-preload.test.ts is the runtime alarm for the BUN half
      // of the state-dir guard (bunfig.toml `[test] preload`) — it must run
      // under bun by definition. The vitest half is pinned by
      // tests/agent-state-dir-guard.test.ts.
      "**/telegram-plugin/tests/agent-state-dir-preload.test.ts",
      // hindsight-bank-preload.test.ts is the runtime alarm for the BUN half
      // of the Hindsight bank guard (bunfig.toml `[test] preload`) — it must
      // run under bun by definition (same shape as the state-dir alarm
      // above). The vitest half is pinned by tests/hindsight-bank-guard.test.ts.
      "**/telegram-plugin/tests/hindsight-bank-preload.test.ts",
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
