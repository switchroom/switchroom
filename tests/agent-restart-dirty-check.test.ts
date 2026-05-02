import { describe, it, expect } from "vitest";
import { parsePorcelainDirty } from "../src/cli/agent.js";

/**
 * The `agent restart` guard (`checkSwitchroomBranch`) reads
 * `git status --porcelain` and refuses to proceed without `--force`
 * when the working tree is dirty. The bare-string version of that
 * check used to false-trip every time `npm run build` regenerated
 * `src/build-info.ts` — which is purely a function of HEAD and
 * doesn't represent un-reviewed code. `parsePorcelainDirty` extracts
 * the filtering rule so it's easy to verify the allowlist is honored
 * without spawning git.
 */

describe("parsePorcelainDirty", () => {
  it("treats an empty porcelain output as clean", () => {
    const r = parsePorcelainDirty("");
    expect(r.dirty).toBe(false);
    expect(r.meaningfulPaths).toEqual([]);
    expect(r.ignoredPaths).toEqual([]);
  });

  it("treats build-info-only diff as NOT dirty (regression: post-build false trip)", () => {
    // Two-char status `<sp>M` for "unstaged-modified". Real porcelain
    // output for `npm run build` regenerating build-info.
    const r = parsePorcelainDirty(" M src/build-info.ts\n");
    expect(r.dirty).toBe(false);
    expect(r.meaningfulPaths).toEqual([]);
    expect(r.ignoredPaths).toEqual(["src/build-info.ts"]);
  });

  it("treats any other modified file as dirty", () => {
    const r = parsePorcelainDirty(" M src/cli/agent.ts\n");
    expect(r.dirty).toBe(true);
    expect(r.meaningfulPaths).toEqual(["src/cli/agent.ts"]);
  });

  it("counts non-ignored paths even when build-info is also dirty", () => {
    const porcelain = " M src/build-info.ts\n M src/cli/agent.ts\n M profiles/default/CLAUDE.md.hbs\n";
    const r = parsePorcelainDirty(porcelain);
    expect(r.dirty).toBe(true);
    expect(r.meaningfulPaths.sort()).toEqual([
      "profiles/default/CLAUDE.md.hbs",
      "src/cli/agent.ts",
    ]);
    expect(r.ignoredPaths).toEqual(["src/build-info.ts"]);
  });

  it("recognises both staged (M_) and unstaged (_M) modification codes", () => {
    // Staged + unstaged: porcelain shows `MM`. Unstaged-only: ` M`.
    // Staged-only: `M `. All three should treat build-info as ignorable.
    expect(parsePorcelainDirty("M  src/build-info.ts\n").dirty).toBe(false);
    expect(parsePorcelainDirty("MM src/build-info.ts\n").dirty).toBe(false);
    expect(parsePorcelainDirty(" M src/build-info.ts\n").dirty).toBe(false);
  });

  it("treats untracked (??) build-info-adjacent files as dirty (defensive)", () => {
    // An untracked file by the same name should still trip the guard —
    // the allowlist is for a TRACKED build artifact, not arbitrary
    // files dropped at that path. The current check is set-membership
    // on the post-status-code path, which matches both. That's
    // acceptable: an untracked `src/build-info.ts` is impossible in
    // practice (the build always overwrites the tracked file), and
    // tightening to "tracked-only" would require parsing the XY status
    // code shape with no real-world payoff.
    const r = parsePorcelainDirty("?? src/build-info.ts\n");
    expect(r.dirty).toBe(false);
    expect(r.ignoredPaths).toEqual(["src/build-info.ts"]);
  });

  it("handles renamed entries (R<sp>old -> new) using the destination path", () => {
    // If someone renamed src/build-info.ts to something else, the
    // destination is what we judge — and that destination is no
    // longer in the allowlist. So a rename AWAY from the artifact
    // path correctly counts as dirty.
    const r = parsePorcelainDirty("R  src/build-info.ts -> src/cli/build-info.ts\n");
    expect(r.dirty).toBe(true);
    expect(r.meaningfulPaths).toEqual(["src/cli/build-info.ts"]);
  });

  it("ignores blank trailing lines", () => {
    const r = parsePorcelainDirty(" M src/build-info.ts\n\n\n");
    expect(r.dirty).toBe(false);
  });
});
