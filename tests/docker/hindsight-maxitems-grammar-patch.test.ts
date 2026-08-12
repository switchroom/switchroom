/**
 * Behavioural proof that switchroom's `HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS=false`
 * emission REPLACES the retired consolidation-maxItems-grammar Dockerfile patch,
 * outcome for outcome, on the pinned v0.8.6 image.
 *
 * THE DEFECT, in the real shipping source.
 * `_build_response_model()` (`engine/consolidation/consolidator.py:693`)
 * constrains `creates` with `PydanticField(default=[], max_length=clamped)`,
 * which pydantic serialises as `"maxItems": <clamped>`. Its one caller
 * (`consolidator.py:2272`) passes `max_creates=remaining_observation_slots` —
 * the bank's remaining observation-slot count, not a modelling constraint.
 * Measured on this host 2026-07-28 against the running `switchroom-hindsight`
 * container: `_build_response_model(max_creates=4230).model_json_schema()`
 * yields `{"maxItems": 4230, ...}` for `creates`.
 *
 * Local llama.cpp/Ollama compile that schema into a GBNF grammar and a
 * repetition count that large fails to build, so the deployment answers
 * `HTTP 400 {"error":{"code":400,"message":"Failed to initialize samplers:
 * failed to parse grammar",...}}`. LiteLLM's router fallback then re-sends the
 * identical call — batch prompt and all, carrying verbatim private corpus text
 * — to the metered OpenRouter deployment (56 such fallbacks logged for
 * `Received Model Group=gpt-oss-20b-consolidation`). Deterministic per bank:
 * ~4,230 remaining slots fails every time, ~670 compiles (threshold measured
 * between 672 and 4,223).
 *
 * WHAT CHANGED IN v0.8.6, AND WHY THE PATCH IS GONE. Upstream added
 * `supports_max_items: bool = True` to `_build_response_model` and wired it to
 * `config.llm_supports_max_items` (`consolidator.py:2273`), driven by
 * `HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS` (`config.py:173`, default True at
 * `config.py:858`). The defect is now fixable by CONFIGURATION, so carrying a
 * source patch for it would be a second, drifting opinion about a behaviour
 * upstream owns. switchroom emits the key on the local-LLM path
 * (`HINDSIGHT_DEFAULT_LLM_SUPPORTS_MAX_ITEMS`, src/setup/hindsight-perf-defaults.ts).
 *
 * WHY THIS FILE STILL EXISTS RATHER THAN BEING DELETED WITH THE PATCH.
 * "We deleted an egress control and set an env var instead" is a claim, and
 * `hindsight-perf-defaults.test.ts` can only prove the STRING is emitted. This
 * file proves the string BUYS the outcome the patch bought, by driving the real
 * `_build_response_model` inside the pinned image with the env var actually set
 * — the same call path pydantic takes when the schema is handed to the provider
 * — and asserting on the emitted `maxItems`. The two arms are now DEFAULT (env
 * unset ⇒ RED, the defect reproduced on 0.8.6) and CONFIGURED (env=false ⇒
 * GREEN). If upstream ever renames the key, drops the parameter, or stops
 * threading it from config, the RED arm stays red and the GREEN arm goes red
 * too — which is the loud failure the deleted build-time assert used to give us.
 *
 * ONE DELIBERATE BEHAVIOUR DIFFERENCE from the retired patch: the patch kept the
 * hint when the cap was genuinely tight (<= 64, compilable) and dropped it only
 * above that ceiling. Upstream's flag is all-or-nothing, so with the flag off a
 * tight cap is no longer stated to the model either. That is safe — and asserted
 * here — because the cap is still enforced after validation in Python
 * (`creates = creates[:remaining_observation_slots]`, `consolidator.py:2323`)
 * and still stated in the prompt capacity note. Probe assertion 6 pins that
 * truncation, so the premise cannot silently disappear.
 *
 * SKIP DISCIPLINE: identical to `hindsight-retry-perturbation-patches.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
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
const TEST_PHASE = "hindsight-maxitems-grammar-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The retired patch, named by the unique in-block marker it used to carry. */
const RETIRED_PATCH_NAME = "consolidation-maxItems-grammar patch";

/** The env key that replaced it, emitted by src/setup/hindsight-perf-defaults.ts. */
const ENV_KEY = "HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS";

/**
 * The patch really is gone from the shipping Dockerfile.
 *
 * Asserted rather than assumed: if someone re-adds the block on a rebase it
 * would stack on top of upstream's own fix, and the DEFAULT arm below would
 * stop being red — turning this file into a probe that proves nothing.
 */
function retiredPatchBlockCount(): number {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  return blocks.filter((b) => b.includes(RETIRED_PATCH_NAME)).length;
}

/**
 * Python probe. Exits 0 only when the emitted schema is compilable at every
 * slot count that matters; prints the offending assertions otherwise.
 *
 * Deliberately asserts the OUTCOME — the `maxItems` value pydantic actually
 * serialises — not that a code path ran. Nothing here greps the patched source.
 */
const PROBE = String.raw`
import json
import sys

failures = []


def fail(msg):
    failures.append(msg)


from hindsight_api.engine.consolidation.consolidator import _build_response_model

# The measured grammar-compilation threshold on this fleet: 672 compiles,
# 4,223 does not. 4230 is a real production remaining-slot count.
PRODUCTION_SLOTS = 4230
# The largest maxItems a local GBNF backend is known to compile here.
COMPILABLE_CEILING = 64


# Read the flag out of the REAL config loader rather than passing the kwarg
# by hand — the thing under test is the env var switchroom emits, so the
# env -> config -> call-site thread is part of what must hold. A rename of
# HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS upstream reds this probe instead of
# silently reverting us to the defect.
from hindsight_api.config import HindsightConfig

SUPPORTS = HindsightConfig.from_env().llm_supports_max_items
print("CONFIG_SUPPORTS_MAX_ITEMS", SUPPORTS)


def creates_schema(max_creates):
    model = _build_response_model(max_creates=max_creates, supports_max_items=SUPPORTS)
    return model.model_json_schema()["properties"]["creates"]


def max_items(max_creates):
    return creates_schema(max_creates).get("maxItems")


# ── 1. the defect itself: a production-like slot count ────────────────────
prod = max_items(PRODUCTION_SLOTS)
print("MAXITEMS_PRODUCTION", json.dumps(prod))
if prod is not None:
    fail(
        "schema for remaining_observation_slots="
        + str(PRODUCTION_SLOTS)
        + " emitted maxItems="
        + repr(prod)
        + " — a local GBNF backend cannot compile this and the call falls over "
        "to the metered provider"
    )

# ── 2. the whole uncompilable band, not just one lucky number ─────────────
band = {n: max_items(n) for n in (673, 1000, 4223, PRODUCTION_SLOTS, 100000)}
print("MAXITEMS_BAND", json.dumps({str(k): v for k, v in sorted(band.items())}))
for n, v in sorted(band.items()):
    if v is not None and v > COMPILABLE_CEILING:
        fail(
            "slots="
            + str(n)
            + " emitted an uncompilable maxItems="
            + repr(v)
            + " (ceiling "
            + str(COMPILABLE_CEILING)
            + ")"
        )

# ── 3. a genuinely tight cap is still expressed to the model ──────────────
# The constraint is real there (2 slots left really does mean at most 2
# creates), it compiles trivially, and dropping it would make the model emit
# creates the caller then silently truncates.
# Upstream's flag is all-or-nothing, so with it OFF the tight caps lose the
# hint too. That is the one deliberate behaviour difference from the retired
# patch, and it is recorded here rather than asserted away — assertion 6 is
# what makes it safe.
tight = {n: max_items(n) for n in (0, 1, 2, 6, 64)}
print("MAXITEMS_TIGHT", json.dumps({str(k): v for k, v in sorted(tight.items())}))
for n, v in sorted(tight.items()):
    want = None if not SUPPORTS else n
    if v != want:
        fail("slots=" + str(n) + " should emit maxItems=" + repr(want) + ", got " + repr(v))

# ── 4. upstream's own no-constraint contract is untouched ─────────────────
for sentinel in (None, -1):
    v = max_items(sentinel)
    if v is not None:
        fail("max_creates=" + repr(sentinel) + " must stay unconstrained, got maxItems=" + repr(v))
print("MAXITEMS_UNCONSTRAINED", json.dumps([max_items(None), max_items(-1)]))

# ── 5. omitting maxItems must not change anything else about the field ────
# Same shape as the unconstrained model, so the only delta is the cap.
base = _build_response_model(
    max_creates=None, supports_max_items=SUPPORTS
).model_json_schema()["properties"]["creates"]
prod_schema = creates_schema(PRODUCTION_SLOTS)
print("SCHEMA_PRODUCTION", json.dumps(prod_schema, sort_keys=True))
if {k: v for k, v in prod_schema.items() if k != "title"} != {
    k: v for k, v in base.items() if k != "title"
}:
    fail(
        "the unconstrained-above-ceiling schema differs from the unconstrained one "
        "by more than maxItems: " + json.dumps(prod_schema, sort_keys=True)
    )

# ── 6. the cap is still ENFORCED in Python, which is why omitting is safe ─
import inspect
import hindsight_api.engine.consolidation.consolidator as _c

src = inspect.getsource(_c)
enforced = "creates = creates[:remaining_observation_slots]" in src
print("PYTHON_TRUNCATION_PRESENT", enforced)
if not enforced:
    fail(
        "consolidator.py no longer truncates creates to remaining_observation_slots — "
        "without it, omitting maxItems would DROP the observation cap"
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
 * Run the probe in a throwaway container, with the switchroom env emission
 * either applied (`configured`) or absent (upstream's default).
 *
 * The env var is set on the CONTAINER, not injected into the probe source, so
 * what runs is the same `HindsightConfig.from_env()` path the real server takes.
 */
async function runProbe(configured: boolean): Promise<ProbeResult> {
  const name = `sr-hs-maxitems-${configured ? "configured" : "default"}-${RUN_ID.slice(
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
        ...(configured ? ["-e", `${ENV_KEY}=false`] : []),
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

describe("hindsight maxItems-grammar successor probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("the source patch it replaced is really gone from the shipping Dockerfile", () => {
    // If this ever goes to 1 again the DEFAULT arm below stops being red and
    // the probe silently stops proving anything.
    expect(retiredPatchBlockCount()).toBe(0);
  });

  it("the env key under test is the one switchroom actually emits", () => {
    // Read out of the emitter rather than duplicated as a second literal: a
    // rename there without a rename here would leave this probe green while
    // the fleet ships the defect.
    const emitter = readFileSync(
      resolve(root, "src/setup/hindsight-perf-defaults.ts"),
      "utf8",
    );
    expect(emitter).toContain(`"${ENV_KEY}"`);
    expect(emitter).toContain("HINDSIGHT_DEFAULT_LLM_SUPPORTS_MAX_ITEMS = \"false\"");
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
  "HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS=false changes real behaviour on the pinned image",
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

    it("upstream's DEFAULT is RED — the schema carries the bank's raw slot count", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: the emitted schema states maxItems: 4230, which is
      // exactly what a local GBNF backend refuses to compile.
      // The flag really did default to on — i.e. this arm is red for the
      // reason claimed, not because the probe failed to load config.
      expect(stdout).toContain("CONFIG_SUPPORTS_MAX_ITEMS True");
      expect(stdout).toContain("MAXITEMS_PRODUCTION 4230");
      expect(stdout).toContain(
        'MAXITEMS_BAND {"673": 673, "1000": 1000, "4223": 4223, "4230": 4230, "100000": 100000}',
      );
      // Upstream is already correct on the tight and unconstrained cases, so
      // those are NOT what makes this run red — the large band is.
      expect(stdout).toContain(
        'MAXITEMS_TIGHT {"0": 0, "1": 1, "2": 2, "6": 6, "64": 64}',
      );
      expect(stdout).toContain("MAXITEMS_UNCONSTRAINED [null, null]");
      // And upstream already enforces the cap in Python, which is the premise
      // that makes dropping the schema hint safe.
      expect(stdout).toContain("PYTHON_TRUNCATION_PRESENT True");
    }, 240_000);

    it(`upstream + ${ENV_KEY}=false is GREEN — maxItems is absent entirely`, async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // The env var actually reached config — without this, "no maxItems"
      // could equally mean the probe never built a constrained model.
      expect(stdout).toContain("CONFIG_SUPPORTS_MAX_ITEMS False");

      // 1./2. no uncompilable repetition count survives, anywhere in the band.
      expect(stdout).toContain("MAXITEMS_PRODUCTION null");
      expect(stdout).toContain(
        'MAXITEMS_BAND {"673": null, "1000": null, "4223": null, "4230": null, "100000": null}',
      );
      // 3. THE DELIBERATE DIFFERENCE from the retired patch, asserted rather
      // than hidden: upstream's flag is all-or-nothing, so tight caps lose the
      // hint too. Safe only because of 6 below.
      expect(stdout).toContain(
        'MAXITEMS_TIGHT {"0": null, "1": null, "2": null, "6": null, "64": null}',
      );
      // 4. upstream's None/-1 contract is untouched.
      expect(stdout).toContain("MAXITEMS_UNCONSTRAINED [null, null]");
      // 5. the field is otherwise byte-identical to the unconstrained one — the
      // patch drops a cap, it does not reshape the schema.
      expect(stdout).toContain(
        'SCHEMA_PRODUCTION {"default": [], "items": {"$ref": "#/$defs/_CreateAction"}, "title": "Creates", "type": "array"}',
      );
      expect(stdout).not.toContain('"maxItems"');
      // 6. and the cap is still really enforced, after validation, in Python.
      expect(stdout).toContain("PYTHON_TRUNCATION_PRESENT True");
    }, 240_000);
  },
);
