import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectHindsightPluginTreeDrift } from "../src/agents/drift.js";

/**
 * #4779 — the vendored hindsight-memory plugin's scripts/ tree must match the
 * release build, guarded by a CONTENT HASH, not the manifest `version` string
 * (which sat at 0.4.0 across the whole M4/M5 rewrite and so could not surface
 * the drift). `detectHindsightPluginTreeDrift` fires whenever an agent has a
 * plugin tree that diverges from the release build — and deliberately does NOT
 * gate on auto_recall, which is exactly how the pre-existing rows missed
 * test-harness's frozen pre-M4 tree.
 *
 * The release build is resolved via SWITCHROOM_HINDSIGHT_VENDOR_ROOT (the
 * shipped-asset env override), so these tests are fully hermetic — they never
 * touch the repo's real vendor/ tree.
 */
describe("detectHindsightPluginTreeDrift (#4779 plugin build drift)", () => {
  let tmpDir: string;
  let releaseDir: string;
  let agentDir: string;
  let prevVendorRoot: string | undefined;

  const AGENT = "probe";

  /** Write a scripts/ tree (relPath -> contents) under `root`. */
  function writeScripts(root: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, "scripts", rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
  }

  const RELEASE_FILES: Record<string, string> = {
    "recall.py": "# recall\nprint('recall')\n",
    "retain.py": "# retain\nprint('retain')\n",
    "prefetch.py": "# M4 async prefetch\nprint('prefetch')\n",
    "lib/recall_buffer.py": "# M4 recall buffer\nBUF = 1\n",
    "lib/config.py": "# config\nCFG = {}\n",
  };

  const agentPluginRoot = () =>
    join(agentDir, ".claude", "plugins", "hindsight-memory");

  beforeEach(() => {
    tmpDir = join(tmpdir(), `plugin-drift-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    releaseDir = join(tmpDir, "release", "vendor", "hindsight-memory");
    agentDir = join(tmpDir, "agents", AGENT);
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeScripts(releaseDir, RELEASE_FILES);
    prevVendorRoot = process.env.SWITCHROOM_HINDSIGHT_VENDOR_ROOT;
    process.env.SWITCHROOM_HINDSIGHT_VENDOR_ROOT = releaseDir;
  });

  afterEach(() => {
    if (prevVendorRoot === undefined) delete process.env.SWITCHROOM_HINDSIGHT_VENDOR_ROOT;
    else process.env.SWITCHROOM_HINDSIGHT_VENDOR_ROOT = prevVendorRoot;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no plugin tree on disk -> no finding (a memory-off, self-healed agent is clean)", () => {
    expect(detectHindsightPluginTreeDrift(AGENT, agentDir)).toEqual([]);
  });

  it("deployed tree byte-identical to the release build -> no finding", () => {
    writeScripts(agentPluginRoot(), RELEASE_FILES);
    expect(detectHindsightPluginTreeDrift(AGENT, agentDir)).toEqual([]);
  });

  it("stale tree MISSING the M4 files (the test-harness case) -> finding names them", () => {
    // June-shaped tree: no prefetch.py, no lib/recall_buffer.py.
    const stale = { ...RELEASE_FILES };
    delete stale["prefetch.py"];
    delete stale["lib/recall_buffer.py"];
    writeScripts(agentPluginRoot(), stale);

    const findings = detectHindsightPluginTreeDrift(AGENT, agentDir);
    expect(findings).toHaveLength(1);
    expect(findings[0].surface).toBe("memory-plugin-build");
    expect(findings[0].agent).toBe(AGENT);
    expect(findings[0].detail).toContain("prefetch.py");
    expect(findings[0].detail).toContain("lib/recall_buffer.py");
    expect(findings[0].detail).toContain("missing");
  });

  it("a script whose CONTENT diverges (same version string) -> finding, marked changed", () => {
    const drifted = { ...RELEASE_FILES, "recall.py": "# OLD recall body\nprint('old')\n" };
    writeScripts(agentPluginRoot(), drifted);

    const findings = detectHindsightPluginTreeDrift(AGENT, agentDir);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("changed");
    expect(findings[0].detail).toContain("recall.py");
  });

  it("a stale-extra file not in the release build -> finding", () => {
    const withExtra = { ...RELEASE_FILES, "legacy_hook.py": "# removed upstream\n" };
    writeScripts(agentPluginRoot(), withExtra);

    const findings = detectHindsightPluginTreeDrift(AGENT, agentDir);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("stale-extra");
    expect(findings[0].detail).toContain("legacy_hook.py");
  });

  it("ignores build/edit exhaust (__pycache__, *.pyc, *.bak) so it is not false-positive drift", () => {
    writeScripts(agentPluginRoot(), RELEASE_FILES);
    const scripts = join(agentPluginRoot(), "scripts");
    mkdirSync(join(scripts, "__pycache__"), { recursive: true });
    writeFileSync(join(scripts, "__pycache__", "recall.cpython-311.pyc"), "bytecode");
    writeFileSync(join(scripts, "recall.py.bak-20260725-memfix"), "old backup");
    writeFileSync(join(scripts, "recall.pyc"), "loose bytecode");

    expect(detectHindsightPluginTreeDrift(AGENT, agentDir)).toEqual([]);
  });
});
