// tests/switchroom-status-script.test.ts
//
// Regression coverage for `skills/switchroom-status/scripts/status.sh`.
// Prior to the fix, the script had three independent bugs that made it
// always report "0 of N agents running" against a healthy fleet:
//   1. It parsed `switchroom agent list --json` as a bare array, but the
//      real CLI emits `{"agents":[...]}` (src/cli/agent.ts:853,896).
//   2. It read non-existent fields `pid` and `memory.collection` — the
//      real emitted shape has no such fields (src/cli/agent.ts:881-894).
//   3. It compared `status` against `'running'`/`'stopped'`/`'failed'`,
//      but the real lifecycle values are `active`/`inactive`/`exited`/
//      `restarting`/`paused`/`created`/`dead` (src/agents/lifecycle.ts:543-547).
//
// This test feeds a realistic fixture (real `{agents:[...]}` envelope,
// real field names, real `active`/`exited` status values) through a fake
// `switchroom` binary on PATH and asserts the script's own running-count
// summary line is correct — a property the pre-fix script could not
// satisfy no matter how many agents were "running" in the fixture.

import { describe, expect, it } from "vitest";
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "skills/switchroom-status/scripts/status.sh");

// Realistic `switchroom agent list --json` payload — the actual envelope
// and field set emitted by src/cli/agent.ts's `opts.json` branch.
const FIXTURE = {
  agents: [
    {
      name: "assistant",
      status: "active",
      uptime: "2h 14m",
      model: "claude-sonnet-5",
      thinking_effort: "medium",
      extends: "default",
      topic_name: "Assistant",
      topic_emoji: "🤖",
      scheduler: { kind: "idle" },
    },
    {
      name: "dev",
      status: "active",
      uptime: "45m",
      model: "claude-opus-5",
      thinking_effort: "medium",
      extends: "default",
      topic_name: "Dev",
      topic_emoji: "🛠️",
      scheduler: { kind: "active", tasks: 2 },
    },
    {
      name: "coach",
      status: "exited",
      uptime: null,
      model: "claude-sonnet-5",
      thinking_effort: "low",
      extends: "default",
      topic_name: "Coach",
      topic_emoji: "🏋️",
      scheduler: { kind: "idle" },
    },
  ],
};

function runStatusScript(fixture: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "switchroom-status-script-"));
  try {
    // A fake `switchroom` binary that behaves exactly like
    // `switchroom agent list --json` against the fixture above, and errors
    // on anything else so the script's other codepaths aren't accidentally
    // exercised.
    const fakeBinPath = join(dir, "switchroom");
    writeFileSync(
      fakeBinPath,
      `#!/usr/bin/env bash\nif [ "$1" = "agent" ] && [ "$2" = "list" ]; then\n  cat <<'JSON'\n${JSON.stringify(fixture)}\nJSON\n  exit 0\nfi\necho "unexpected invocation: $*" >&2\nexit 1\n`,
    );
    chmodSync(fakeBinPath, 0o755);

    return execFileSync("bash", [SCRIPT_PATH], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("switchroom-status/scripts/status.sh", () => {
  it("counts running agents correctly against the real {agents:[...]} envelope", () => {
    const output = runStatusScript(FIXTURE);

    // Two of the three fixture agents are `active` ("running"); one is
    // `exited`. The pre-fix script always printed "0 of N agents running."
    // regardless of fixture contents (envelope/field/enum mismatches all
    // made `running` count stay at 0 or crash silently to raw JSON dump).
    expect(output).toContain("2 of 3 agents running.");

    // Sanity: real per-agent fields surface correctly.
    expect(output).toContain("assistant");
    expect(output).toContain("dev");
    expect(output).toContain("coach");
    expect(output).toContain("model: claude-sonnet-5");
    expect(output).toContain("model: claude-opus-5");
  });

  it("reports 0 running when every agent is inactive", () => {
    const allDown = {
      agents: FIXTURE.agents.map((a) => ({ ...a, status: "inactive", uptime: null })),
    };
    const output = runStatusScript(allDown);
    expect(output).toContain("0 of 3 agents running.");
  });

  it("handles an empty fleet without crashing", () => {
    const output = runStatusScript({ agents: [] });
    expect(output.trim()).toBe("No agents configured.");
  });
});
