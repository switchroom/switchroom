/**
 * Retirement guard for the upstream-#2968 graph-seed-reuse carry that
 * `docker/Dockerfile.hindsight` used to bake into the pinned Hindsight image.
 *
 * WHAT THIS FILE USED TO BE. vectorize-io/hindsight PR #2968 (merge b475f5cc,
 * 2026-07-27T10:12:30Z) landed on upstream `main` AFTER v0.8.5 — the digest the
 * Dockerfile then pinned — was cut, so there was no release to upgrade to. The
 * Dockerfile carried the diff as a build-time patch, and this file was its
 * behavioural proof: five properties driven against the patched modules, with a
 * stated exit condition of "the block and this file are DELETED together the
 * moment the base is >= v0.8.6".
 *
 * WHY IT IS A RETIREMENT GUARD INSTEAD OF A DELETION. The base bump to v0.8.6
 * met that exit condition, and the carry was removed — it even self-detected
 * the bump, its own `assert "graph_seed_min_similarity" not in _cfg` firing
 * against the new image exactly as designed. But deleting the block AND its only
 * test leaves nobody asserting that the behaviour survived the retirement, and
 * "upstream has it now" is precisely the claim that should be checked rather
 * than believed. Two things must hold, and neither is visible in the Dockerfile:
 *
 *  1. THE IMPLEMENTATION IS REALLY NATIVE. If a later digest bump moved
 *     backwards, or if #2968 were reverted upstream, the fleet would silently
 *     reinstate the duplicate ANN scan the carry removed (upstream measured the
 *     eliminated graph-seed query at 302,602 calls / 2,072s of accumulated
 *     load, and the UUID lookup at 120.049ms -> 0.240ms median once the
 *     `id::text` cast that forced the sequential scan was dropped). Nothing
 *     would go red: the carry is gone, so there is no anchor left to fail.
 *
 *  2. THE 0.3 FLOOR IS STILL A PIN, NOT A DEFAULT. The carry hard-coded the
 *     graph seed floor at 0.3 partly to stop it drifting. v0.8.6 makes it
 *     configurable (`HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY`, config.py:468,
 *     upstream default 0.3 at config.py:926), so switchroom now emits it
 *     EXPLICITLY (`HINDSIGHT_DEFAULT_GRAPH_SEED_MIN_SIMILARITY`,
 *     src/setup/hindsight-perf-defaults.ts) rather than inheriting it.
 *     Inheriting would convert a deliberate behaviour pin into "whatever the
 *     next image bump decides", and a quieter recall is worse than a slower one.
 *
 * Both are driven inside the pinned image against the real shipping modules —
 * the config loader for the floor, the retrieval modules for the reuse path —
 * not grepped out of the Dockerfile, which no longer mentions any of it.
 *
 * SKIP DISCIPLINE: identical to `hindsight-retry-perturbation-patches.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. The run
 * asserts a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { execFileAsync } from "./_exec-async.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-graph-seed-retirement";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The retired carry, named by the unique BLOCK HEADER it used to carry.
 *
 * Deliberately the header and not a bare "#2968": the retirement note left in
 * the Dockerfile cites the PR by number on purpose, so a looser marker would be
 * satisfied by the very comment that documents the removal.
 */
const RETIRED_PATCH_MARKER = "# ── UPSTREAM CARRY: vectorize-io/hindsight PR #2968";

/** The env key that replaced the carry's hard-coded floor. */
const ENV_KEY = "HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY";

/** The floor switchroom pins, read from the emitter so it cannot drift here. */
const PINNED_FLOOR = (() => {
  const emitter = readFileSync(
    resolve(root, "src/setup/hindsight-perf-defaults.ts"),
    "utf8",
  );
  const m = emitter.match(
    /HINDSIGHT_DEFAULT_GRAPH_SEED_MIN_SIMILARITY\s*=\s*([0-9.]+)/,
  );
  if (!m) {
    throw new Error(
      "src/setup/hindsight-perf-defaults.ts no longer exports " +
        "HINDSIGHT_DEFAULT_GRAPH_SEED_MIN_SIMILARITY — if the explicit emission was " +
        "dropped, the graph seed floor is back to being whatever upstream defaults to",
    );
  }
  return m[1];
})();

/**
 * Python probe, run inside the pinned image.
 *
 * Exits 0 only when the native reuse path is present AND the floor switchroom
 * emits actually reaches config. Asserts OUTCOMES (the value config resolves to,
 * the parameters the real functions accept) rather than that a path ran.
 */
const PROBE = String.raw`
import inspect
import json
import os
import sys

failures = []


def fail(msg):
    failures.append(msg)


# ── 1. the #2968 reuse path is native in this image ───────────────────────
# Checked on the real module sources, so a revert upstream reds here instead of
# silently reinstating the duplicate ANN scan.
from hindsight_api.engine.search import graph_retrieval, link_expansion_retrieval, retrieval

for name, mod in (
    ("graph_retrieval", graph_retrieval),
    ("link_expansion_retrieval", link_expansion_retrieval),
):
    present = "preselected_semantic_seeds" in inspect.getsource(mod)
    print("NATIVE_SEEDS_" + name.upper(), present)
    if not present:
        fail(
            name + " no longer accepts preselected_semantic_seeds — upstream #2968 "
            "appears reverted, and the retired carry is no longer covering for it"
        )

# The caller side matters too: a parameter nothing passes is a dead parameter.
wired = "preselected_semantic_seeds=" in inspect.getsource(retrieval)
print("NATIVE_SEEDS_WIRED", wired)
if not wired:
    fail(
        "retrieval.py never passes preselected_semantic_seeds — the reuse path exists "
        "but is not wired, so every recall still runs the dedicated seed query"
    )

# ── 2. the UUID-lookup half of #2968 is native too ────────────────────────
from hindsight_api.engine.db import ops_postgresql

uuid_cast = "input.unit_id::uuid" in inspect.getsource(ops_postgresql)
print("NATIVE_UUID_CAST", uuid_cast)
if not uuid_cast:
    fail(
        "fetch_unit_dates no longer uses the ::uuid form — the id::text cast that "
        "forced a sequential scan (120.049ms -> 0.240ms median) is back"
    )

# ── 3. the floor switchroom emits actually reaches config ─────────────────
from hindsight_api.config import HindsightConfig

resolved = HindsightConfig.from_env().graph_seed_min_similarity
print("ENV_SET", json.dumps(os.getenv("HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY")))
print("RESOLVED_FLOOR", repr(resolved))
expected = float(os.environ["SWITCHROOM_EXPECTED_FLOOR"])
if resolved != expected:
    fail(
        "config resolved graph_seed_min_similarity="
        + repr(resolved)
        + " but switchroom emits "
        + repr(expected)
        + " — the key was renamed, retyped, or is no longer read"
    )

print("FAILURES", failures)
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or
 * an absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/**
 * Run the probe in a throwaway container.
 *
 * `withEnv` decides whether switchroom's emission is applied. The env var is set
 * on the CONTAINER, not injected into the probe source, so what runs is the same
 * `HindsightConfig.from_env()` path the real server takes.
 */
async function runProbe(withEnv: boolean, floor: string): Promise<ProbeResult> {
  const name = `sr-hs-graphseed-${withEnv ? "emitted" : "default"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    await execFileAsync("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `switchroom.test=${TEST_PHASE}`,
        "--label",
        `switchroom.test.run=${RUN_ID}`,
        "--user",
        "root",
        "--network",
        "none",
        "-e",
        `SWITCHROOM_EXPECTED_FLOOR=${floor}`,
        ...(withEnv ? ["-e", `${ENV_KEY}=${floor}`] : []),
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ]);

    const res = await execFileAsync("docker", ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"], { input: PROBE });
    return { status: 0, stdout: res.stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

describe("hindsight graph-seed retirement guard is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("the carry it replaced is really gone from the shipping Dockerfile", () => {
    // Re-adding it on a rebase would stack a patch on top of upstream's own
    // implementation. `dockerfile-hindsight-bakes.test.ts` guards the same
    // absence on the literals; this is the behavioural side's copy.
    expect(dockerfile).not.toContain(RETIRED_PATCH_MARKER);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`,
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable",
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite",
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "the retired #2968 carry's behaviour survived the retirement",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("the pinned image ships #2968 natively, wired end to end", async () => {
      const { status, stdout } = await runProbe(true, PINNED_FLOOR);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // Both halves of the carry, and the caller that makes the first one live.
      expect(stdout).toContain("NATIVE_SEEDS_GRAPH_RETRIEVAL True");
      expect(stdout).toContain("NATIVE_SEEDS_LINK_EXPANSION_RETRIEVAL True");
      expect(stdout).toContain("NATIVE_SEEDS_WIRED True");
      expect(stdout).toContain("NATIVE_UUID_CAST True");

      // And switchroom's emitted floor is what config resolves to.
      expect(stdout).toContain(`ENV_SET "${PINNED_FLOOR}"`);
      expect(stdout).toContain(`RESOLVED_FLOOR ${Number(PINNED_FLOOR)}`);
    }, 240_000);

    /**
     * The emission is LOAD-BEARING, not decorative.
     *
     * Upstream's default happens to equal our pin today, so a probe that only
     * ran the emitted case would stay green if the emission were deleted. This
     * arm proves the env var is the thing setting the value by demanding a floor
     * that is deliberately NOT upstream's default: without the emission the
     * container resolves 0.3 and the probe goes red.
     */
    it("the floor comes from switchroom's emission, not from upstream's default", async () => {
      const OFF_DEFAULT = "0.42";
      expect(
        OFF_DEFAULT,
        "this arm is meaningless if it happens to equal the pinned floor",
      ).not.toBe(PINNED_FLOOR);

      const emitted = await runProbe(true, OFF_DEFAULT);
      expect(emitted.stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(emitted.status, `probe failed:\n${emitted.stdout}`).toBe(0);
      expect(emitted.stdout).toContain("RESOLVED_FLOOR 0.42");

      const unset = await runProbe(false, OFF_DEFAULT);
      expect(unset.stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(
        unset.status,
        `probe unexpectedly passed with the env var unset:\n${unset.stdout}`,
      ).not.toBe(0);
      expect(unset.stdout).toContain("ENV_SET null");
      // Upstream's own default, which is what the fleet would silently inherit
      // if the explicit emission were ever dropped.
      expect(unset.stdout).toContain("RESOLVED_FLOOR 0.3");
    }, 240_000);
  },
);
