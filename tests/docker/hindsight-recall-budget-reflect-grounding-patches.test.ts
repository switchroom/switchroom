/**
 * Behavioural proof for the three recall-budget / reflect-grounding patches
 * that `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image. `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch
 * blocks (grep-on-file, runs everywhere). This file proves the *outcome*: it
 * runs the same probe against unpatched upstream (must be RED on every defect)
 * and against upstream + the patch blocks applied (must be GREEN).
 *
 * The three defects, all verified live on this fleet before the fix:
 *
 *  1. MCP recall's `max_tokens` was a dishonest budget. The engine's
 *     `_filter_by_token_budget` costs only fact TEXT, but the MCP tool then
 *     serialized with `model_dump_json(indent=2)` and explicit nulls —
 *     measured live, 6,079 bytes of fact text became 40,857 bytes on the wire
 *     (6.7x), so `max_tokens: 1500` delivered ~3.5k tokens.
 *  2. The reflect mental-model short-circuit had no relevance gate. On
 *     low/mid budget, ANY bank holding at least one fresh mental model
 *     released the forced search_observations/recall layers on EVERY query
 *     regardless of topic — the helper checked only `is_stale` and non-empty
 *     content, and the mental-model search is unfloored top-K. Observed: the
 *     same bank answered "I don't have information" and a full correct answer
 *     to near-identical queries seconds apart.
 *  3. Reflect's temperature knob was dead. `DEFAULT_LLM_TEMPERATURE_REFLECT`
 *     (0.9) was resolved into config but NO agentic call site passed
 *     `temperature`, and the litellm provider omits the kwarg when None — so
 *     the provider default (~1.0) applied to factual synthesis. Observed:
 *     reflect reported publish dates its own cited memory contradicts.
 *
 * Beyond proving the fixes, the probe pins the properties that make them
 * SAFE, none of which is visible from the patch text alone:
 *
 *  - The honest budget lives in the MCP layer ONLY. The per-turn auto-recall
 *    hook injects only fact text, so trimmed results stay a non-empty ranked
 *    prefix, a generous budget trims nothing, and
 *    `HINDSIGHT_MCP_RECALL_BUDGET_MODE=legacy` restores upstream's exact
 *    bytes (the restart-level rollback).
 *  - The upstream 0.8.0 short-circuit optimization SURVIVES: a genuinely
 *    on-topic fresh mental-model set still releases forcing; stale/empty
 *    models still block; `HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR=0` restores
 *    upstream gating exactly; bad floor values fall back rather than raise.
 *  - The temperature is threaded through upstream's own env resolver, so
 *    `HINDSIGHT_API_LLM_TEMPERATURE_REFLECT` (including the documented
 *    `none` omit-sentinel) keeps working, and the provider still forwards a
 *    non-None temperature and omits None.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-search-patches.test.ts`. Locally,
 * with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls
 * the pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under
 * which an unavailable docker/image is a HARD FAILURE, never a green skip.
 * Both probe runs assert a `PROBE_EXECUTED` sentinel so a probe that dies
 * early can never be mistaken for a pass.
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
const TEST_PHASE = "hindsight-recall-budget-reflect-grounding";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by their unique patch names.
 */
const PATCH_NAMES = [
  "mcp-recall-token-budget patch",
  "reflect-mm-relevance-floor patch",
  "reflect-temperature patch",
];

function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  return PATCH_NAMES.map((name) => {
    const hits = blocks.filter((b) => b.includes(name));
    if (hits.length !== 1) {
      throw new Error(
        `Dockerfile.hindsight contains ${hits.length} "${name}" RUN blocks ` +
          `(expected exactly 1) — if the patch was deliberately removed, ` +
          `delete its assertions from this test with it.`,
      );
    }
    return hits[0];
  });
}

/**
 * Python probe. Exits 0 only when all three fixes are in effect AND every
 * safety property above holds; prints the offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES, not code paths:
 *
 *  - fix 1 drives the REAL registered MCP `recall` tool (FastMCP + the real
 *    `_register_recall`) with a fake engine emulating upstream's text-budget
 *    selection, and measures the tokens of the payload the tool RETURNS —
 *    both branches (bank_id-param string and single-bank dict);
 *  - fix 2 drives the REAL `_all_mental_models_are_usable_and_fresh` decision
 *    that gates the forced-retrieval release, across the measured relevance
 *    bands, the env knob, and the upstream stale/empty/vacuous contracts;
 *  - fix 3 asserts the resolved config default, upstream's env resolver
 *    (override + `none` sentinel), that all 7 reflect-scope LLM call sites in
 *    the shipping module pass the configured temperature (AST of the real
 *    module — 0/7 on upstream), and that the litellm provider forwards it.
 */
const PROBE = String.raw`
import asyncio
import json
import os
import sys

failures = []

# ------------------------------------------------------------------ fix 1
# MCP recall token budget: drive the REAL registered MCP tool with a fake
# engine that emulates upstream's TEXT-budget selection (sum of text tokens
# <= max_tokens), then measure the tokens of the payload the tool RETURNS.
from fastmcp import FastMCP

from hindsight_api import mcp_tools
from hindsight_api.engine.response_models import MemoryFact, RecallResult
from hindsight_api.engine.token_encoding import get_token_encoding

encoding = get_token_encoding()

BUDGET = 1500


def build_result():
    """Deterministic ranked results whose TEXT tokens fit the budget the way
    the engine's _filter_by_token_budget guarantees, but whose upstream wire
    envelope (indent=2 + nulls) is several times larger."""
    results = []
    total = 0
    i = 0
    while True:
        text = f"fact {i}: " + ("memory detail alpha beta gamma " * 4)
        t = len(encoding.encode(text))
        if total + t > BUDGET:
            break
        total += t
        results.append(MemoryFact(id=f"fact-{i:03d}", text=text, fact_type="world"))
        i += 1
    return RecallResult(results=results, trace={"query": "q", "num_results": len(results)})


TEXT_TOKENS = sum(len(encoding.encode(r.text)) for r in build_result().results)
print("TEXT_TOKENS", TEXT_TOKENS, "of budget", BUDGET)


class FakeMemory:
    async def recall_async(self, **kwargs):
        return build_result()


async def recall_fn(include_bank_id_param):
    mcp = FastMCP("probe-%s" % include_bank_id_param)
    cfg = mcp_tools.MCPToolsConfig(
        bank_id_resolver=lambda: "probe-bank",
        include_bank_id_param=include_bank_id_param,
    )
    mcp_tools._register_recall(mcp, FakeMemory(), cfg)
    tool = await mcp.get_tool("recall")
    return tool.fn


async def drive():
    fn = await recall_fn(True)
    payload = await fn(query="what do we know", max_tokens=BUDGET)
    assert isinstance(payload, str), type(payload)
    tokens = len(encoding.encode(payload))
    print("WIRE_TOKENS", tokens, "RATIO_VS_TEXT", round(tokens / TEXT_TOKENS, 2))
    if tokens > BUDGET:
        failures.append(
            "MCP recall returned %d tokens against max_tokens=%d - the budget costs "
            "only fact text, not the serialized payload" % (tokens, BUDGET)
        )
    parsed = json.loads(payload)
    ids = [r["id"] for r in parsed["results"]]
    prefix_ok = ids == ["fact-%03d" % i for i in range(len(ids))] and len(ids) > 0
    print("RANKED_PREFIX", prefix_ok, len(ids))
    if not prefix_ok:
        failures.append("trimmed results are not a non-empty ranked prefix: %r" % ids[:5])
    has_null = '": null' in payload or '":null' in payload
    has_indent = '\n  "' in payload
    print("NULLS_ON_WIRE", has_null, "INDENTED", has_indent)
    if has_null:
        failures.append("explicit nulls are still serialized onto the wire")
    if has_indent:
        failures.append("payload is still pretty-printed (indent=2)")

    # A generous budget must not trim: all results survive.
    full = build_result()
    payload8k = await fn(query="q", max_tokens=8192)
    n8k = len(json.loads(payload8k)["results"])
    print("GENEROUS_KEEPS_ALL", n8k, "of", len(full.results))
    if n8k != len(full.results):
        failures.append("a generous budget still trimmed results (%d of %d)" % (n8k, len(full.results)))

    # Rollback knob: legacy mode restores upstream's exact bytes.
    legacy_expected = build_result().model_dump_json(indent=2)
    os.environ["HINDSIGHT_MCP_RECALL_BUDGET_MODE"] = "legacy"
    try:
        legacy = await fn(query="q", max_tokens=BUDGET)
    finally:
        del os.environ["HINDSIGHT_MCP_RECALL_BUDGET_MODE"]
    legacy_ok = legacy == legacy_expected
    print("LEGACY_BYTES_MATCH", legacy_ok)
    if hasattr(mcp_tools, "_recall_payload_within_budget") and not legacy_ok:
        failures.append("HINDSIGHT_MCP_RECALL_BUDGET_MODE=legacy does not restore upstream bytes")

    # The single-bank (dict-returning) branch honours the same budget.
    fn2 = await recall_fn(False)
    d = await fn2(query="q", max_tokens=BUDGET)
    assert isinstance(d, dict), type(d)
    dict_tokens = len(encoding.encode(json.dumps(d, separators=(",", ":"))))
    print("DICT_BRANCH_TOKENS", dict_tokens)
    if dict_tokens > BUDGET:
        failures.append(
            "single-bank recall branch returned %d tokens against max_tokens=%d" % (dict_tokens, BUDGET)
        )


asyncio.run(drive())
# ------------------------------------------------------------------ fix 2
import ast
import inspect

import hindsight_api.engine.reflect.agent as agent

check = agent._all_mental_models_are_usable_and_fresh


def mm(rel, stale=False, content="Substantive synthesized content."):
    return {"is_stale": stale, "content": content, "relevance": rel}


def out(*ms):
    return {"mental_models": list(ms)}


# THE defect: a fresh-but-off-topic mental model (relevance 0.31, well inside
# the measured off-topic band) suppresses observation/recall retrieval.
r = check(out(mm(0.31)))
print("OFFTOPIC_FRESH_SUPPRESSES", r)
if r:
    failures.append(
        "an off-topic (relevance 0.31) fresh mental model still releases the forced "
        "search_observations/recall layers - retrieval is left to LLM discretion"
    )

# The 0.8.0 optimization must SURVIVE: a genuinely on-topic fresh set (measured
# on-topic band 0.75-0.81) still releases forcing.
r = check(out(mm(0.81), mm(0.75)))
print("ONTOPIC_FRESH_RELEASES", r)
if not r:
    failures.append(
        "a genuinely relevant fresh mental-model set no longer releases forced "
        "retrieval - the upstream short-circuit was destroyed, not gated"
    )

# A mixed set keeps the full forced path (ALL retrieved models must clear).
r = check(out(mm(0.81), mm(0.45)))
print("MIXED_SET_KEEPS_FORCING", not r)
if r:
    failures.append("a mixed relevant+off-topic fresh set still suppressed retrieval")

# Missing relevance is unsafe, same posture as missing staleness.
r = check(out({"is_stale": False, "content": "x"}))
print("MISSING_RELEVANCE_UNSAFE", not r)
if r:
    failures.append("a fresh model with NO relevance field still suppressed retrieval")

# Upstream rules stay intact: stale or empty-content models block regardless.
r_stale = check(out(mm(0.95, stale=True)))
r_empty = check(out(mm(0.95, content="   ")))
print("STALE_STILL_BLOCKS", not r_stale, "EMPTY_STILL_BLOCKS", not r_empty)
if r_stale:
    failures.append("a stale model no longer blocks the short-circuit")
if r_empty:
    failures.append("an empty-content model no longer blocks the short-circuit")

# No mental models at all: the caller separately requires a non-empty set, but
# the helper's vacuous-True contract must not change (upstream parity).
r = check(out())
print("EMPTY_SET_VACUOUS_TRUE", r)
if not r:
    failures.append("empty mental-model set changed the helper's vacuous-True contract")

# Operator knob: floor raised, floor disabled, bad values fall back.
def with_floor(value, o):
    if value is None:
        os.environ.pop("HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR", None)
    else:
        os.environ["HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR"] = value
    try:
        return check(o)
    finally:
        os.environ.pop("HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR", None)


if hasattr(agent, "_REFLECT_MM_RELEVANCE_FLOOR_DEFAULT"):
    print("FLOOR_DEFAULT", agent._REFLECT_MM_RELEVANCE_FLOOR_DEFAULT)
    if abs(agent._REFLECT_MM_RELEVANCE_FLOOR_DEFAULT - 0.55) > 1e-12:
        failures.append("relevance-floor default moved from the measured 0.55")
    raised = with_floor("0.9", out(mm(0.81)))
    disabled = with_floor("0", out(mm(0.05)))
    bad = with_floor("abc", out(mm(0.31)))
    print("FLOOR_RAISED_BLOCKS", not raised, "FLOOR_ZERO_DISABLES", disabled, "BAD_VALUE_FALLS_BACK", not bad)
    if raised:
        failures.append("HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR=0.9 did not raise the floor")
    if not disabled:
        failures.append("HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR=0 did not restore upstream gating - the rollback path is broken")
    if bad:
        failures.append("an unparseable floor value disabled the floor instead of falling back")
else:
    print("FLOOR_DEFAULT absent")
    failures.append("no _REFLECT_MM_RELEVANCE_FLOOR_DEFAULT - the relevance-floor patch is not applied")

# ------------------------------------------------------------------ fix 3
import hindsight_api.config as config

print("REFLECT_TEMP_DEFAULT", config.DEFAULT_LLM_TEMPERATURE_REFLECT)
if abs(config.DEFAULT_LLM_TEMPERATURE_REFLECT - 0.1) > 1e-12:
    failures.append(
        "DEFAULT_LLM_TEMPERATURE_REFLECT is %r, not 0.1 - factual synthesis keeps "
        "sampling at the provider default" % (config.DEFAULT_LLM_TEMPERATURE_REFLECT,)
    )

# Upstream's own resolver still honours the env overrides (per-op, global, omit).
def resolved(value):
    if value is None:
        os.environ.pop("HINDSIGHT_API_LLM_TEMPERATURE_REFLECT", None)
    else:
        os.environ["HINDSIGHT_API_LLM_TEMPERATURE_REFLECT"] = value
    try:
        return config._resolve_operation_temperature(
            config.ENV_LLM_TEMPERATURE_REFLECT, config.DEFAULT_LLM_TEMPERATURE_REFLECT
        )
    finally:
        os.environ.pop("HINDSIGHT_API_LLM_TEMPERATURE_REFLECT", None)


print("RESOLVED", resolved(None), resolved("0.3"), resolved("none"))
if resolved(None) != config.DEFAULT_LLM_TEMPERATURE_REFLECT:
    failures.append("env-unset reflect temperature does not resolve to the default")
if resolved("0.3") != 0.3:
    failures.append("HINDSIGHT_API_LLM_TEMPERATURE_REFLECT=0.3 is not honoured")
if resolved("none") is not None:
    failures.append("the documented 'none' omit-sentinel no longer resolves to None")

# The knob must be LIVE on the agentic path: every reflect-scope LLM call site
# in agent.py (call + the call_with_tools kwargs dict) passes the configured
# reflect temperature. Parsed from the AST of the REAL shipping module.
tree = ast.parse(inspect.getsource(agent))
sites = []


class V(ast.NodeVisitor):
    def visit_Call(self, node):
        scope = None
        temp_src = None
        for kw in node.keywords:
            if kw.arg == "scope" and isinstance(kw.value, ast.Constant):
                scope = kw.value.value
            if kw.arg == "temperature":
                temp_src = ast.unparse(kw.value)
        if scope in ("reflect", "reflect_tool_call"):
            sites.append((scope, temp_src))
        self.generic_visit(node)


V().visit(tree)
n_total = len(sites)
n_wired = sum(1 for _, t in sites if t is not None and "llm_temperature_reflect" in t)
print("REFLECT_CALL_SITES", n_total, "WIRED", n_wired)
if n_total != 7:
    failures.append(
        "expected 7 reflect-scope LLM call sites in engine/reflect/agent.py, found %d - "
        "re-audit the temperature threading" % n_total
    )
if n_wired != n_total:
    failures.append(
        "only %d of %d reflect-scope LLM call sites pass the configured reflect "
        "temperature - the knob is (still) dead on the agentic path" % (n_wired, n_total)
    )

# Chain evidence (green on both runs): the litellm provider forwards a non-None
# temperature into the request kwargs and omits it when None.
from hindsight_api.engine.providers.litellm_llm import LiteLLMLLM

llm = LiteLLMLLM(
    provider="openai", api_key="unused", base_url="http://127.0.0.1:1",
    model="gpt-4o-mini", timeout=1,
)
kw_with = llm._build_common_kwargs([{"role": "user", "content": "x"}], temperature=0.1)
kw_without = llm._build_common_kwargs([{"role": "user", "content": "x"}])
print("PROVIDER_FORWARDS", kw_with.get("temperature"), "OMITS_WHEN_NONE", "temperature" not in kw_without)
if kw_with.get("temperature") != 0.1:
    failures.append("litellm provider does not forward an explicit temperature")
if "temperature" in kw_without:
    failures.append("litellm provider invents a temperature when none is passed")

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
  const name = `sr-hs-grounding-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        // Each block is self-verifying: it asserts its upstream anchors exist
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

describe("Dockerfile.hindsight recall-budget/reflect-grounding probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the three patch blocks it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(3);
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
  "Dockerfile.hindsight recall-budget/reflect-grounding patches change real behaviour",
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

    it("unpatched upstream is RED on all three defects (proves the probe bites)", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // Defect 1 — measured on the driven tool: 1500 tokens of fact text
      // become ~7.6k tokens on the wire (indent + nulls, both observed).
      expect(stdout).toMatch(/WIRE_TOKENS 7\d{3} /);
      expect(stdout).toContain(
        "the budget costs only fact text, not the serialized payload",
      );
      expect(stdout).toContain("NULLS_ON_WIRE True INDENTED True");
      expect(stdout).toMatch(
        /single-bank recall branch returned \d+ tokens against max_tokens=1500/,
      );

      // Defect 2 — the off-topic fresh model releases forced retrieval.
      expect(stdout).toContain("OFFTOPIC_FRESH_SUPPRESSES True");
      expect(stdout).toContain("FLOOR_DEFAULT absent");
      expect(stdout).toContain(
        "retrieval is left to LLM discretion",
      );

      // Defect 3 — the knob resolves to 0.9 and reaches zero call sites.
      expect(stdout).toContain("REFLECT_TEMP_DEFAULT 0.9");
      expect(stdout).toContain("REFLECT_CALL_SITES 7 WIRED 0");
      expect(stdout).toContain(
        "the knob is (still) dead on the agentic path",
      );

      // Upstream contracts the patches must NOT break are already green here,
      // so the RED runs prove the probe distinguishes defect from contract.
      expect(stdout).toContain("ONTOPIC_FRESH_RELEASES True");
      expect(stdout).toContain("STALE_STILL_BLOCKS True EMPTY_STILL_BLOCKS True");
      expect(stdout).toContain("EMPTY_SET_VACUOUS_TRUE True");
      expect(stdout).toContain("GENEROUS_KEEPS_ALL 60 of 60");
      expect(stdout).toContain("LEGACY_BYTES_MATCH True");
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN, including every safety property", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // Fix 1: the wire payload now fits the requested budget (1497 <= 1500
      // measured), results are a non-empty ranked prefix, serialization is
      // compact with no nulls, a generous budget trims nothing, and the
      // legacy env restores upstream's exact bytes.
      expect(stdout).toMatch(/WIRE_TOKENS (1[0-4]\d\d|1500) /);
      expect(stdout).toMatch(/RANKED_PREFIX True \d+/);
      expect(stdout).toContain("NULLS_ON_WIRE False INDENTED False");
      expect(stdout).toContain("GENEROUS_KEEPS_ALL 60 of 60");
      expect(stdout).toContain("LEGACY_BYTES_MATCH True");
      expect(stdout).not.toMatch(/DICT_BRANCH_TOKENS (1[5-9]\d\d|[2-9]\d{3,})/);

      // Fix 2: relevance now gates the short-circuit — off-topic/mixed/missing
      // relevance keep the forced path; on-topic fresh sets still release it;
      // the knob raises, disables, and survives bad values.
      expect(stdout).toContain("OFFTOPIC_FRESH_SUPPRESSES False");
      expect(stdout).toContain("ONTOPIC_FRESH_RELEASES True");
      expect(stdout).toContain("MIXED_SET_KEEPS_FORCING True");
      expect(stdout).toContain("MISSING_RELEVANCE_UNSAFE True");
      expect(stdout).toContain("STALE_STILL_BLOCKS True EMPTY_STILL_BLOCKS True");
      expect(stdout).toContain("EMPTY_SET_VACUOUS_TRUE True");
      expect(stdout).toContain("FLOOR_DEFAULT 0.55");
      expect(stdout).toContain(
        "FLOOR_RAISED_BLOCKS True FLOOR_ZERO_DISABLES True BAD_VALUE_FALLS_BACK True",
      );

      // Fix 3: the default is 0.1, the env resolver still honours overrides
      // and the `none` sentinel, all 7 agentic call sites pass the configured
      // temperature, and the provider forwards/omits correctly.
      expect(stdout).toContain("REFLECT_TEMP_DEFAULT 0.1");
      expect(stdout).toContain("RESOLVED 0.1 0.3 None");
      expect(stdout).toContain("REFLECT_CALL_SITES 7 WIRED 7");
      expect(stdout).toContain("PROVIDER_FORWARDS 0.1 OMITS_WHEN_NONE True");
    }, 240_000);
  },
);
