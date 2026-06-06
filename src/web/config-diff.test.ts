import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateUnifiedDiff, ConfigDiffError } from "./config-diff.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("generateUnifiedDiff", () => {
  it("returns empty string when before === after", () => {
    expect(generateUnifiedDiff("same\n", "same\n")).toBe("");
  });

  it.runIf(hasGit)("produces a hunked unified diff for a real change", () => {
    const before = "a: 1\nb: 2\n";
    const after = "a: 1\nb: 3\n";
    const diff = generateUnifiedDiff(before, after);
    expect(diff).toContain("@@");
    expect(diff).toContain("+b: 3");
    expect(diff).toContain("-b: 2");
  });

  it.runIf(hasGit)(
    "round-trips: the diff applies cleanly with the SAME `git apply` flags hostd uses",
    () => {
      // hostd: git apply --whitespace=nowarn --recount --unidiff-zero (-p1).
      const before = "agents:\n  marko: {}\n  ziggy: {}\n";
      const after =
        "agents:\n  marko:\n    microsoft_workspace:\n      account: lisa@outlook.com\n  ziggy: {}\n";
      const diff = generateUnifiedDiff(before, after, "switchroom.yaml");

      const dir = mkdtempSync(join(tmpdir(), "diff-roundtrip-"));
      try {
        // Mirror hostd's applyPatch: live config in scratchDir/<name>,
        // patch in scratchDir/proposal.patch, apply -p1 from scratchDir.
        writeFileSync(join(dir, "switchroom.yaml"), before);
        writeFileSync(join(dir, "proposal.patch"), diff);
        const r = spawnSync(
          "git",
          [
            "apply",
            "--whitespace=nowarn",
            "--recount",
            "--unidiff-zero",
            "-p1",
            "proposal.patch",
          ],
          { cwd: dir, encoding: "utf-8" },
        );
        expect(r.status).toBe(0); // applied cleanly
        expect(readFileSync(join(dir, "switchroom.yaml"), "utf-8")).toBe(after);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("surfaces a generator failure as ConfigDiffError (bad gitBin)", () => {
    expect(() =>
      generateUnifiedDiff("a\n", "b\n", "switchroom.yaml", "/nonexistent/git-binary"),
    ).toThrow(ConfigDiffError);
  });
});
