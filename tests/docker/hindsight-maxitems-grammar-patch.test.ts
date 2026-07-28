/**
 * Behavioural proof for the consolidation-maxItems-grammar patch that
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it builds
 * the real consolidation response model at a production-like remaining-slot
 * count and reads the `maxItems` pydantic actually emits into the request
 * schema — RED against unpatched upstream, GREEN with the patch applied.
 *
 * THE DEFECT, in the real shipping source.
 * `_build_response_model()` (`engine/consolidation/consolidator.py`) constrains
 * `creates` with `PydanticField(default=[], max_length=clamped)`, which pydantic
 * serialises as `"maxItems": <clamped>`. Its one caller passes
 * `max_creates=remaining_observation_slots` — the bank's remaining
 * observation-slot count, not a modelling constraint. Measured on this host
 * 2026-07-28 against the running `switchroom-hindsight` container:
 * `_build_response_model(max_creates=4230).model_json_schema()` yields
 * `{"maxItems": 4230, ...}` for `creates`.
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
 * WHY THIS PROBE AND NOT A GREP. The bakes test's assertions are unanchored
 * substring matches: raising the ceiling to 100_000, or reintroducing a clamp
 * that still emits a four-digit `maxItems`, keeps every literal it greps for in
 * place while the schema is once again uncompilable. Only serialising the model
 * and reading the emitted number catches that, which is what this file does.
 *
 * It drives the REAL `_build_response_model` from the image and asserts on
 * `model_json_schema()` — the same call path pydantic takes when the schema is
 * handed to the provider — rather than re-implementing the model here. It
 * applies the patch by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
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

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "consolidation-maxItems-grammar patch";

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by its unique patch name.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const hits = blocks.filter((b) => b.includes(PATCH_NAME));
  if (hits.length !== 1) {
    throw new Error(
      `Dockerfile.hindsight contains ${hits.length} "${PATCH_NAME}" RUN blocks ` +
        `(expected exactly 1) — if the patch was deliberately removed, delete ` +
        `this test with it.`,
    );
  }
  return hits;
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


def creates_schema(max_creates):
    model = _build_response_model(max_creates=max_creates)
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
tight = {n: max_items(n) for n in (0, 1, 2, 6, 64)}
print("MAXITEMS_TIGHT", json.dumps({str(k): v for k, v in sorted(tight.items())}))
for n, v in sorted(tight.items()):
    if v != n:
        fail("slots=" + str(n) + " should still emit maxItems=" + str(n) + ", got " + repr(v))

# ── 4. upstream's own no-constraint contract is untouched ─────────────────
for sentinel in (None, -1):
    v = max_items(sentinel)
    if v is not None:
        fail("max_creates=" + repr(sentinel) + " must stay unconstrained, got maxItems=" + repr(v))
print("MAXITEMS_UNCONSTRAINED", json.dumps([max_items(None), max_items(-1)]))

# ── 5. omitting maxItems must not change anything else about the field ────
# Same shape as the unconstrained model, so the only delta is the cap.
base = _build_response_model(max_creates=None).model_json_schema()["properties"]["creates"]
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

/** Run the probe in a throwaway container, optionally patching first. */
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-maxitems-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    execFileSync(
      "docker",
      [
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
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    if (patched) {
      for (const block of patchBlocks()) {
        // The block is self-verifying: it asserts its upstream anchor exists
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
        execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
          input: block,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight maxItems-grammar probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the one patch block it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(1);
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
  "Dockerfile.hindsight consolidation-maxItems-grammar patch changes real behaviour",
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

    it("unpatched upstream is RED — the schema carries the bank's raw slot count", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: the emitted schema states maxItems: 4230, which is
      // exactly what a local GBNF backend refuses to compile.
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

    it("upstream + the baked patch block is GREEN — maxItems is absent above the ceiling", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1./2. no uncompilable repetition count survives, anywhere in the band.
      expect(stdout).toContain("MAXITEMS_PRODUCTION null");
      expect(stdout).toContain(
        'MAXITEMS_BAND {"673": null, "1000": null, "4223": null, "4230": null, "100000": null}',
      );
      // 3. a cap that is genuinely tight is still stated to the model, so this
      // is an omission of a non-binding guard rather than a blanket removal.
      expect(stdout).toContain(
        'MAXITEMS_TIGHT {"0": 0, "1": 1, "2": 2, "6": 6, "64": 64}',
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
