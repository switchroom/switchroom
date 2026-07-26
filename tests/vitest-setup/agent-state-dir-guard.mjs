/**
 * agent-state-dir-guard — the test-runner entry point that stops a unit test
 * writing into a LIVE agent's state dir.
 *
 * ── The defect class this closes ────────────────────────────────────────
 *
 * The gateway's turn-record writer used to hard-code
 * `/state/agent/turns.jsonl`. Inside a switchroom agent container that path is
 * the bind-mounted production `~/.switchroom/agents/<name>/turns.jsonl`, so a
 * characterization test that drove the real turn-end funnel appended its
 * synthetic rows — stamped with the test's own `SWITCHROOM_AGENT_NAME`
 * (`chartestagent`) — straight into the host agent's production turn record.
 * The fleet-health L0 sensor then read those rows back as that agent's real
 * production turns: on 2026-07-26 they were 267 of the 377 live silent-no-op
 * candidates across the fleet, making the top-priority ledger entry mostly test
 * fixtures. The tests had carefully isolated `TELEGRAM_STATE_DIR` into a
 * tmpdir; the writer just didn't read it.
 *
 * The path fix (`resolveTurnsJsonlPath`) makes the writer honour
 * `SWITCHROOM_AGENT_STATE_DIR`. This guard makes that isolation automatic:
 * relying on every future test author to remember the env var is exactly the
 * per-file discipline that does not close a defect class.
 *
 * ── Mechanism ───────────────────────────────────────────────────────────
 *
 * Loaded by BOTH runners, before any test module (and its module-level env
 * writes) is imported:
 *
 *   vitest    `test.setupFiles` in vitest.config.ts
 *   bun test  `[test] preload` in bunfig.toml + telegram-plugin/bunfig.toml
 *             (bun reads the bunfig in its cwd; CI runs `bun test` from
 *             telegram-plugin/, `npm run test:bun` from the repo root)
 *
 * If a guarded var is already set — a test that chose its own tmpdir, or a
 * deliberate override — it is left alone. Otherwise it points at a per-process
 * tmpdir (removed at exit), so the default can never be a real agent's state
 * dir.
 *
 * Both wirings are lint-enforced by `npm run lint:agent-state-dir-hermeticity`
 * (`scripts/check-agent-state-dir-hermeticity.mjs`): deleting either one fails
 * CI instead of silently un-protecting a runner. Same shape as the sibling
 * `auth-net-guard.mjs` + `check-auth-test-hermeticity.mjs` pair.
 */
import { installAgentStateDirGuard } from "./agent-state-dir-guard-core.mjs";

installAgentStateDirGuard();
