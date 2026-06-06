/**
 * Generate a git-compatible unified diff for a switchroom.yaml edit.
 *
 * hostd's `config_propose_edit` applies the proposed patch with
 * `git apply --whitespace=nowarn --recount --unidiff-zero` (trying
 * `-p1` then `-p0`) — see src/host-control/config-edit-validator.ts. To
 * guarantee the patch round-trips, we GENERATE it with the same tool
 * family: `git diff --no-index`. The two versions are written to
 * `a/<name>` and `b/<name>` under a scratch dir so the diff carries
 * `--- a/<name>` / `+++ b/<name>` headers that hostd's `-p1` strips back
 * to `<name>` (the basename of its scratch copy of the live config).
 *
 * `git diff --no-index` exits 1 when the files differ (NOT an error) and
 * 0 when identical; any other exit is a real failure.
 */

import {
  mkdirSync,
  mkdtempSync as mkdtemp,
  rmSync as rmrf,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ConfigDiffError extends Error {}

/**
 * Produce a unified diff that transforms `before` into `after`, suitable
 * for hostd's `git apply`. `name` is the target basename (default
 * "switchroom.yaml"). Returns "" when there's no difference.
 *
 * `gitBin` is injectable for tests.
 */
export function generateUnifiedDiff(
  before: string,
  after: string,
  name = "switchroom.yaml",
  gitBin = "git",
): string {
  if (before === after) return "";
  const dir = mkdtemp(join(tmpdir(), "switchroom-config-diff-"));
  try {
    // `git diff --no-index P1 P2` always prefixes the given paths with
    // a/ and b/, so whatever sub-paths we pass would yield headers like
    // `a/cur/<name>`. hostd applies with `-p1` (then `-p0`) against a
    // scratch file named exactly `<name>` — so the header must be the
    // canonical `a/<name>` / `b/<name>` for the single -component strip
    // to land on `<name>`. We diff in sibling dirs then normalize the
    // three path-carrying header lines.
    mkdirSync(join(dir, "cur"), { recursive: true });
    mkdirSync(join(dir, "new"), { recursive: true });
    writeFileSync(join(dir, "cur", name), before);
    writeFileSync(join(dir, "new", name), after);
    const r = spawnSync(
      gitBin,
      ["diff", "--no-index", "--no-color", "--", `cur/${name}`, `new/${name}`],
      { cwd: dir, encoding: "utf-8", timeout: 10_000 },
    );
    // git diff --no-index: 0 = identical, 1 = differ (expected), >1 = error.
    if (r.status === 0) return "";
    if (r.status !== 1) {
      throw new ConfigDiffError(
        `git diff failed (status=${r.status}): ${(r.stderr || r.error?.message || "").toString().trim()}`,
      );
    }
    const raw = r.stdout ?? "";
    if (!raw.includes("@@")) {
      throw new ConfigDiffError("git diff produced no hunks");
    }
    // Normalize header paths → canonical a/<name> b/<name>.
    const diff = raw
      .split("\n")
      .map((line) => {
        if (line.startsWith("diff --git ")) return `diff --git a/${name} b/${name}`;
        if (line.startsWith("--- ")) return `--- a/${name}`;
        if (line.startsWith("+++ ")) return `+++ b/${name}`;
        return line;
      })
      .join("\n");
    return diff;
  } finally {
    try {
      rmrf(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
