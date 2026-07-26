/**
 * agent-state-dir-guard — a vitest setup file that stops a unit test writing
 * into a LIVE agent's state dir.
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
 * Wired as a `test.setupFiles` entry, so it runs in every vitest worker BEFORE
 * the test module (and its module-level env writes) is imported. If
 * `SWITCHROOM_AGENT_STATE_DIR` is already set — a test that chose its own
 * tmpdir, or a deliberate override — it is left alone. Otherwise it points at a
 * per-worker tmpdir, so the default can never be a real agent's state dir.
 *
 * Same shape as the sibling `auth-net-guard.mjs`: enforced by the runner, with
 * no per-file opt-in to forget.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SWITCHROOM_AGENT_STATE_DIR) {
  process.env.SWITCHROOM_AGENT_STATE_DIR = mkdtempSync(
    join(tmpdir(), "switchroom-vitest-agent-state-"),
  );
}
