/**
 * `switchroom doctor` — "Claude CLI floor (#1978)" section.
 *
 * These assert the OPERATOR-VISIBLE `CheckResult` (name/status/detail/fix),
 * not an internal predicate: the row is the whole product here, and the
 * strings are what an operator acts on. The point of the check is that PR
 * 3814's narrowing of `isAdaptiveThinkingOpus()` to `claude-opus-4*` is only
 * sound while the container is actually running claude-code >= 2.1.156 — so
 * a stale CLI under an Opus 5 / `opus`-alias fleet at `medium` effort must
 * produce a warn that names the exposure, and a healthy one must stay quiet.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseClaudeCliVersion,
  claudeCliMeetsFloor,
  readPinnedClaudeCliVersion,
  buildClaudeCliProbeScript,
  parseClaudeCliProbeOutput,
  assessClaudeCliFloor,
  runClaudeCliVersionChecks,
  type ClaudeCliProbe,
} from "../src/cli/doctor-claude-cli.js";
import {
  CLAUDE_CLI_THINKING_MERGE_FIX_VERSION,
  emitsAdaptiveThinking,
  isRiskyThinkingEffort,
} from "../src/config/thinking-effort-risk.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const FLOOR = CLAUDE_CLI_THINKING_MERGE_FIX_VERSION;

function makeConfig(
  defaults: Record<string, unknown>,
  agents: Record<string, unknown>,
): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "-100" },
    defaults,
    agents,
  } as unknown as SwitchroomConfig;
}

// ─────────────────────────────────────────────────────────────────────────

describe("claude CLI floor — the shared constant is the only source of truth", () => {
  it("the Dockerfile.base pin is at or above the #1978 fix floor", () => {
    // If someone pins the base image BELOW the floor, every freshly built
    // container is exposed and the narrowed config-time guard is wrong for
    // the whole fleet. Derive both sides; never restate either.
    const pinned = readPinnedClaudeCliVersion();
    expect(pinned).not.toBeNull();
    expect(claudeCliMeetsFloor(pinned!, FLOOR)).toBe(true);
  });

  it("the Dockerfile.hindsight pin is at or above the #1978 fix floor", () => {
    // Dockerfile.hindsight installs claude SEPARATELY — it does not derive
    // from the base image — so the assertion above says nothing about it. A
    // hindsight bundle left below the floor ships the reflection path on a
    // CLI missing the thinking-merge fix (the exact agent/hindsight skew
    // #1978 is about) while every other check stays green. That the two pins
    // are EQUAL is enforced by scripts/check-claude-cli-lockstep.mjs; this is
    // the floor half of the same contract.
    const pinned = readPinnedClaudeCliVersion(
      resolve(import.meta.dirname, "../docker/Dockerfile.hindsight"),
    );
    expect(pinned).not.toBeNull();
    expect(claudeCliMeetsFloor(pinned!, FLOOR)).toBe(true);
  });

  it("nothing outside thinking-effort-risk.ts re-types the floor literal", () => {
    // The floor must live in exactly one place. Both the doctor check and
    // the config-time guard's reason string interpolate the constant.
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/cli/doctor-claude-cli.ts"),
      "utf-8",
    );
    expect(src).toContain("CLAUDE_CLI_THINKING_MERGE_FIX_VERSION");
    // Prose in the module header may cite the version; executable code must
    // not. Strip block comments and line comments before asserting.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain(FLOOR);
  });
});

describe("parseClaudeCliVersion", () => {
  it("parses the `claude --version` banner", () => {
    expect(parseClaudeCliVersion("2.1.219 (Claude Code)")).toEqual([2, 1, 219]);
  });

  it("returns null for an unrecognised banner rather than a zero version", () => {
    // A CLI whose output format changes must read as "unknown" (→ skip),
    // never as 0.0.0 (→ a false "catastrophically stale" warn).
    expect(parseClaudeCliVersion("Claude Code v-next")).toBeNull();
    expect(parseClaudeCliVersion("")).toBeNull();
  });
});

describe("claudeCliMeetsFloor", () => {
  it("compares patch numerically, not lexically", () => {
    // The bug this guards: "2.1.99" > "2.1.156" as strings.
    expect(claudeCliMeetsFloor("2.1.99", "2.1.156")).toBe(false);
    expect(claudeCliMeetsFloor("2.1.219", "2.1.156")).toBe(true);
  });

  it("treats the floor itself as meeting the floor", () => {
    expect(claudeCliMeetsFloor("2.1.156", "2.1.156")).toBe(true);
  });

  it("compares minor and major too", () => {
    expect(claudeCliMeetsFloor("2.0.999", "2.1.156")).toBe(false);
    expect(claudeCliMeetsFloor("3.0.0", "2.1.156")).toBe(true);
  });

  it("returns null when the version is unparseable", () => {
    expect(claudeCliMeetsFloor("nightly", "2.1.156")).toBeNull();
  });
});

describe("readPinnedClaudeCliVersion", () => {
  it("extracts the ARG default from a Dockerfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-clifloor-"));
    try {
      const p = join(dir, "Dockerfile.base");
      writeFileSync(
        p,
        "FROM debian\n# ARG CLAUDE_CODE_VERSION=1.0.0 in a comment\nARG CLAUDE_CODE_VERSION=2.1.219\nARG CACHE_BUST=default\n",
      );
      expect(readPinnedClaudeCliVersion(p)).toBe("2.1.219");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the Dockerfile is absent (npm-only install)", () => {
    expect(readPinnedClaudeCliVersion(null)).toBeNull();
    expect(readPinnedClaudeCliVersion("/nonexistent/Dockerfile.base")).toBeNull();
  });
});

describe("buildClaudeCliProbeScript", () => {
  it("resolves claude through start.sh's PATH prefix, not the image's bare PATH", () => {
    // start.sh exports $HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin AHEAD
    // of /usr/local/bin. Probing with the bare exec PATH would report the
    // image binary even when a shadow install is what the session executes —
    // the exact drift that put test-harness on a months-old 2.1.139.
    const script = buildClaudeCliProbeScript();
    expect(script).toContain('$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH');
    expect(script).toContain("command -v claude");
    expect(script).toContain("--version");
    expect(script).toContain("BIN=");
    expect(script).toContain("VER=");
  });
});

describe("parseClaudeCliProbeOutput", () => {
  it("reads bin + version from a successful probe", () => {
    expect(
      parseClaudeCliProbeOutput({
        status: 0,
        stdout: "BIN=/usr/local/bin/claude VER=2.1.219\n",
      }),
    ).toEqual({ state: "read", bin: "/usr/local/bin/claude", raw: "2.1.219" });
  });

  it("reports `missing` only when the probe SUCCEEDED with no binary", () => {
    expect(
      parseClaudeCliProbeOutput({ status: 0, stdout: "BIN= VER=\n" }),
    ).toEqual({ state: "missing" });
  });

  it("reports a non-zero docker exit as unreachable, not missing", () => {
    // exit >= 125 is docker itself failing (no such container / daemon down).
    // Calling that "no claude in the container" would be a fabricated finding.
    const r = parseClaudeCliProbeOutput({
      status: 126,
      stderr: "Error: No such container: switchroom-ghost",
    });
    expect(r.state).toBe("unreachable");
    expect(r).toMatchObject({ msg: "Error: No such container: switchroom-ghost" });
  });

  it("reports a timeout (null status) as unreachable", () => {
    expect(parseClaudeCliProbeOutput({ status: null }).state).toBe("unreachable");
  });
});

// ─── the operator-visible rows ───────────────────────────────────────────

describe("assessClaudeCliFloor — the operator-visible row", () => {
  const base = { agentName: "carrie", exposed: false, pinned: "2.1.219" };

  it("is ok when the container runs a CLI at or above the floor", () => {
    const r = assessClaudeCliFloor({
      ...base,
      probe: { state: "read", bin: "/usr/local/bin/claude", raw: "2.1.219" },
    });
    expect(r.name).toBe("carrie: claude CLI floor");
    expect(r.status).toBe("ok");
    expect(r.detail).toBe("2.1.219 at /usr/local/bin/claude (>= 2.1.156 floor)");
    expect(r.fix).toBeUndefined();
  });

  it("warns and names the #1978 exposure for a stale CLI under an exposed config", () => {
    const r = assessClaudeCliFloor({
      ...base,
      exposed: true,
      probe: {
        state: "read",
        bin: "/state/agent/home/.local/bin/claude",
        raw: "2.1.139",
      },
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe(
      "2.1.139 at /state/agent/home/.local/bin/claude is BELOW the 2.1.156 floor — " +
        "the claude-code build that fixed the #1978 thinking-block merge 400. " +
        "This agent's model and thinking_effort are in the #1978 exposure shape, " +
        "which the config-time guard no longer covers on the assumption of a " +
        ">= 2.1.156 CLI.",
    );
    expect(r.fix).toBe(
      "Restart the agent onto the current image: `switchroom update` then " +
        "`switchroom agent restart carrie --force` (docker/Dockerfile.base pins 2.1.219). " +
        "Until then set `thinking_effort: low` for carrie; on a pre-2.1.156 CLI, " +
        "medium+ effort on an Opus model can 400 with 'thinking blocks cannot be " +
        "modified' when work runs through concurrent sub-agents.",
    );
  });

  it("warns without the effort advice when the config is not in the exposure shape", () => {
    const r = assessClaudeCliFloor({
      ...base,
      exposed: false,
      probe: { state: "read", bin: "/usr/local/bin/claude", raw: "2.1.139" },
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(
      "This agent's model and thinking_effort are not in the #1978 exposure shape.",
    );
    // Telling a Sonnet agent to pin thinking_effort: low would be noise.
    expect(r.fix).not.toContain("thinking_effort");
    expect(r.fix).toContain("switchroom agent restart carrie --force");
  });

  it("omits the pinned target when there is no Dockerfile to read", () => {
    const r = assessClaudeCliFloor({
      ...base,
      pinned: null,
      probe: { state: "read", bin: "/usr/local/bin/claude", raw: "2.1.139" },
    });
    expect(r.status).toBe("warn");
    // Never invent a version we did not read.
    expect(r.fix).not.toContain("Dockerfile.base pins");
    expect(r.fix).toBe(
      "Restart the agent onto the current image: `switchroom update` then " +
        "`switchroom agent restart carrie --force`.",
    );
  });

  it("skips (never fails) when the container could not be reached", () => {
    const r = assessClaudeCliFloor({
      ...base,
      exposed: true,
      probe: { state: "unreachable", msg: "No such container" },
    });
    // Honesty rail: an unreachable container is not evidence of anything.
    expect(r.status).toBe("skip");
    expect(r.detail).toBe(
      "could not read the running claude CLI in switchroom-carrie: No such container",
    );
    expect(r.fix).toBeUndefined();
  });

  it("skips on an unparseable version banner rather than warning", () => {
    const r = assessClaudeCliFloor({
      ...base,
      probe: { state: "read", bin: "/usr/local/bin/claude", raw: "nightly" },
    });
    expect(r.status).toBe("skip");
    expect(r.detail).toBe("unparseable version from /usr/local/bin/claude: nightly");
  });

  it("warns when no claude resolves inside a reachable container", () => {
    const r = assessClaudeCliFloor({ ...base, probe: { state: "missing" } });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe(
      "no `claude` on the session PATH inside switchroom-carrie",
    );
  });
});

// ─── the section ─────────────────────────────────────────────────────────

describe("runClaudeCliVersionChecks", () => {
  const stale = (): ClaudeCliProbe => ({
    state: "read",
    bin: "/usr/local/bin/claude",
    raw: "2.1.139",
  });
  const current = (): ClaudeCliProbe => ({
    state: "read",
    bin: "/usr/local/bin/claude",
    raw: "2.1.219",
  });

  it("flags the live-fleet shape: claude-opus-5 at medium on a stale CLI", () => {
    // /state/config/switchroom.yaml is exactly this shape fleet-wide, and it
    // is precisely what the narrowed config-time guard stopped covering.
    const config = makeConfig(
      { model: "claude-opus-5", thinking_effort: "medium" },
      { assistant: {}, sysadmin: {} },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: stale,
      dockerfilePath: null,
    });
    expect(rows.map((r) => r.name)).toEqual([
      "assistant: claude CLI floor",
      "sysadmin: claude CLI floor",
    ]);
    expect(rows.every((r) => r.status === "warn")).toBe(true);
    expect(rows[0].detail).toContain("are in the #1978 exposure shape");
    expect(rows[0].fix).toContain("`thinking_effort: low` for assistant");
  });

  it("flags the bare `opus` alias at medium too (it resolves to Opus 5)", () => {
    const config = makeConfig(
      { model: "opus", thinking_effort: "medium" },
      { assistant: {} },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: stale,
      dockerfilePath: null,
    });
    expect(rows[0].detail).toContain("are in the #1978 exposure shape");
  });

  it("does not claim exposure for a Sonnet agent on the same stale CLI", () => {
    const config = makeConfig(
      { model: "claude-sonnet-5", thinking_effort: "high" },
      { worker: {} },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: stale,
      dockerfilePath: null,
    });
    expect(rows[0].status).toBe("warn");
    expect(rows[0].detail).toContain("are not in the #1978 exposure shape");
  });

  it("does not claim exposure for an Opus agent left at the low floor", () => {
    const config = makeConfig(
      { model: "claude-opus-5", thinking_effort: "low" },
      { assistant: {} },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: stale,
      dockerfilePath: null,
    });
    expect(rows[0].detail).toContain("are not in the #1978 exposure shape");
  });

  it("resolves per-agent overrides, not just defaults", () => {
    const config = makeConfig(
      { model: "claude-opus-5", thinking_effort: "low" },
      { assistant: {}, sysadmin: { thinking_effort: "max" } },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: stale,
      dockerfilePath: null,
    });
    expect(rows[0].detail).toContain("are not in the #1978 exposure shape");
    expect(rows[1].detail).toContain("are in the #1978 exposure shape");
  });

  it("is silent-ok across the fleet when every container runs a current CLI", () => {
    const config = makeConfig(
      { model: "claude-opus-5", thinking_effort: "medium" },
      { assistant: {}, sysadmin: {} },
    );
    const rows = runClaudeCliVersionChecks(config, {
      probe: current,
      dockerfilePath: null,
    });
    expect(rows.every((r) => r.status === "ok")).toBe(true);
    expect(rows.every((r) => r.fix === undefined)).toBe(true);
  });

  it("emits nothing under --fast (the probe costs a docker exec per agent)", () => {
    const config = makeConfig({}, { assistant: {} });
    let called = 0;
    const rows = runClaudeCliVersionChecks(config, {
      fast: true,
      probe: () => {
        called++;
        return current();
      },
      dockerfilePath: null,
    });
    expect(rows).toEqual([]);
    expect(called).toBe(0);
  });

  it("emits nothing when no agents are configured", () => {
    expect(
      runClaudeCliVersionChecks(makeConfig({}, {}), {
        probe: current,
        dockerfilePath: null,
      }),
    ).toEqual([]);
  });
});

// ─── the widened predicate stays separate from the narrowed guard ────────

describe("emitsAdaptiveThinking / isRiskyThinkingEffort", () => {
  it("covers the whole Opus family, unlike the narrowed config-time guard", () => {
    for (const m of ["opus", "claude-opus-4-8", "claude-opus-5", "CLAUDE-OPUS-5"]) {
      expect(emitsAdaptiveThinking(m)).toBe(true);
    }
  });

  it("does not sweep in Sonnet/Haiku or an unset model", () => {
    for (const m of ["sonnet", "claude-sonnet-5", "haiku", undefined, ""]) {
      expect(emitsAdaptiveThinking(m)).toBe(false);
    }
  });

  it("treats unset and low effort as safe, medium and above as risky", () => {
    expect(isRiskyThinkingEffort(undefined)).toBe(false);
    expect(isRiskyThinkingEffort("low")).toBe(false);
    for (const e of ["medium", "high", "xhigh", "max", "MEDIUM"]) {
      expect(isRiskyThinkingEffort(e)).toBe(true);
    }
  });
});
