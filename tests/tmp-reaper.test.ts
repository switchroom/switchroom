/**
 * switchroom-tmp-reaper (bin/tmp-reaper.sh) — the /tmp tmpfs janitor.
 *
 * WHY: an agent's /tmp is a 2 GiB RAM-backed tmpfs (src/agents/compose.ts,
 * DEFAULT_TMP_SIZE). Nothing ages out of a tmpfs, so a long-running container
 * accumulates orphaned scratch until every /tmp write fails ENOSPC — in the
 * victim (`npm ci`, git, the CLI's staging), never at the cause. Measured on
 * a live agent container: 4,462 top-level entries, 490 MiB used, 204 MiB of
 * it two orphaned `bun build --compile` trees from one test run.
 *
 * These tests execute the REAL script against a fixture root and assert
 * OUTCOMES — what is on disk after a pass — not log lines and not that a
 * particular branch was taken. Each of the three safety clauses (subtree
 * age, open files, no symlink escape) has a test that FAILS if that clause
 * is deleted, which is the whole point: a reaper whose guards are untested
 * is a `rm -rf` on a timer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "bin", "tmp-reaper.sh");

/**
 * The fixture root deliberately does NOT live under the system tmpdir: these
 * tests exist because /tmp fills up, and a test suite that stages megabytes
 * of fixtures there to prove it would be part of the problem. `mkdtempSync`
 * against the repo-adjacent build dir keeps the fixtures on the same
 * filesystem the worktree is on (the script traverses with `-xdev`).
 */
const FIXTURE_PARENT = resolve(__dirname, "..", "node_modules", ".cache");

let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  // realpath: the script canonicalises its root (it must, or the
  // /proc/*/fd prefix match never fires), so the fixture path the
  // assertions compare against has to be canonical too. A dev checkout
  // whose node_modules is a symlink otherwise diverges from CI.
  root = realpathSync(mkdtempSync(join(FIXTURE_PARENT, "tmp-reaper-fixture-")));
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Backdate a path's atime AND mtime by `hours`. */
function age(path: string, hours: number): void {
  const t = new Date(Date.now() - hours * 3600_000);
  utimesSync(path, t, t);
}

/**
 * Create `<root>/<name>/<file>` with `bytes` of content and backdate the
 * WHOLE subtree by `hours`. Order matters: writing a child bumps the
 * parent's mtime, so the parent must be aged last.
 */
function agedDir(name: string, hours: number, bytes = 4096): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "payload.bin");
  writeFileSync(file, Buffer.alloc(bytes, 0x61));
  age(file, hours);
  age(dir, hours);
  return dir;
}

interface PassResult {
  status: number | null;
  out: string;
}

/** Run one reaper pass over the fixture root. */
function pass(env: Record<string, string> = {}, rootOverride?: string): PassResult {
  const r = spawnSync("bash", [SCRIPT, "--once"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SWITCHROOM_TMP_REAPER_ROOT: rootOverride ?? root,
      ...env,
    },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("tmp-reaper — reaps aged garbage", () => {
  it("removes an aged, unopened entry and reports its size", () => {
    const dir = agedDir("orphaned-build", 48, 2 * 1024 * 1024);
    expect(existsSync(dir)).toBe(true);

    const { out } = pass();

    expect(existsSync(dir), `expected ${dir} to be reaped.\n${out}`).toBe(false);
    // The log must name what it took and how big it was — a reaper that
    // deletes silently is undebuggable after the fact.
    expect(out).toContain(`reaped ${dir}`);
    expect(out).toMatch(/reaped .*orphaned-build \(2M, idle 48h\)/);
  });

  it("emits a summary line even when it reaps nothing", () => {
    const { out } = pass();
    expect(out).toMatch(/pass complete on .*: reaped=0 /);
  });

  it("never removes the root itself", () => {
    agedDir("junk", 48);
    pass();
    expect(existsSync(root)).toBe(true);
  });
});

describe("tmp-reaper — age floor", () => {
  it("keeps an entry younger than the threshold", () => {
    const dir = agedDir("fresh", 1);
    const { out } = pass();
    expect(existsSync(dir), `1h-old entry must survive a 24h threshold.\n${out}`).toBe(true);
    expect(out).toMatch(/kept_young=1/);
  });

  /**
   * MUTATION GUARD. A directory's own mtime does NOT change when a
   * grandchild is written, so a reaper that stats only the top-level entry
   * happily deletes a tree that is actively in use. This is the single most
   * dangerous way to get this wrong; it must fail loudly.
   */
  it("keeps an aged directory whose GRANDCHILD was touched recently", () => {
    const dir = join(root, "live-session");
    const deep = join(dir, "nested", "deeper");
    mkdirSync(deep, { recursive: true });
    const live = join(deep, "in-use.log");
    writeFileSync(live, "recent");
    // Backdate everything EXCEPT the grandchild file — the shape of a
    // long-lived scratch dir that is still being appended to.
    age(join(dir, "nested"), 72);
    age(deep, 72);
    age(dir, 72);

    const { out } = pass();

    expect(
      existsSync(live),
      `a subtree with a file modified seconds ago must NOT be reaped, ` +
        `even when every ancestor's own mtime is 72h old.\n${out}`,
    ).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("clamps a sub-hour age override up to the 1h floor", () => {
    const dir = agedDir("ten-minutes", 0);
    age(join(dir, "payload.bin"), 10 / 60);
    age(dir, 10 / 60);

    const { out } = pass({ SWITCHROOM_TMP_REAPER_MIN_AGE_SEC: "60" });

    expect(
      existsSync(dir),
      `a 10-minute-old entry must survive even when the operator asks for ` +
        `a 60-second threshold — the floor is 3600s.\n${out}`,
    ).toBe(true);
    expect(out).toMatch(/min_age=3600s/);
  });

  it("falls back to the default when the age override is garbage", () => {
    const dir = agedDir("aged", 48);
    const { out } = pass({ SWITCHROOM_TMP_REAPER_MIN_AGE_SEC: "not-a-number" });
    expect(out).toMatch(/min_age=86400s/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("tmp-reaper — open files", () => {
  /**
   * MUTATION GUARD. Age alone is not enough: a process can hold an fd on a
   * file it wrote days ago (a long-lived socket, a mapped DB, a log opened
   * at boot). Deleting it yanks the file out from under a live process.
   */
  it("keeps an aged entry that a live process holds an fd on", async () => {
    const dir = agedDir("held-open", 72);
    const file = join(dir, "payload.bin");

    // `exec 3< file` opens the fd and keeps it open for the sleep's lifetime;
    // the fd shows up under /proc/<pid>/fd.
    const child = spawn("bash", ["-c", `exec 3< "${file}"; sleep 60`], {
      stdio: "ignore",
    });
    children.push(child);
    // Wait for the fd to actually be open before the pass runs.
    await new Promise((r) => setTimeout(r, 700));
    expect(child.pid).toBeTruthy();

    const { out } = pass();

    expect(
      existsSync(dir),
      `an entry with a live open fd must NOT be reaped regardless of age.\n${out}`,
    ).toBe(true);
    expect(out).toMatch(/kept_open=1/);
  });

  it("reaps the same entry once the holder exits", async () => {
    const dir = agedDir("held-then-released", 72);
    const file = join(dir, "payload.bin");

    const child = spawn("bash", ["-c", `exec 3< "${file}"; sleep 0.2`], {
      stdio: "ignore",
    });
    await new Promise((r) => child.on("exit", r));
    // Re-age: nothing above touched the tree, but be explicit.
    age(file, 72);
    age(dir, 72);

    const { out } = pass();
    expect(existsSync(dir), `holder is gone — entry should be reaped.\n${out}`).toBe(false);
  });
});

describe("tmp-reaper — scope", () => {
  /**
   * MUTATION GUARD. If any traversal grows an `-L` / `-follow`, or the
   * removal loses `--one-file-system`, an aged symlink under /tmp becomes a
   * delete of whatever it points at. /tmp is full of symlinks.
   */
  it("does not delete a symlink's target outside the root", () => {
    const outside = realpathSync(mkdtempSync(join(FIXTURE_PARENT, "tmp-reaper-outside-")));
    const precious = join(outside, "precious.txt");
    writeFileSync(precious, "must survive");
    age(precious, 96);
    age(outside, 96);

    const link = join(root, "escape-hatch");
    symlinkSync(outside, link);
    // lutimes semantics: utimesSync follows the link, so age the link's own
    // times via touch -h (the link itself is what the reaper stats).
    spawnSync("touch", ["-h", "-d", "96 hours ago", link]);

    const { out } = pass();

    expect(
      existsSync(precious),
      `the symlink TARGET outside the root must survive; only the link ` +
        `itself may ever be removed.\n${out}`,
    ).toBe(true);
    expect(readFileSync(precious, "utf8")).toBe("must survive");
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses to run against /", () => {
    const { out } = pass({}, "/");
    expect(out).toMatch(/refusing: root is \//);
    expect(out).not.toMatch(/^\[switchroom-tmp-reaper\].*reaped /m);
  });

  it("refuses a relative root and a root containing ..", () => {
    expect(pass({}, "relative/path").out).toMatch(/refusing: root 'relative\/path' is not absolute/);
    expect(pass({}, "/var/../etc").out).toMatch(/refusing: root '\/var\/\.\.\/etc' contains '\.\.'/);
  });

  it("defaults its root to /tmp when nothing overrides it", () => {
    // Source the script (it does NOT auto-run when sourced) with the override
    // unset, and read back the resolved root.
    const env = { ...process.env };
    delete env.SWITCHROOM_TMP_REAPER_ROOT;
    const r = spawnSync(
      "bash",
      ["-c", `source "${SCRIPT}"; printf '%s' "$TMP_REAPER_ROOT"`],
      { encoding: "utf8", env },
    );
    expect(r.stdout).toBe("/tmp");
  });

  it("keeps the conventional tmpfs fixtures no matter how old they are", () => {
    const x11 = join(root, ".X11-unix");
    mkdirSync(x11);
    age(x11, 24 * 365);
    const { out } = pass();
    expect(existsSync(x11), `.X11-unix must never be reaped.\n${out}`).toBe(true);
    expect(out).toMatch(/kept_pinned=1/);
  });
});

describe("tmp-reaper — kill switch", () => {
  it("does nothing at all when SWITCHROOM_TMP_REAPER=0", () => {
    const dir = agedDir("would-be-reaped", 96);
    const { out } = pass({ SWITCHROOM_TMP_REAPER: "0" });
    expect(existsSync(dir), `kill switch must prevent every removal.\n${out}`).toBe(true);
    expect(out).toMatch(/disabled via SWITCHROOM_TMP_REAPER=0/);
  });
});

describe("tmp-reaper — boot wiring (start.sh.hbs block 3a)", () => {
  const TEMPLATE = resolve(__dirname, "..", "profiles", "_base", "start.sh.hbs");
  const SRC = readFileSync(TEMPLATE, "utf-8");

  /**
   * Lift the real guard out of the template and run it with a recording stub
   * for `_switchroom_supervise`, so the assertion is "a tmp-reaper sidecar
   * gets supervised at boot" rather than "the template mentions a string".
   */
  function runGuard(env: Record<string, string>, scriptPresent: boolean): string {
    const lines = SRC.split("\n");
    const start = lines.findIndex((l) => l.includes('if [ "$SWITCHROOM_TMP_REAPER" != "0" ]'));
    expect(start, "block 3a guard not found in start.sh.hbs").toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && l.trim() === "fi");
    const block = lines.slice(start, end + 1).join("\n");
    expect(block).not.toMatch(/\{\{/); // no unbound handlebars token in the lifted block

    const fakeBin = join(root, "opt", "switchroom", "bin");
    mkdirSync(fakeBin, { recursive: true });
    if (scriptPresent) {
      writeFileSync(join(fakeBin, "tmp-reaper.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 });
    }
    const harness = [
      "#!/usr/bin/env bash",
      `_switchroom_supervise() { echo "SUPERVISED:$1:$2:\${*:3}"; }`,
      // Redirect the absolute image path at the fixture.
      block.replace(/\/opt\/switchroom\/bin\/tmp-reaper\.sh/g, join(fakeBin, "tmp-reaper.sh")),
    ].join("\n");
    const path = join(root, "guard.sh");
    writeFileSync(path, harness, { mode: 0o755 });
    const r = spawnSync("bash", [path], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  }

  it("supervises a named tmp-reaper sidecar with its own log file", () => {
    const out = runGuard({ SWITCHROOM_TMP_REAPER: "" }, true);
    expect(out).toContain("SUPERVISED:tmp-reaper:/var/log/switchroom/tmp-reaper.log");
    // Not --oneshot-ok: a clean exit from an endless loop is abnormal and
    // must respawn.
    expect(out).not.toContain("--oneshot-ok");
  });

  it("supervises it by default when the env var is unset", () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.SWITCHROOM_TMP_REAPER;
    const out = runGuard({}, true);
    expect(out).toContain("SUPERVISED:tmp-reaper:");
  });

  it("does not supervise it when SWITCHROOM_TMP_REAPER=0", () => {
    expect(runGuard({ SWITCHROOM_TMP_REAPER: "0" }, true)).not.toContain("SUPERVISED:");
  });

  it("does not supervise it when the script is absent from the image", () => {
    expect(runGuard({ SWITCHROOM_TMP_REAPER: "1" }, false)).not.toContain("SUPERVISED:");
  });

  it("is baked into the agent image by the bin/*.sh glob COPY", () => {
    const dockerfile = readFileSync(
      resolve(__dirname, "..", "docker", "Dockerfile.agent"),
      "utf-8",
    );
    expect(dockerfile).toMatch(/^COPY bin\/\*\.sh \/opt\/switchroom\/bin\/$/m);
    expect(dockerfile).toMatch(/^RUN chmod \+x \/opt\/switchroom\/bin\/\*\.sh$/m);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
