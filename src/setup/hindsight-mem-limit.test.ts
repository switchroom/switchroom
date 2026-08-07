/**
 * `hindsight.mem_limit` — the container's docker memory cap.
 *
 * ## The bug these tests exist for
 *
 * The cap was a hard-coded `16g` with no config path. An operator raised the
 * live container to 24 GiB by hand so a 12 GiB `shared_buffers` would fit; the
 * next `switchroom memory setup --recreate` put the cap silently back to 16 GiB
 * and left the 12 GiB buffer pool configured inside it — Postgres pinning 75%
 * of its own cgroup as unreclaimable shared memory, with no warning anywhere.
 *
 * So, in order of how badly a regression would hurt:
 *
 *   1. **A configured cap actually reaches docker — on BOTH launch paths.** A
 *      knob that lands in the docker-run argv but not the compose snippet
 *      re-creates the divergence rather than fixing it.
 *   2. **The default is untouched when nothing is configured.** This change
 *      must be invisible to every existing install.
 *   3. **The dangerous combination is named out loud.** The config knob alone
 *      only moves the foot-gun; the warning is what stops it recurring. It
 *      must fire on cap 16 GiB + shared_buffers 12 GiB and stay quiet on the
 *      shipped defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  HINDSIGHT_PG_APP_ANON_MIB,
  HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB,
  HINDSIGHT_PG_MIN_NON_BUFFER_MIB,
  HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB,
  HINDSIGHT_PG_SHARED_BUFFERS_ENV,
  hindsightMemBudgetWarning,
  parseDockerSizeToMib,
  parsePgSizeToMib,
  pgMib,
} from "./hindsight-pg-defaults.js";
import {
  HINDSIGHT_DEFAULT_MEM_LIMIT,
  generateHindsightComposeSnippet,
  hindsightMemBudgetWarningFor,
  resolveHindsightMemLimit,
  startHindsight,
} from "./hindsight.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The `docker run` argv for the hindsight container itself. */
function runArgs(): string[] {
  const call = execFileSyncMock.mock.calls.find(
    (c) =>
      c[0] === "docker" &&
      Array.isArray(c[1]) &&
      (c[1] as string[])[0] === "run" &&
      (c[1] as string[]).includes("switchroom-hindsight"),
  );
  expect(call, "startHindsight must have issued a `docker run`").toBeDefined();
  return call![1] as string[];
}

/** `--memory=…` flags in a docker-run argv. */
function memoryFlags(args: string[]): string[] {
  return args.filter((a) => a.startsWith("--memory="));
}

/** `mem_limit: …` lines in a compose snippet. */
function composeMemLimits(snippet: string): string[] {
  return snippet
    .split("\n")
    .filter((l) => /^ {4}mem_limit:/.test(l))
    .map((l) => l.replace(/^ {4}mem_limit:\s*/, ""));
}

// ── 1. an explicit cap reaches BOTH launch paths ──────────────────────────
describe("hindsight.mem_limit reaches docker", () => {
  it("puts the configured cap in the docker-run argv, exactly once", () => {
    startHindsight(undefined, undefined, undefined, undefined, undefined, false, {
      memLimit: "24g",
    });
    // The bug: this used to be `16g` no matter what the operator configured.
    expect(memoryFlags(runArgs())).toEqual(["--memory=24g"]);
  });

  it("puts the SAME configured cap in the compose snippet", () => {
    const snippet = generateHindsightComposeSnippet(
      undefined,
      undefined,
      undefined,
      false,
      { memLimit: "24g" },
    );
    expect(composeMemLimits(snippet)).toEqual(["24g"]);
  });

  it("keeps the two launch paths on the same cap for the same input", () => {
    for (const memLimit of [undefined, "24g", "32768m"]) {
      execFileSyncMock.mockReset();
      execFileSyncMock.mockReturnValue(Buffer.from(""));
      startHindsight(undefined, undefined, undefined, undefined, undefined, false, {
        memLimit,
      });
      const fromRun = memoryFlags(runArgs())[0].replace("--memory=", "");
      const fromCompose = composeMemLimits(
        generateHindsightComposeSnippet(undefined, undefined, undefined, false, {
          memLimit,
        }),
      )[0];
      expect(fromCompose, `mem_limit=${String(memLimit)}`).toBe(fromRun);
    }
  });

  it("still emits NO --memory-swap alongside a configured cap", () => {
    // The pre-existing invariant (see HINDSIGHT_DEFAULT_MEM_LIMIT's comment):
    // memory-swap == memory disables swap and converts graceful degradation
    // into a hard OOM kill. A new knob must not smuggle one in.
    startHindsight(undefined, undefined, undefined, undefined, undefined, false, {
      memLimit: "24g",
    });
    expect(runArgs().some((a) => a.startsWith("--memory-swap"))).toBe(false);
  });

  it("rejects a value docker could not parse instead of silently defaulting", () => {
    // Silently substituting the default for a typo would be the SAME failure
    // this change removes: the operator asks for a cap and gets 16g anyway.
    expect(() => resolveHindsightMemLimit({ memLimit: "24 gigs" })).toThrow(
      /not a docker memory size/,
    );
  });

  it("rejects a cap under the container's own memory reservation", () => {
    // `--memory-reservation` is emitted unconditionally, and docker refuses to
    // create a container whose limit is under its reservation. That state was
    // unreachable while the cap was a constant; this knob makes it reachable,
    // so it fails here with both numbers rather than opaquely in docker.
    expect(() => resolveHindsightMemLimit({ memLimit: "2g" })).toThrow(
      /below the container's memory reservation \(4g\)/,
    );
    expect(resolveHindsightMemLimit({ memLimit: "4g" })).toBe("4g");
  });
});

// ── 2. no behaviour change for existing installs ──────────────────────────
describe("hindsight.mem_limit default", () => {
  it("is unchanged at 16g", () => {
    expect(HINDSIGHT_DEFAULT_MEM_LIMIT).toBe("16g");
  });

  it("emits the default when nothing is configured, on both paths", () => {
    startHindsight();
    expect(memoryFlags(runArgs())).toEqual([`--memory=${HINDSIGHT_DEFAULT_MEM_LIMIT}`]);
    expect(composeMemLimits(generateHindsightComposeSnippet())).toEqual([
      HINDSIGHT_DEFAULT_MEM_LIMIT,
    ]);
  });

  it("treats a blank / whitespace value as unset, not as an error", () => {
    for (const blank of ["", "   "]) {
      expect(resolveHindsightMemLimit({ memLimit: blank })).toBe(HINDSIGHT_DEFAULT_MEM_LIMIT);
    }
    expect(resolveHindsightMemLimit(undefined)).toBe(HINDSIGHT_DEFAULT_MEM_LIMIT);
    expect(resolveHindsightMemLimit({})).toBe(HINDSIGHT_DEFAULT_MEM_LIMIT);
  });
});

// ── 3. the safety check ───────────────────────────────────────────────────
describe("shared_buffers-vs-cap safety check", () => {
  it("is the same arithmetic the compile-time budget reserves", () => {
    expect(HINDSIGHT_PG_MIN_NON_BUFFER_MIB).toBe(
      HINDSIGHT_PG_APP_ANON_MIB + HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB,
    );
  });

  it("fires on the observed dangerous state: 16 GiB cap, 12 GiB shared_buffers", () => {
    const warning = hindsightMemBudgetWarning({
      memLimit: "16g",
      sharedBuffers: "12288MB",
    });
    expect(warning).not.toBeNull();
    // A warning that does not name both numbers and the key to change is not
    // actionable — that was the whole defect.
    expect(warning).toContain("16g");
    expect(warning).toContain("12288MB");
    expect(warning).toContain("hindsight.mem_limit");
    expect(warning).toContain("SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS");
  });

  it("stays quiet on the shipped defaults", () => {
    expect(
      hindsightMemBudgetWarning({
        memLimit: HINDSIGHT_DEFAULT_MEM_LIMIT,
        sharedBuffers: pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB),
      }),
    ).toBeNull();
  });

  it("stays quiet on the operator's fix (24 GiB cap, 12 GiB shared_buffers)", () => {
    expect(
      hindsightMemBudgetWarning({ memLimit: "24g", sharedBuffers: "12288MB" }),
    ).toBeNull();
  });

  it("sits exactly on the boundary, not near it", () => {
    const bufMib = 8192;
    const exact = bufMib + HINDSIGHT_PG_MIN_NON_BUFFER_MIB;
    expect(
      hindsightMemBudgetWarning({
        memLimit: `${exact}m`,
        sharedBuffers: pgMib(bufMib),
      }),
      "a cap exactly equal to buffers + reserved headroom is acceptable",
    ).toBeNull();
    expect(
      hindsightMemBudgetWarning({
        memLimit: `${exact - 1}m`,
        sharedBuffers: pgMib(bufMib),
      }),
      "one MiB under is not",
    ).not.toBeNull();
  });

  it("says nothing rather than assert a wrong number on an unparseable input", () => {
    expect(
      hindsightMemBudgetWarning({ memLimit: "lots", sharedBuffers: "12288MB" }),
    ).toBeNull();
    expect(
      hindsightMemBudgetWarning({ memLimit: "16g", sharedBuffers: "plenty" }),
    ).toBeNull();
  });

  it("honours the `off` sentinel — pg0's own 256MB clears any sane cap", () => {
    expect(hindsightMemBudgetWarning({ memLimit: "16g", sharedBuffers: "off" })).toBeNull();
  });
});

describe("safety check against the config that will actually launch", () => {
  it("fires when the DEFAULT cap meets an operator-raised shared_buffers", () => {
    // This is the exact recurrence path: `hindsight.env` raised
    // shared_buffers, `hindsight.mem_limit` left unset, so the hard-coded
    // default cap comes back under it.
    const warning = hindsightMemBudgetWarningFor({
      env: { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "12288MB" },
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain(HINDSIGHT_DEFAULT_MEM_LIMIT);
    expect(warning).toContain("12288MB");
  });

  it("goes quiet once the operator also raises the cap", () => {
    expect(
      hindsightMemBudgetWarningFor({
        env: { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "12288MB" },
        memLimit: "24g",
      }),
    ).toBeNull();
  });

  it("is silent for a stock install", () => {
    expect(hindsightMemBudgetWarningFor()).toBeNull();
    expect(hindsightMemBudgetWarningFor({ env: {} })).toBeNull();
  });

  it("warns on the launch path itself, not only in the CLI wrapper", () => {
    // `switchroom memory setup --recreate` is what did the reverting, so the
    // warning has to be attached to the launcher. A CLI-only warning would be
    // skipped by every other caller of startHindsight().
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startHindsight(undefined, undefined, undefined, undefined, undefined, false, {
      env: { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "12288MB" },
    });
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("shared_buffers");
    expect(said).toContain("12288MB");
    expect(said).toContain("hindsight.mem_limit");
  });

  it("does not warn on a stock launch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    startHindsight();
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).not.toContain("shared_buffers");
  });
});

// ── size parsing ──────────────────────────────────────────────────────────
describe("size parsing", () => {
  it("parses docker sizes base-1024, with a bare number meaning BYTES", () => {
    expect(parseDockerSizeToMib("16g")).toBe(16384);
    expect(parseDockerSizeToMib("24G")).toBe(24576);
    expect(parseDockerSizeToMib("2gb")).toBe(2048);
    expect(parseDockerSizeToMib("512m")).toBe(512);
    expect(parseDockerSizeToMib("1024k")).toBe(1);
    expect(parseDockerSizeToMib("1048576")).toBe(1);
    expect(parseDockerSizeToMib("plenty")).toBeNull();
    expect(parseDockerSizeToMib("")).toBeNull();
  });

  it("parses postgres sizes, with a bare number meaning 8 kB BLOCKS", () => {
    // Not the same grammar as docker's, and getting it wrong here would
    // silence or misfire the check by a factor of 8192.
    expect(parsePgSizeToMib("12288MB")).toBe(12288);
    expect(parsePgSizeToMib("4GB")).toBe(4096);
    expect(parsePgSizeToMib("2048kB")).toBe(2);
    expect(parsePgSizeToMib("131072")).toBe(1024);
    expect(parsePgSizeToMib("off")).toBe(256);
    expect(parsePgSizeToMib("OFF")).toBe(256);
    expect(parsePgSizeToMib("some")).toBeNull();
  });
});
