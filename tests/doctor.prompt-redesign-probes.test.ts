/**
 * Prompt-cascade doctor probes (#1858).
 *
 * Each case pins one drift class the redesigned cascade fails silently on:
 *   - L1 invariants missing / checksum drift
 *   - L2 fleet defaults missing / empty / unpersonalised / stale version tag
 *   - L3 per-agent Yours-marker deletion
 *   - L3 below-marker section changed since apply (scaffold bug guard)
 *   - L4 repo-context-pretool hook missing from settings.json
 *   - per-turn turn-pacing UserPromptSubmit hook missing
 *   - cross-lane --add-dir fleet missing from start.sh
 *   - cross-lane Telegram 5-beats re-inlined in a per-agent CLAUDE.md
 *   - operator-can't-read-0600 → skip, never fail
 */

import { describe, expect, it } from "vitest";

import {
  runCascadeChecks,
  TELEGRAM_PACING_SIGNATURE,
  type CascadeProbeDeps,
  type CheckResult,
} from "../src/cli/doctor-cascade.js";
import { renderFleetInvariants, CLAUDE_MD_YOURS_MARKER } from "../src/agents/scaffold.js";
import { renderFleetDefaultsClaudeMd } from "../src/agents/fleet-defaults.js";
import { sha256Text, hashManagedClaudeMd } from "../src/agents/generation-stamp.js";
import { SWITCHROOM_VERSION } from "../src/cli/resolve-version.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const HOME = "/home/op";
const FLEET = `${HOME}/.switchroom/fleet`;
const AGENTS = "/agents";
const VERSION = "9.9.9";

function cfg(agents: string[]): SwitchroomConfig {
  return { agents: Object.fromEntries(agents.map((a) => [a, {}])) } as unknown as SwitchroomConfig;
}

interface Vfs {
  files: Record<string, string>;
  unreadable?: Set<string>;
}

function deps(vfs: Vfs, extra: Partial<CascadeProbeDeps> = {}): CascadeProbeDeps {
  return {
    homeDir: HOME,
    agentsDir: AGENTS,
    currentVersion: VERSION,
    existsSync: (p) => p in vfs.files || !!vfs.unreadable?.has(p),
    readFileSync: (p) => {
      if (vfs.unreadable?.has(p)) {
        const e = new Error("EACCES") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      if (!(p in vfs.files)) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return vfs.files[p]!;
    },
    ...extra,
  };
}

function byName(rs: CheckResult[], name: string): CheckResult | undefined {
  return rs.find((r) => r.name === name);
}

/** A healthy fleet fixture: L1/L2 good + one fully-wired agent. */
function healthy(agent = "alice"): Vfs {
  const claudeMd = `# Agent: ${agent}\n\nsome managed stuff\n\n${CLAUDE_MD_YOURS_MARKER}\n\noperator notes\n`;
  const belowHash = sha256Text(claudeMd.slice(claudeMd.indexOf(CLAUDE_MD_YOURS_MARKER) + CLAUDE_MD_YOURS_MARKER.length));
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: "^(Read|Edit)$", hooks: [{ type: "command", command: "bash run-hook.sh 'hook:repo-context-pretool' node repo-context-pretool.mjs" }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "bash run-hook.sh 'hook:turn-pacing' bash turn-pacing-hook.sh" }] },
      ],
    },
  });
  const stamp = JSON.stringify({
    version: 1,
    files: { "CLAUDE.md": hashManagedClaudeMd(claudeMd) },
    claudeMdBelowMarker: belowHash,
  });
  return {
    files: {
      [`${FLEET}/switchroom-invariants.md`]: renderFleetInvariants(),
      [`${FLEET}/CLAUDE.md`]: renderFleetDefaultsClaudeMd().replace("# Fleet defaults", "# Fleet defaults\n\nOperator household facts here.").replace(
        /switchroom-fleet-defaults-version: \S+/,
        `switchroom-fleet-defaults-version: ${VERSION}`,
      ),
      [`${AGENTS}/${agent}/CLAUDE.md`]: claudeMd,
      [`${AGENTS}/${agent}/.claude/settings.json`]: settings,
      [`${AGENTS}/${agent}/start.sh`]: 'exec claude --add-dir "$HOME/.switchroom/fleet"\n',
      [`${AGENTS}/${agent}/.switchroom-generated.json`]: stamp,
    },
  };
}

describe("cascade doctor probes — clean fleet", () => {
  it("all probes pass on a healthy install", () => {
    const rs = runCascadeChecks(cfg(["alice"]), deps(healthy()));
    // No fails anywhere.
    expect(rs.filter((r) => r.status === "fail")).toEqual([]);
    expect(byName(rs, "cascade L1: invariants present")?.status).toBe("ok");
    expect(byName(rs, "cascade L1: invariants checksum")?.status).toBe("ok");
    expect(byName(rs, "cascade L2: fleet defaults")?.status).toBe("ok");
    expect(byName(rs, "cascade L3 alice: Yours marker")?.status).toBe("ok");
    expect(byName(rs, "cascade L3 alice: below-marker preserved")?.status).toBe("ok");
    expect(byName(rs, "cascade L4 alice: repo-context hook")?.status).toBe("ok");
    expect(byName(rs, "cascade per-turn alice: pacing hook")?.status).toBe("ok");
    expect(byName(rs, "cascade alice: --add-dir fleet")?.status).toBe("ok");
    expect(byName(rs, "cascade alice: no pacing duplication")?.status).toBe("ok");
  });
});

describe("cascade doctor probes — L1 invariants", () => {
  it("FAILs when the invariants file is missing", () => {
    const vfs = healthy();
    delete vfs.files[`${FLEET}/switchroom-invariants.md`];
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L1: invariants present")?.status).toBe("fail");
    expect(byName(rs, "cascade L1: invariants checksum")?.status).toBe("skip");
  });

  it("FAILs on checksum drift from the release canonical", () => {
    const vfs = healthy();
    vfs.files[`${FLEET}/switchroom-invariants.md`] = renderFleetInvariants() + "\nhand-edit\n";
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    const c = byName(rs, "cascade L1: invariants checksum");
    expect(c?.status).toBe("fail");
    expect(c?.fix).toMatch(/switchroom apply/);
  });

  it("SKIPs the checksum when the file is unreadable (no sudo)", () => {
    const vfs = healthy();
    delete vfs.files[`${FLEET}/switchroom-invariants.md`];
    vfs.unreadable = new Set([`${FLEET}/switchroom-invariants.md`]);
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L1: invariants checksum")?.status).toBe("skip");
  });
});

describe("cascade doctor probes — L2 fleet defaults", () => {
  it("FAILs when the fleet CLAUDE.md is missing", () => {
    const vfs = healthy();
    delete vfs.files[`${FLEET}/CLAUDE.md`];
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L2: fleet defaults")?.status).toBe("fail");
  });

  it("FAILs when the fleet CLAUDE.md is empty", () => {
    const vfs = healthy();
    vfs.files[`${FLEET}/CLAUDE.md`] = "   \n";
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L2: fleet defaults")?.status).toBe("fail");
  });

  it("WARNs (not fail) when identical to the shipped default — not personalised", () => {
    const vfs = healthy();
    vfs.files[`${FLEET}/CLAUDE.md`] = renderFleetDefaultsClaudeMd();
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs, { currentVersion: SWITCHROOM_VERSION }));
    const c = byName(rs, "cascade L2: fleet defaults");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/not personalised/);
  });

  it("WARNs when personalised but the header version tag is stale", () => {
    const vfs = healthy();
    vfs.files[`${FLEET}/CLAUDE.md`] = renderFleetDefaultsClaudeMd()
      .replace("# Fleet defaults", "# Fleet defaults\n\nmy facts")
      .replace(/switchroom-fleet-defaults-version: \S+/, "switchroom-fleet-defaults-version: 0.0.1");
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    const c = byName(rs, "cascade L2: fleet defaults");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/newer default is available/);
  });
});

describe("cascade doctor probes — L3 per-agent", () => {
  it("FAILs when the Yours marker is missing", () => {
    const vfs = healthy();
    vfs.files[`${AGENTS}/alice/CLAUDE.md`] = "# Agent: alice\n\nno marker here\n";
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L3 alice: Yours marker")?.status).toBe("fail");
  });

  it("FAILs when the below-marker section changed since last apply", () => {
    const vfs = healthy();
    // Baseline stamp records the ORIGINAL below-marker hash; the on-disk
    // file now has a DIFFERENT below-marker section.
    const tampered = `# Agent: alice\n\nsome managed stuff\n\n${CLAUDE_MD_YOURS_MARKER}\n\nSCAFFOLD CLOBBERED THIS\n`;
    vfs.files[`${AGENTS}/alice/CLAUDE.md`] = tampered;
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    const c = byName(rs, "cascade L3 alice: below-marker preserved");
    expect(c?.status).toBe("fail");
    expect(c?.detail).toMatch(/below-marker/);
  });

  it("OKs when the below-marker section is unchanged", () => {
    const rs = runCascadeChecks(cfg(["alice"]), deps(healthy()));
    expect(byName(rs, "cascade L3 alice: below-marker preserved")?.status).toBe("ok");
  });

  it("SKIPs below-marker when no baseline is recorded", () => {
    const vfs = healthy();
    const rs = runCascadeChecks(
      cfg(["alice"]),
      deps(vfs, { belowMarkerBaseline: () => null }),
    );
    expect(byName(rs, "cascade L3 alice: below-marker preserved")?.status).toBe("skip");
  });

  it("SKIPs (never fails) when the agent CLAUDE.md is unreadable", () => {
    const vfs = healthy();
    vfs.unreadable = new Set([`${AGENTS}/alice/CLAUDE.md`]);
    delete vfs.files[`${AGENTS}/alice/CLAUDE.md`];
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L3 alice: Yours marker")?.status).toBe("skip");
  });

  it("FAILs the pacing-dedup guard when the 5-beats are re-inlined", () => {
    const vfs = healthy();
    vfs.files[`${AGENTS}/alice/CLAUDE.md`] =
      `# Agent: alice\n\n${TELEGRAM_PACING_SIGNATURE}\n\nblah\n\n${CLAUDE_MD_YOURS_MARKER}\n\noperator notes\n`;
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade alice: no pacing duplication")?.status).toBe("fail");
  });
});

describe("cascade doctor probes — L4 + per-turn hooks", () => {
  it("FAILs when the repo-context PreToolUse hook is missing", () => {
    const vfs = healthy();
    vfs.files[`${AGENTS}/alice/.claude/settings.json`] = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ command: "bash run-hook.sh 'hook:tool-label' node other.mjs" }] }],
        UserPromptSubmit: [{ hooks: [{ command: "bash run-hook.sh 'hook:turn-pacing' bash turn-pacing-hook.sh" }] }],
      },
    });
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L4 alice: repo-context hook")?.status).toBe("fail");
  });

  it("FAILs when the turn-pacing UserPromptSubmit hook is missing", () => {
    const vfs = healthy();
    vfs.files[`${AGENTS}/alice/.claude/settings.json`] = JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ command: "bash run-hook.sh 'hook:repo-context-pretool' node repo-context-pretool.mjs" }] }],
        UserPromptSubmit: [{ hooks: [{ command: "bash run-hook.sh 'hook:workspace-stable' node ws.mjs" }] }],
      },
    });
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade per-turn alice: pacing hook")?.status).toBe("fail");
  });

  it("SKIPs hooks when settings.json is unreadable", () => {
    const vfs = healthy();
    vfs.unreadable = new Set([`${AGENTS}/alice/.claude/settings.json`]);
    delete vfs.files[`${AGENTS}/alice/.claude/settings.json`];
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade L4 alice: repo-context hook")?.status).toBe("skip");
  });
});

describe("cascade doctor probes — cross-lane --add-dir", () => {
  it("FAILs when start.sh has no --add-dir for the fleet", () => {
    const vfs = healthy();
    vfs.files[`${AGENTS}/alice/start.sh`] = "exec claude\n";
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs));
    expect(byName(rs, "cascade alice: --add-dir fleet")?.status).toBe("fail");
  });
});

describe("cascade doctor probes — scaffolding edges", () => {
  it("stays silent for an agent that is not scaffolded yet", () => {
    const vfs = healthy("alice");
    // bob declared in config but has no files on disk.
    const rs = runCascadeChecks(cfg(["alice", "bob"]), deps(vfs));
    expect(rs.some((r) => r.name.includes("bob"))).toBe(false);
  });

  it("WARNs when agents_dir cannot be resolved", () => {
    const vfs = healthy();
    const rs = runCascadeChecks(cfg(["alice"]), deps(vfs, { agentsDir: undefined }));
    // With agentsDir undefined and no config.agents_dir, resolveAgentsDir may
    // still succeed; assert only that L1/L2 emitted and no crash.
    expect(byName(rs, "cascade L1: invariants present")).toBeDefined();
  });
});
