/**
 * `defaultSelfUpdateIO().probeBinary` against a REAL executable (#4586
 * follow-up).
 *
 * Every other test around self-update injects a fake `SelfUpdateIO`, so the
 * one thing that actually broke a fleet roll — WHICH ARGV the production
 * probe runs — was covered by nothing. On 2026-08-10 a `pin: v0.21.3` roll
 * refused at `preflight-host-cli-stale` with "the downloaded v0.21.3 binary
 * did not run cleanly on this host (`switchroom version` failed)". The
 * release artifact was fine: its sha256 matched `switchroom-checksums.txt`
 * and it ran and installed by hand minutes later.
 *
 * The probe ran the `version` SUBCOMMAND, which calls `getConfig()` and exits
 * 1 with "Config error: No switchroom.yaml found" wherever there is no
 * `~/.switchroom/switchroom.yaml`. The host-CLI heal helper container mounts
 * the install prefix AND NOTHING ELSE (`host-cli-heal.ts` → `healHelperArgs`)
 * — so the probe could never pass there, and the heal could never succeed.
 *
 * These tests execute a stub binary that reproduces exactly that asymmetry.
 */

import { describe, expect, it, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultSelfUpdateIO } from "./self-update-io.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Same trick as `tests/ci-buildx-warm-pull.test.ts`: this repo's dev hosts and
 * agent containers commonly mount /tmp `noexec`, and a test that needs to
 * EXECUTE a stub must not fail for that unrelated reason. Probe once, fall
 * back to a scratch dir inside the worktree.
 */
function execCapableBase(): string {
  const candidate = mkdtempSync(join(tmpdir(), "probe-argv-"));
  const probe = join(candidate, "probe.sh");
  writeFileSync(probe, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  chmodSync(probe, 0o755);
  try {
    execFileSync(probe, { stdio: "ignore" });
    return candidate;
  } catch {
    rmSync(candidate, { recursive: true, force: true });
    return mkdtempSync(join(REPO, ".probe-argv-test-"));
  }
}

const base = execCapableBase();
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Write `body` as an executable stub named `switchroom` and return its path. */
function stub(body: string, mode = 0o755): string {
  const dir = mkdtempSync(join(base, "case-"));
  const path = join(dir, "switchroom");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

describe("probeBinary argv (#4586 — the heal helper's false negative)", () => {
  it("proves a binary that has no fleet config, exactly like the heal helper's container", () => {
    // The real CLI's shape: `--version` is commander's flag and needs nothing;
    // the `version` SUBCOMMAND loads ~/.switchroom/switchroom.yaml and exits 1
    // without one. A probe that picks the subcommand cannot pass in the heal
    // helper, which mounts no `~/.switchroom`.
    const path = stub(
      [
        'if [ "$1" = "--version" ]; then echo "0.21.3"; exit 0; fi',
        'echo "Config error: No switchroom.yaml found" >&2',
        "exit 1",
      ].join("\n"),
    );

    const probe = defaultSelfUpdateIO().probeBinary(path);

    expect(probe).toEqual({ ok: true, version: "0.21.3" });
  });

  it("reports a binary this host cannot EXECUTE as not-executable, never as a bad artifact", () => {
    // Mode 0644 stands in for the whole exec-refused family: a `noexec`
    // staging mount, a lost +x bit, ENOEXEC under a foreign arch. The
    // artifact's integrity is not in question and the message must not
    // pretend otherwise, or the operator re-downloads a good file forever.
    const path = stub('echo "0.21.3"; exit 0', 0o644);

    const probe = defaultSelfUpdateIO().probeBinary(path);

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("unreachable");
    expect(probe.kind).toBe("not-executable");
    expect(probe.detail).toMatch(/EACCES/);
  });

  it("reports a binary that runs and fails as ran-but-failed — the one verdict that indicts the artifact", () => {
    const path = stub('echo "boom" >&2; exit 3');

    const probe = defaultSelfUpdateIO().probeBinary(path);

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("unreachable");
    expect(probe.kind).toBe("ran-but-failed");
    expect(probe.detail).toContain("exit 3");
    expect(probe.detail).toContain("boom");
  });

  it("reports a clean exit with no parseable version as no-version", () => {
    const path = stub('echo "not a version"; exit 0');

    const probe = defaultSelfUpdateIO().probeBinary(path);

    expect(probe.ok).toBe(false);
    if (probe.ok) throw new Error("unreachable");
    expect(probe.kind).toBe("no-version");
  });
});
