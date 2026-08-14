/**
 * Outcome tests for `scripts/cut-changelog-release.mjs` — the release-time
 * assembler that folds `changelog.d/` fragments (plus anything hand-staged
 * under `## Unreleased`) into the `## vX.Y.Z — <summary>` section, re-seeds an
 * empty staging area, and deletes the consumed fragments.
 *
 * The load-bearing property is the ROUND-TRIP: the section this script writes
 * is exactly what `release.yml`'s guard job later reads back through
 * `scripts/ci/extract-changelog-section.mjs` to auto-create the draft GitHub
 * Release (#4331). So the green cases assert through the REAL extractor and
 * the REAL entry guard, not through this script's own return values — if the
 * two ever disagree about what a section is, these tests are where it shows.
 *
 * Non-vacuity: the refusal cases assert exit 1 with the specific error (they
 * fail if the fail-loud paths are neutered to warnings); the assembly cases
 * assert exact bullet text present in the extractor's output (they fail if
 * assembly drops or misplaces a fragment); the deletion case asserts the
 * fragment files are GONE (it fails if the cut stops consuming them, which
 * would replay every entry into the next release).
 */
import { describe, expect, it, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const CUT = join(repoRoot, "scripts", "cut-changelog-release.mjs");

// The REAL downstream consumer: release.yml's guard feeds the tagged commit's
// CHANGELOG.md through this to auto-create the draft release.
const { extractSection } = await import(
  join(repoRoot, "scripts", "ci", "extract-changelog-section.mjs")
);
// The REAL entry guard: the re-seeded ## Unreleased must read as EMPTY to it.
const { extractUnreleasedEntries } = await import(
  join(repoRoot, "scripts", "check-changelog-entry.mjs")
);

const SEED_CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "<!-- staging area; per-PR notes are fragments under changelog.d/ -->",
  "",
  "## v0.21.10 — the previous release",
  "",
  "- **Something shipped (#1):** prose.",
  "",
].join("\n");

const scratchRoots: string[] = [];

interface Fixture {
  dir: string;
  writeFile: (rel: string, body: string) => void;
  readChangelog: () => string;
  listFragments: () => string[];
  cut: (args?: string[]) => { code: number; out: string };
}

function makeFixture(prefix: string, initialChangelog: string = SEED_CHANGELOG): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  // A bare `git init` pins resolveRepoRoot to THIS dir (hermetic against any
  // enclosing repo), without needing an identity — no commits are made.
  execFileSync("git", ["init", "--quiet", dir], { encoding: "utf-8" });

  const writeFile = (rel: string, body: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  writeFile("CHANGELOG.md", initialChangelog);

  return {
    dir,
    writeFile,
    readChangelog: () => readFileSync(join(dir, "CHANGELOG.md"), "utf-8"),
    listFragments() {
      const fragDir = join(dir, "changelog.d");
      return existsSync(fragDir) ? readdirSync(fragDir).sort() : [];
    },
    cut(args = ["--version", "v0.21.11", "--summary", "a test cut"]) {
      const r = spawnSync(process.execPath, [CUT, ...args], {
        cwd: dir,
        encoding: "utf-8",
      });
      return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

afterAll(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
});

describe("cut-changelog-release — assembles fragments into an extractable release section", () => {
  it("groups by type, deletes the fragments, and the REAL extractor round-trips the section", () => {
    const f = makeFixture("cut-roundtrip-");
    f.writeFile("changelog.d/4720-add-a-verb.feat.md", "- **cli: add a verb (#4720)**\n");
    f.writeFile("changelog.d/4721-fix-a-thing.fix.md", "- **gateway: fix a thing (#4721)**\n");
    f.writeFile("changelog.d/4722-untyped-note.md", "- **an ungrouped note (#4722)**\n");
    f.writeFile("changelog.d/README.md", "# convention doc\n");

    const r = f.cut(["--version", "v0.21.11", "--summary", "verbs and fixes"]);
    expect(r.code).toBe(0);

    const after = f.readChangelog();
    const section = extractSection(after, "v0.21.11");
    expect(section.found).toBe(true);
    if (!section.found) throw new Error("unreachable");
    expect(section.title).toBe("v0.21.11 — verbs and fixes");
    expect(section.notes).toContain("### Features");
    expect(section.notes).toContain("- **cli: add a verb (#4720)**");
    expect(section.notes).toContain("### Bug fixes");
    expect(section.notes).toContain("- **gateway: fix a thing (#4721)**");
    // Untyped fragment: present, ungrouped, ABOVE the first category group.
    expect(section.notes).toContain("- **an ungrouped note (#4722)**");
    expect(section.notes.indexOf("(#4722)")).toBeLessThan(section.notes.indexOf("### Features"));

    // Consumed fragments are deleted; the convention doc survives.
    expect(f.listFragments()).toEqual(["README.md"]);

    // The released history below is intact.
    expect(extractSection(after, "v0.21.10").found).toBe(true);
    expect(after).toContain("- **Something shipped (#1):** prose.");
  });

  it("re-seeds an ## Unreleased the entry guard reads as EMPTY", () => {
    const f = makeFixture("cut-reseed-");
    f.writeFile("changelog.d/1-a-change.fix.md", "- **a change (#1)**\n");
    expect(f.cut().code).toBe(0);

    const after = f.readChangelog();
    // Header present (the guard needs a staging section to exist)…
    expect(after).toMatch(/^## Unreleased$/m);
    // …but with ZERO countable entries: only the convention comment sits in it.
    expect(extractUnreleasedEntries(after)).toEqual([]);
    // And the fragment's bullet did not leak into the staging area.
    const unreleasedIdx = after.indexOf("## Unreleased");
    const sectionIdx = after.indexOf("## v0.21.11");
    expect(unreleasedIdx).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("(#1)**")).toBeGreaterThan(sectionIdx);
    expect(sectionIdx).toBeGreaterThan(unreleasedIdx);
  });

  it("folds hand-staged ## Unreleased content in, merging bullets into an existing category group", () => {
    const HAND_STAGED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "<!-- convention comment to be dropped -->",
      "",
      "### Bug fixes",
      "",
      "- **hand-written fix (#10)**",
      "",
      "## v0.21.10 — the previous release",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("cut-carry-", HAND_STAGED);
    f.writeFile("changelog.d/11-fragment-fix.fix.md", "- **fragment fix (#11)**\n");

    expect(f.cut().code).toBe(0);
    const after = f.readChangelog();
    const section = extractSection(after, "v0.21.11");
    expect(section.found).toBe(true);
    if (!section.found) throw new Error("unreachable");
    // Both notes present, under ONE Bug fixes heading (merged, not duplicated).
    expect(section.notes).toContain("- **hand-written fix (#10)**");
    expect(section.notes).toContain("- **fragment fix (#11)**");
    expect(section.notes.match(/### Bug fixes/g)).toHaveLength(1);
    // The old convention comment does not ride into the release notes.
    expect(section.notes).not.toContain("convention comment to be dropped");
  });

  it("a pasted `## vN.N.N` inside a code fence does not truncate the carry or the history", () => {
    const FENCED = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- **an entry whose body pastes CI output (#12):**",
      "",
      "```console",
      "## v9.9.9 — a pasted heading, NOT a section",
      "```",
      "",
      "## v0.21.10 — the previous release",
      "",
      "- **Something shipped (#1):** prose.",
      "",
    ].join("\n");
    const f = makeFixture("cut-fence-", FENCED);

    expect(f.cut().code).toBe(0);
    const after = f.readChangelog();
    const section = extractSection(after, "v0.21.11");
    expect(section.found).toBe(true);
    if (!section.found) throw new Error("unreachable");
    expect(section.notes).toContain("(#12)");
    // The pasted heading rides INSIDE the new release section (between its
    // heading and the previous release's) — the cut did not treat it as a
    // section boundary. Asserted on the raw file rather than the extractor's
    // `notes`: extract-changelog-section itself is deliberately
    // node-stdlib-only and NOT fence-aware, so it reads the pasted line as a
    // heading and truncates there — a pre-existing residual of that extractor
    // (same on main), out of scope for the cut and not what this test pins.
    const pastedIdx = after.indexOf("## v9.9.9 — a pasted heading, NOT a section");
    expect(pastedIdx).toBeGreaterThan(after.indexOf("## v0.21.11"));
    expect(pastedIdx).toBeLessThan(after.indexOf("## v0.21.10"));
    expect(extractSection(after, "v0.21.10").found).toBe(true);
  });
});

describe("cut-changelog-release — fail loud, never invent", () => {
  it("refuses to cut when there is NOTHING to release", () => {
    const f = makeFixture("cut-empty-");
    const r = f.cut();
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing to release");
    // And it wrote nothing.
    expect(f.readChangelog()).toBe(SEED_CHANGELOG);
  });

  it("refuses a double cut (section for the version already exists)", () => {
    const f = makeFixture("cut-double-");
    f.writeFile("changelog.d/1-x.fix.md", "- **x (#1)**\n");
    const r = f.cut(["--version", "v0.21.10", "--summary", "again"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already exists");
    expect(f.listFragments()).toEqual(["1-x.fix.md"]);
  });

  it("refuses a malformed version and a missing summary", () => {
    const f = makeFixture("cut-badargs-");
    f.writeFile("changelog.d/1-x.fix.md", "- **x (#1)**\n");
    expect(f.cut(["--version", "0.21.11-nope-", "--summary", "s"]).code).toBe(1);
    expect(f.cut(["--version", "not-a-version", "--summary", "s"]).code).toBe(1);
    const noSummary = f.cut(["--version", "v0.21.11"]);
    expect(noSummary.code).toBe(1);
    expect(noSummary.out).toContain("--summary");
    expect(f.readChangelog()).toBe(SEED_CHANGELOG);
  });

  it("--dry-run prints the assembled section but writes and deletes nothing", () => {
    const f = makeFixture("cut-dry-");
    f.writeFile("changelog.d/1-x.fix.md", "- **x (#1)**\n");
    const r = f.cut(["--version", "v0.21.11", "--summary", "s", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY RUN");
    expect(r.out).toContain("- **x (#1)**");
    expect(f.readChangelog()).toBe(SEED_CHANGELOG);
    expect(f.listFragments()).toEqual(["1-x.fix.md"]);
  });
});
