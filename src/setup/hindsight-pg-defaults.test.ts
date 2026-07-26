/**
 * Embedded-PostgreSQL (pg0) sizing defaults.
 *
 * What these tests protect, in order of how badly a regression would hurt:
 *
 *   1. **The memory budget is arithmetic, not a vibe.** `shared_buffers` is a
 *      real allocation inside a container with a hard `mem_limit`. The budget
 *      derivation is asserted against the SAME `HINDSIGHT_DEFAULT_MEM_LIMIT`
 *      the container is actually created with, so raising one without the
 *      other goes red.
 *   2. **The values reach the container, once, on BOTH launch paths.** These
 *      env vars do nothing on their own — `docker/hindsight-entrypoint.sh`
 *      reads them. If `startHindsight` emits them and the compose snippet does
 *      not, half the fleet is silently untuned.
 *   3. **Operator override wins, and `off` is expressible.** An operator on a
 *      smaller host must be able to opt a single knob out without losing the
 *      other.
 *   4. **Planner coherence.** `effective_cache_size` counts `shared_buffers`
 *      PLUS the OS page cache, so declaring it *below* `shared_buffers` is
 *      incoherent by construction and must fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HINDSIGHT_PG_APP_ANON_MIB,
  HINDSIGHT_PG_DEFAULTS,
  HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB,
  HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB,
  HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV,
  HINDSIGHT_PG_ENV_KEYS,
  HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION,
  HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB,
  HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB,
  HINDSIGHT_PG_SHARED_BUFFERS_ENV,
  hindsightPgEnv,
  pgMib,
  resolveHindsightPgOverrides,
} from "./hindsight-pg-defaults.js";
import {
  HINDSIGHT_DEFAULT_MEM_LIMIT,
  HINDSIGHT_DEFAULT_SHM_SIZE,
  generateHindsightComposeSnippet,
  hindsightPgEnvPairs,
  startHindsight,
} from "./hindsight.js";

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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

/** `KEY=VALUE` pairs following a `-e` flag in a docker-run argv. */
function runEnv(args: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-e") continue;
    const eq = args[i + 1].indexOf("=");
    if (eq < 0) continue;
    const key = args[i + 1].slice(0, eq);
    const value = args[i + 1].slice(eq + 1);
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

/** `      - KEY=VALUE` environment lines from a compose snippet. */
function composeEnv(snippet: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of snippet.split("\n")) {
    const m = line.match(/^ {6}- ([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), m[2]]);
  }
  return out;
}

/** Parse a docker size string (`8g`, `512m`, `2G`) to MiB. */
function dockerSizeToMib(size: string): number {
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG])?b?$/);
  expect(m, `unparseable docker size: ${size}`).not.toBeNull();
  const n = Number(m![1]);
  switch ((m![2] ?? "m").toLowerCase()) {
    case "k":
      return n / 1024;
    case "g":
      return n * 1024;
    default:
      return n;
  }
}

const ENTRYPOINT = resolve(__dirname, "..", "..", "docker", "hindsight-entrypoint.sh");

// ── the derivation ────────────────────────────────────────────────────────
describe("pg0 memory budget derivation", () => {
  it("is derived against the REAL container mem_limit, not a stale copy", () => {
    // hindsight-pg-defaults.ts holds a literal to avoid an import cycle with
    // hindsight.ts. Drift here means the whole budget below is computed
    // against a ceiling the container never gets.
    expect(HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION).toBe(
      dockerSizeToMib(HINDSIGHT_DEFAULT_MEM_LIMIT),
    );
  });

  it("reserves the app working set AND a page-cache floor out of the ceiling", () => {
    expect(HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB).toBe(
      HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION -
        HINDSIGHT_PG_APP_ANON_MIB -
        HINDSIGHT_PG_PAGE_CACHE_FLOOR_MIB,
    );
    // A budget that went non-positive would make every assertion below
    // vacuously satisfiable by shared_buffers=0.
    expect(HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB).toBeGreaterThan(0);
  });

  it("keeps shared_buffers inside the budget", () => {
    expect(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB).toBeLessThanOrEqual(
      HINDSIGHT_PG_SHARED_BUFFERS_BUDGET_MIB,
    );
  });

  it("still raises shared_buffers well above pg0's own 256MB default", () => {
    // The other half of the budget invariant, and the one a purely
    // conservative "make it smaller" edit would break silently: the whole
    // point is a buffer pool that can hold a real hot set of a 12 GB bank.
    // pg0's default, verified live in `ps` inside switchroom-hindsight.
    const PG0_OWN_DEFAULT_SHARED_BUFFERS_MIB = 256;
    expect(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB).toBeGreaterThanOrEqual(
      4 * PG0_OWN_DEFAULT_SHARED_BUFFERS_MIB,
    );
  });

  it("declares effective_cache_size at or above shared_buffers", () => {
    // effective_cache_size counts shared_buffers PLUS the OS page cache, so a
    // value below the buffer pool is incoherent — it would tell the planner
    // it has less cache than postgres definitely holds.
    expect(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB).toBeGreaterThanOrEqual(
      HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB,
    );
  });

  it("never declares more cache than the container could possibly hold", () => {
    // effective_cache_size allocates nothing, so over-declaring costs no
    // memory — but it makes the planner price index scans against cache the
    // cgroup can never provide. The ceiling is the container's own limit.
    expect(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB).toBeLessThanOrEqual(
      HINDSIGHT_PG_MEM_LIMIT_MIB_FOR_DERIVATION,
    );
  });

  it("raises effective_cache_size well above pg0's under-declared 1GB", () => {
    // pg0's default, verified live: `-c effective_cache_size=1GB` against a
    // 12 GB database whose container was measurably holding 5212 MiB of page
    // cache. This is the must-ship half of #3706; a revert to 1GB is exactly
    // the regression this test exists to catch.
    const PG0_OWN_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB = 1024;
    expect(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB).toBeGreaterThanOrEqual(
      3 * PG0_OWN_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB,
    );
  });

  it("leaves shm_size alone — shared_buffers is mmap here, not /dev/shm", () => {
    // The assumption this work started from was that shared_buffers is a
    // POSIX /dev/shm allocation and therefore needs shm_size raised in
    // lockstep. Verified FALSE on this build: pg0 runs postgres with
    // `shared_memory_type=mmap` (and `dynamic_shared_memory_type=posix`), and
    // a probe instance started with shared_buffers=4GB left /dev/shm at 16 MiB
    // of 2.0 GiB used. /dev/shm backs only parallel-query DSM segments
    // (observed peak ~533MB), which 2g already covers. Pinned so a future
    // "raise it in lockstep" edit has to confront this note first.
    expect(dockerSizeToMib(HINDSIGHT_DEFAULT_SHM_SIZE)).toBe(2048);
  });
});

// ── the resolver ──────────────────────────────────────────────────────────
describe("resolveHindsightPgOverrides", () => {
  it("takes an operator value from hindsight.env", () => {
    const got = resolveHindsightPgOverrides(
      { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "512MB" },
      {},
    );
    expect(got.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toBe("512MB");
  });

  it("lets hindsight.env beat switchroom's own process environment", () => {
    const got = resolveHindsightPgOverrides(
      { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "512MB" },
      { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "999MB" },
    );
    expect(got.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toBe("512MB");
  });

  it("still honours a process-env override when hindsight.env is silent", () => {
    const got = resolveHindsightPgOverrides(undefined, {
      [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "999MB",
    });
    expect(got.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toBe("999MB");
  });

  it("ignores keys it does not manage", () => {
    const got = resolveHindsightPgOverrides(
      { SWITCHROOM_HINDSIGHT_PG_WORK_MEM: "1GB", HINDSIGHT_API_PORT: "1234" },
      {},
    );
    expect(got.size).toBe(0);
  });

  it("ignores an empty / whitespace-only value rather than forwarding it", () => {
    const got = resolveHindsightPgOverrides(
      { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "   " },
      { [HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV]: "" },
    );
    expect(got.size).toBe(0);
  });

  it("forwards the `off` sentinel — it is the per-knob opt-out, not an accident", () => {
    const got = resolveHindsightPgOverrides(
      { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "off" },
      {},
    );
    expect(got.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toBe("off");
  });
});

// ── the emitted pairs ─────────────────────────────────────────────────────
describe("hindsightPgEnv", () => {
  it("emits both knobs, in MB form, with switchroom's defaults", () => {
    expect(hindsightPgEnv()).toEqual([
      [
        HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV,
        pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
      ],
      [HINDSIGHT_PG_SHARED_BUFFERS_ENV, pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB)],
    ]);
  });

  it("REPLACES the default with the override rather than appending after it", () => {
    // An appended duplicate would leave the winner to docker's argv semantics.
    const pairs = hindsightPgEnv(new Map([[HINDSIGHT_PG_SHARED_BUFFERS_ENV, "512MB"]]));
    expect(pairs.filter(([k]) => k === HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toEqual([
      [HINDSIGHT_PG_SHARED_BUFFERS_ENV, "512MB"],
    ]);
    // ...and the OTHER knob keeps its default: opting one out must not opt
    // both out.
    expect(
      pairs.find(([k]) => k === HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV)?.[1],
    ).toBe(pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB));
  });

  it("emits every managed key exactly once", () => {
    const keys = hindsightPgEnv().map(([k]) => k);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(HINDSIGHT_PG_ENV_KEYS));
  });

  it("HINDSIGHT_PG_ENV_KEYS covers exactly the declared defaults", () => {
    expect([...HINDSIGHT_PG_ENV_KEYS].sort()).toEqual(
      HINDSIGHT_PG_DEFAULTS.map(([k]) => k).sort(),
    );
  });
});

// ── the launch paths ──────────────────────────────────────────────────────
describe("pg0 sizing reaches the container on both launch paths", () => {
  it("startHindsight emits both knobs on the docker-run argv", () => {
    startHindsight();
    const env = runEnv(runArgs());
    expect(env.get(HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
    ]);
    expect(env.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB),
    ]);
  });

  it("the compose snippet emits the same values", () => {
    const env = composeEnv(generateHindsightComposeSnippet());
    expect(env.get(HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
    ]);
    expect(env.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB),
    ]);
  });

  it("carries an operator override through BOTH paths, key by key", () => {
    // Deliberately asymmetric: one knob overridden, one left at its default,
    // so a generator that ignored `perf` entirely fails on the first and a
    // generator that dropped the defaults fails on the second.
    const perf = {
      env: { [HINDSIGHT_PG_SHARED_BUFFERS_ENV]: "768MB" },
      processEnv: {},
    };
    // Guard against a vacuous pin: the override only proves anything if it
    // differs from the default it replaces.
    expect(pgMib(HINDSIGHT_PG_DEFAULT_SHARED_BUFFERS_MIB)).not.toBe("768MB");

    startHindsight(undefined, undefined, undefined, undefined, undefined, undefined, perf);
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(
      generateHindsightComposeSnippet(undefined, undefined, undefined, undefined, perf),
    );
    for (const key of HINDSIGHT_PG_ENV_KEYS) {
      expect(fromCompose.get(key) ?? null, `${key} must match across paths`).toEqual(
        fromRun.get(key) ?? null,
      );
    }
    // Parity alone is symmetric — pin the actual values on BOTH sides.
    expect(fromRun.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toEqual(["768MB"]);
    expect(fromCompose.get(HINDSIGHT_PG_SHARED_BUFFERS_ENV)).toEqual(["768MB"]);
    expect(fromRun.get(HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
    ]);
    expect(fromCompose.get(HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE_ENV)).toEqual([
      pgMib(HINDSIGHT_PG_DEFAULT_EFFECTIVE_CACHE_SIZE_MIB),
    ]);
  });

  it("both paths derive from hindsightPgEnvPairs for the same inputs", () => {
    const expected = new Map(hindsightPgEnvPairs());
    expect(expected.size).toBeGreaterThan(0);
    startHindsight();
    const fromRun = runEnv(runArgs());
    const fromCompose = composeEnv(generateHindsightComposeSnippet());
    for (const [key, value] of expected) {
      expect(fromRun.get(key)).toEqual([value]);
      expect(fromCompose.get(key)).toEqual([value]);
    }
  });

  it("never emits a managed key twice in the final argv", () => {
    startHindsight();
    const env = runEnv(runArgs());
    for (const key of HINDSIGHT_PG_ENV_KEYS) {
      expect(env.get(key)?.length, `${key} emitted more than once`).toBe(1);
    }
  });

  it("the entrypoint reads exactly the env vars switchroom emits", () => {
    // These vars are inert unless the entrypoint consumes them by name. A
    // rename on either side is a silent no-op tuning change, which is the
    // worst failure mode available here — everything still boots, nothing is
    // tuned. Assert the contract on the real script text.
    const script = readFileSync(ENTRYPOINT, "utf-8");
    for (const key of HINDSIGHT_PG_ENV_KEYS) {
      expect(script, `${key} is emitted but never read by the entrypoint`).toContain(
        `\${${key}:-}`,
      );
    }
  });
});
