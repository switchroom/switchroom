/**
 * Behavioural proof for the perturbed-JSON-retry patch `docker/Dockerfile.hindsight`
 * bakes into the pinned upstream Hindsight image (#3669).
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED) and against upstream +
 * the patch block applied (must be GREEN).
 *
 * WHY THE SHAPE TEST IS NOT ENOUGH — the gap this file closes. #3660 shipped a
 * Dockerfile behaviour change whose revert nothing caught; the remedy that
 * landed was a THREE-layer gate (a build-time assert, a runtime probe, and a
 * bakes-test mention). #3669 shipped layers 1 and 3 only, and the hole is
 * demonstrable: indent the whole perturbation body under a falsy guard —
 *
 *     if os.environ.get("HINDSIGHT_PERTURB"):
 *         _extra = dict(call_kwargs.get("extra_body") or {})
 *         ...
 *         call_kwargs["extra_body"] = _extra
 *
 * — and the fix is inert while every literal the bakes test greps for is still
 * present. `os` is already imported (`litellm_llm.py:18`), so nothing raises;
 * the block still parses under the patch's own `ast.parse` and still satisfies
 * its post-replace text asserts, because those assert on COUNTS of substrings,
 * not on column. Measured 2026-07-26: all 24 bakes cases green, fix disabled.
 * Only running the patched module catches it, which is what this file does.
 *
 * (The weaker mutation of merely INSERTING `if ...: pass` above the body is a
 * no-op — the perturbation still executes at its original indentation — so it
 * proves nothing. The indent is what makes it a genuine revert.)
 *
 * THE DEFECT, in the real shipping source. `LiteLLMLLM.call()`
 * (`/app/api/hindsight_api/engine/providers/litellm_llm.py:216`) builds
 * `call_kwargs` ONCE, above the retry loop, and its
 * `except json.JSONDecodeError` handler sleeps and re-issues that same dict
 * unchanged. Behind a caching LiteLLM proxy that is not a retry: the proxy
 * replays the identical unparseable body, so every attempt consumes one bad
 * completion and the retain fails. Measured on this host 2026-07-26 against the
 * proxy at 127.0.0.1:4010 — cold 41.29s id=chatcmpl-112, identical repeat 0.02s
 * id=chatcmpl-112 (a cache replay), `extra_body` no-cache 37.66s id=chatcmpl-101
 * (genuinely bypassed).
 *
 * The four properties this probe drives, none of which the patch TEXT can show:
 *
 *  1. Attempt 1 is byte-for-byte what upstream would have sent — no
 *     `extra_body`, the caller's temperature untouched. That is what keeps the
 *     healthy-call cache hit-rate unchanged, and it is the property most easily
 *     lost by "simplifying" the patch to set the kwargs before the loop.
 *  2. Every RETRY carries `extra_body={"cache": {"no-cache": True}}`, so the
 *     proxy is actually bypassed. It must travel in `extra_body`: litellm's
 *     top-level `cache=` kwarg is consumed by the SDK and never reaches the
 *     wire (measured, same run).
 *  3. The temperature ramp is +0.3 CAPPED AT 0.7, and the cap binds. The
 *     requested json_schema is advisory rather than enforced (one of the two
 *     measured bad bodies was a numbered prose list emitted WHILE a schema was
 *     set), so a ramp to 1.0 would make the late attempts the likeliest to emit
 *     invalid JSON — backwards for a retry.
 *  4. A caller that set NO temperature never acquires one, so models that
 *     reject the parameter keep clean kwargs.
 *
 * The probe drives the REAL `LiteLLMLLM.call()` from the image — only
 * `_acompletion` is stubbed, because the point is to observe the kwargs the
 * loop hands it on each attempt — rather than re-implementing the loop here.
 * `max_retries=3` is not arbitrary: it is what the retain path actually passes
 * (`engine/retain/fact_extraction.py:1327` forwards `llm_max_retries`, whose
 * default is `config.py:730 DEFAULT_LLM_MAX_RETRIES = 3`), and `temperature=0.1`
 * is `DEFAULT_LLM_TEMPERATURE_RETAIN` (`config.py:184`).
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-recall-isolation-patches.test.ts`.
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
const TEST_PHASE = "hindsight-retry-perturbation-patches";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "perturbed-JSON-retry patch";

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
 * Python probe. Exits 0 only when all four properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: it runs the real retry loop to exhaustion and
 * records the exact kwargs dict handed to the completion call on every attempt.
 * Nothing here greps the patched source.
 */
const PROBE = String.raw`
import asyncio
import json
import sys

failures = []


def fail(msg):
    failures.append(msg)


from hindsight_api.engine.providers.litellm_llm import LiteLLMLLM


# ── the smallest response object call() actually reads ────────────────────
class _Msg:
    def __init__(self, content):
        self.content = content


class _Choice:
    def __init__(self, content):
        self.message = _Msg(content)
        self.finish_reason = "stop"


class _Resp:
    def __init__(self, content):
        self.choices = [_Choice(content)]
        self.usage = None
        self.model = "probe-model"


class _Schema:
    """A response_format stand-in: call() only needs the schema + a name."""

    __name__ = "ProbeSchema"

    @staticmethod
    def model_json_schema():
        return {"type": "object", "properties": {"facts": {"type": "array"}}}


def _make():
    """A real LiteLLMLLM with only the completion call stubbed.

    __init__ wants a live config, so the instance is built directly and given
    exactly the attributes _build_common_kwargs / call() read. Everything that
    decides the retry behaviour is the shipping code.
    """
    llm = object.__new__(LiteLLMLLM)
    llm.model = "openai/probe"
    llm.timeout = 30
    llm.api_key = "probe-key"
    llm.base_url = "http://127.0.0.1:4010"
    llm._extra_body = {}
    llm._default_headers = {}
    llm.bedrock_service_tier = None
    llm.provider = "litellm"

    seen = []

    async def _acompletion(**kwargs):
        # Snapshot, not alias: call() MUTATES call_kwargs in place between
        # attempts, so keeping the reference would make every entry equal.
        seen.append(json.loads(json.dumps(kwargs, default=str)))
        # Never parseable, so every attempt takes the JSONDecodeError path.
        return _Resp("1. not json at all")

    llm._acompletion = _acompletion
    llm._resolve_completion_model = lambda response: "probe-model"
    return llm, seen


async def _drive(temperature, max_retries=3):
    llm, seen = _make()
    try:
        await llm.call(
            messages=[{"role": "user", "content": "probe"}],
            response_format=_Schema,
            temperature=temperature,
            scope="retain_extract_facts",
            max_retries=max_retries,
            # Zero backoff: this probe measures kwargs, not sleeping.
            initial_backoff=0.0,
            max_backoff=0.0,
            skip_validation=True,
        )
    except json.JSONDecodeError:
        pass  # expected — the loop exhausts and re-raises
    except Exception as e:
        fail("unexpected exception from call(): " + type(e).__name__ + ": " + str(e))
    return seen


NO_CACHE = {"cache": {"no-cache": True}}

# ── the retain shape: max_retries=3, temperature=0.1 ──────────────────────
seen = asyncio.run(_drive(0.1))
print("ATTEMPTS", len(seen))
if len(seen) != 4:
    fail("expected 4 attempts (max_retries=3), got " + str(len(seen)))

extras = [k.get("extra_body") for k in seen]
temps = [k.get("temperature") for k in seen]
print("EXTRA_BODY", json.dumps(extras, sort_keys=True))
print("TEMPERATURES", json.dumps(temps))

# 1. attempt 1 is byte-for-byte upstream's request
if extras[:1] != [None]:
    fail("attempt 1 carried extra_body " + repr(extras[0]) + " — it must be untouched")
if temps[:1] != [0.1]:
    fail("attempt 1 temperature was " + repr(temps[0]) + ", expected the caller's 0.1")

# 2. every RETRY bypasses the proxy response cache
retry_extras = extras[1:]
if not retry_extras:
    fail("no retry was issued at all")
elif any(e != NO_CACHE for e in retry_extras):
    fail(
        "a retry replayed an un-perturbed request: extra_body="
        + json.dumps(retry_extras, sort_keys=True)
    )
    print("CACHE_REPLAYED_IDENTICAL_REQUEST True")

# 3. the ramp is +0.3 capped at 0.7, and the cap BINDS on this path
if temps != [0.1, 0.4, 0.7, 0.7]:
    fail("temperature ramp was " + json.dumps(temps) + ", expected [0.1, 0.4, 0.7, 0.7]")
if any(t is not None and t > 0.7 for t in temps):
    fail("temperature exceeded the 0.7 cap: " + json.dumps(temps))

# 4. a caller that set no temperature never acquires one
seen_none = asyncio.run(_drive(None))
temps_none = ["<absent>" if "temperature" not in k else k["temperature"] for k in seen_none]
extras_none = [k.get("extra_body") for k in seen_none]
print("TEMPERATURES_UNSET", json.dumps(temps_none))
print("EXTRA_BODY_UNSET", json.dumps(extras_none, sort_keys=True))
if any(t != "<absent>" for t in temps_none):
    fail("a caller that set no temperature acquired one: " + json.dumps(temps_none))
# …but it still gets the load-bearing perturbation.
if extras_none[1:] and any(e != NO_CACHE for e in extras_none[1:]):
    fail(
        "the cache bypass was skipped when no temperature was set: "
        + json.dumps(extras_none, sort_keys=True)
    )

# The whole point, stated as one line the RED run also emits.
print(
    "DISTINCT_RETRY_REQUESTS",
    len({json.dumps(k, sort_keys=True) for k in seen}),
    "of",
    len(seen),
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
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-retry-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ]);

    if (patched) {
      for (const block of patchBlocks()) {
        // The block is self-verifying: it asserts its upstream anchor exists
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
        await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: block });
      }
    }

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

describe("Dockerfile.hindsight retry-perturbation probe is real, not a silent skip", () => {
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
  "Dockerfile.hindsight perturbed-JSON-retry patch changes real behaviour",
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

    it("unpatched upstream is RED — all four attempts are the identical request", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven: the retry loop hands the completion call the very
      // same dict every time, so behind a caching proxy all four attempts
      // consume one cached bad completion.
      expect(stdout).toContain("ATTEMPTS 4");
      expect(stdout).toContain("EXTRA_BODY [null, null, null, null]");
      expect(stdout).toContain("TEMPERATURES [0.1, 0.1, 0.1, 0.1]");
      expect(stdout).toContain("DISTINCT_RETRY_REQUESTS 1 of 4");
      expect(stdout).toContain("CACHE_REPLAYED_IDENTICAL_REQUEST True");
    }, 240_000);

    it("upstream + the baked patch block is GREEN on all four properties", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1. attempt 1 is untouched (healthy-call cache hit-rate preserved) and
      // 2. every retry carries the proxy cache bypass, in `extra_body`.
      expect(stdout).toContain(
        'EXTRA_BODY [null, {"cache": {"no-cache": true}}, ' +
          '{"cache": {"no-cache": true}}, {"cache": {"no-cache": true}}]',
      );
      // 3. +0.3 per retry, capped at 0.7 — and on the retain path (max_retries=3,
      // temperature=0.1) the cap BINDS, so a regression to a 1.0 cap changes
      // this line rather than being invisible.
      expect(stdout).toContain("TEMPERATURES [0.1, 0.4, 0.7, 0.7]");
      // 4. a caller that set no temperature still gets the load-bearing
      // perturbation but never acquires a temperature.
      expect(stdout).toContain(
        'TEMPERATURES_UNSET ["<absent>", "<absent>", "<absent>", "<absent>"]',
      );
      expect(stdout).toContain(
        'EXTRA_BODY_UNSET [null, {"cache": {"no-cache": true}}, ' +
          '{"cache": {"no-cache": true}}, {"cache": {"no-cache": true}}]',
      );
      // The headline: the retries are genuinely different requests now.
      expect(stdout).toContain("DISTINCT_RETRY_REQUESTS 3 of 4");
      expect(stdout).not.toContain("CACHE_REPLAYED_IDENTICAL_REQUEST");
    }, 240_000);
  },
);
