/**
 * Behavioural proof for the two recall-budget / reflect-grounding patches
 * that `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image. `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch
 * blocks (grep-on-file, runs everywhere). This file proves the *outcome*: it
 * runs the same probe against unpatched upstream (must be RED on every defect)
 * and against upstream + the patch blocks applied (must be GREEN).
 *
 * The two defects, both verified live on this fleet before the fix:
 *
 *  1. MCP recall's `max_tokens` was a dishonest budget. The engine's
 *     `_filter_by_token_budget` costs only fact TEXT, but the MCP tool then
 *     serialized with `model_dump_json(indent=2)` and explicit nulls —
 *     measured live, 6,079 bytes of fact text became 40,857 bytes on the wire
 *     (6.7x), so `max_tokens: 1500` delivered ~3.5k tokens.
 *  2. Reflect's temperature knob was dead. `DEFAULT_LLM_TEMPERATURE_REFLECT`
 *     (0.9) was resolved into config but NO agentic call site passed
 *     `temperature`, and the litellm provider omits the kwarg when None — so
 *     the provider default (~1.0) applied to factual synthesis.
 *
 * A THIRD defect (E-86) lives inside fix 1's own trim loop and is asserted
 * within the `hasattr(mcp_tools, "_recall_payload_within_budget")` guard
 * below (patched-only, no upstream analogue): the tail-trim loop that fix 1
 * introduced had no floor on the caller's `max_tokens`, so a small enough
 * value (empirically ~50-200 tokens, live-reproduced at `max_tokens: 50`)
 * popped EVERY ranked result and returned a structurally valid, silently
 * empty `{"results": []}` — indistinguishable from "the bank has nothing
 * relevant". The fix mirrors `create_mental_model`'s existing
 * `256 <= max_tokens <= 8192` floor (`mcp_tools.py:1345-1346`): clamp
 * `max_tokens` up to `_MCP_RECALL_MIN_MAX_TOKENS` (256) before budgeting, and
 * stamp `truncated: true` / `dropped_count: N` on any payload the trim loop
 * actually shortened, so a trimmed result can never be mistaken for "no
 * memories".
 *
 * (A third patch — a relevance gate on the reflect mental-model
 * short-circuit — was authored and then dropped from this PR: re-probing the
 * live bank showed every mental model on the reported failing query scored
 * above the gate's threshold, so it did not fix the reported defect, and
 * `budget: "high"` already bypasses the short-circuit with no patch at all.)
 *
 * Beyond proving the fixes, the probe pins the properties that make them
 * SAFE, none of which is visible from the patch text alone:
 *
 *  - The honest budget lives in the MCP layer ONLY. The per-turn auto-recall
 *    hook injects only fact text, so trimmed results stay a non-empty ranked
 *    prefix, a generous budget trims nothing, and
 *    `HINDSIGHT_MCP_RECALL_BUDGET_MODE=legacy` restores upstream's exact
 *    bytes (the restart-level rollback).
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
 * Python probe. Exits 0 only when both fixes are in effect AND every
 * safety property above holds; prints the offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES, not code paths:
 *
 *  - fix 1 drives the REAL registered MCP `recall` tool (FastMCP + the real
 *    `_register_recall`) with a fake engine emulating upstream's text-budget
 *    selection, and measures the tokens of the payload the tool RETURNS —
 *    both branches (bank_id-param string and single-bank dict);
 *  - fix 2 asserts the resolved config default, upstream's env resolver
 *    (override + `none` sentinel), that all 6 reflect-scope LLM call sites in
 *    the shipping module pass the configured temperature (AST of the real
 *    module — 0/6 on upstream), and that the litellm provider forwards it.
 *
 * v0.8.6 RE-ANCHORING (upstream #3013). The reflect rework DELETED the mid-loop
 * budget-rewrite call site that used to sit at 24-space indent, so the site
 * count dropped from 7 to 6 (5x scope="reflect" + the reflect_tool_call kwargs).
 * The count is asserted EXACTLY rather than as a floor: a site added upstream
 * and left at the provider default is the exact failure this probe exists to
 * catch, and ">= 6" would not catch it.
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

    # The patched-only contracts below have no upstream analogue (upstream has
    # no trim and no mode knob), so they are guarded on the helper's presence —
    # the upstream run stays RED on the budget defects above, never on these.
    if hasattr(mcp_tools, "_recall_payload_within_budget"):
        # Trim pruning must key source_facts on SOURCE FACT ids. The engine
        # keys source_facts by source fact id (response_models: "keyed by
        # fact ID"), referenced from observation results via source_fact_ids
        # - a DISJOINT id space from result ids. Keying the keep-set on result
        # ids deletes the source facts of RETAINED observations.
        def build_obs_result():
            results = []
            total = 0
            i = 0
            while True:
                text = "obs %03d: " % i + ("memory detail alpha beta gamma " * 4)
                t = len(encoding.encode(text))
                if total + t > BUDGET:
                    break
                total += t
                results.append(
                    MemoryFact(
                        id="obs-%03d" % i,
                        text=text,
                        fact_type="observation",
                        source_fact_ids=["src-%03d-a" % i, "src-%03d-b" % i],
                    )
                )
                i += 1
            source_facts = {
                fid: MemoryFact(id=fid, text="source detail for " + fid, fact_type="world")
                for r in results
                for fid in r.source_fact_ids
            }
            return RecallResult(results=results, trace={"query": "q"}, source_facts=source_facts)

        obs = build_obs_result()
        n_full = len(obs.results)
        trimmed = json.loads(mcp_tools._recall_payload_within_budget(obs, BUDGET))
        kept = trimmed["results"]
        print("SOURCE_FACT_TRIM", len(kept), "of", n_full)
        if not (0 < len(kept) < n_full):
            failures.append(
                "source-fact probe did not exercise the trim path (%d of %d kept) - "
                "the keying assertion below would be vacuous" % (len(kept), n_full)
            )
        kept_src_ids = {fid for r in kept for fid in (r.get("source_fact_ids") or [])}
        surviving = set(trimmed.get("source_facts") or {})
        missing = sorted(kept_src_ids - surviving)
        stale = sorted(surviving - kept_src_ids)
        print("SOURCE_FACTS_OF_RETAINED_SURVIVE", not missing, "OF_DROPPED_PRUNED", not stale)
        if missing:
            failures.append(
                "trim deleted the source facts of RETAINED observations: %r - the "
                "keep-set is keyed on result ids, not source_fact_ids" % missing[:4]
            )
        if stale:
            failures.append(
                "trim kept the source facts of DROPPED observations: %r" % stale[:4]
            )

        # Legacy on the single-bank branch must be upstream's exact return
        # VALUE - model_dump() python objects - not a JSON round-trip of it.
        # trace is dict[str, Any]; a datetime or tuple in it round-trips to
        # a string or list, which upstream's caller never saw.
        import datetime

        def build_traced_result():
            r = build_result()
            r.trace = {"took": datetime.datetime(2026, 1, 14, 0, 0), "shape": (1, 2)}
            return r

        os.environ["HINDSIGHT_MCP_RECALL_BUDGET_MODE"] = "legacy"
        try:
            class TracedMemory:
                async def recall_async(self, **kwargs):
                    return build_traced_result()

            mcp3 = FastMCP("probe-legacy-dict")
            cfg3 = mcp_tools.MCPToolsConfig(
                bank_id_resolver=lambda: "probe-bank",
                include_bank_id_param=False,
            )
            mcp_tools._register_recall(mcp3, TracedMemory(), cfg3)
            fn3 = (await mcp3.get_tool("recall")).fn
            legacy_dict = await fn3(query="q", max_tokens=BUDGET)
        finally:
            del os.environ["HINDSIGHT_MCP_RECALL_BUDGET_MODE"]
        expected_dict = build_traced_result().model_dump()
        dict_ok = legacy_dict == expected_dict
        print("LEGACY_DICT_IS_MODEL_DUMP", dict_ok)
        if not dict_ok:
            failures.append(
                "legacy mode on the single-bank branch does not return upstream's exact "
                "model_dump() - python objects in trace were coerced through JSON"
            )

        # ---------------------------------------------------------- E-86
        # Live reproduction (2026-08-17 root-cause pass): identical
        # query/bank/budget via MCP recall(budget="low", max_tokens=50)
        # returned {"results": []} while direct HTTP against the same engine
        # state returned 2 ranked hits - a silent, structurally-valid empty
        # indistinguishable from "the bank has nothing relevant". The MCP
        # tail-trim loop had no floor on max_tokens, so a small enough value
        # popped every ranked result. This must not be reproducible: either
        # the floor keeps a non-empty ranked prefix, or (if a single result
        # alone still can't fit) the drop is loud (truncated/dropped_count),
        # never a bare silent {"results": []}.
        E86_MAX_TOKENS = 50  # the exact value that crashed to zero live
        e86 = await fn(query="what do we know", budget="low", max_tokens=E86_MAX_TOKENS)
        e86_parsed = json.loads(e86)
        e86_results = e86_parsed.get("results", [])
        e86_silent_empty = len(e86_results) == 0 and "truncated" not in e86_parsed
        print(
            "E86_RESULTS",
            len(e86_results),
            "TRUNCATED",
            e86_parsed.get("truncated"),
            "DROPPED_COUNT",
            e86_parsed.get("dropped_count"),
            "SILENT_EMPTY",
            e86_silent_empty,
        )
        if e86_silent_empty:
            failures.append(
                "E-86: recall(budget='low', max_tokens=%d) against a bank with real "
                "hits returned a silent empty {'results': []} - no truncation marker, "
                "indistinguishable from 'nothing matched'" % E86_MAX_TOKENS
            )
        # The floor itself: a query known to have hits must come back non-empty
        # at ANY caller-supplied max_tokens, however small - the crater case
        # this patch exists to close outright.
        for tiny in (1, 10, 50, 200):
            e86_floor = await fn(query="what do we know", budget="low", max_tokens=tiny)
            n = len(json.loads(e86_floor).get("results", []))
            print("E86_FLOOR_MAX_TOKENS", tiny, "RESULTS", n)
            if n == 0:
                failures.append(
                    "E-86: recall(max_tokens=%d) against a bank with real hits still "
                    "craters to zero results - the max_tokens floor is not effective"
                    % tiny
                )

        # A single result too large to fit even after flooring must still be
        # loud (truncated marker), not a silent empty - the residual case the
        # floor alone cannot close.
        def build_oversized_single_result():
            huge_text = "one huge fact: " + ("detail " * 400)  # far > any floor
            return RecallResult(
                results=[MemoryFact(id="huge-0", text=huge_text, fact_type="world")],
                trace={"query": "q"},
            )

        class OversizedMemory:
            async def recall_async(self, **kwargs):
                return build_oversized_single_result()

        mcp4 = FastMCP("probe-e86-oversized")
        cfg4 = mcp_tools.MCPToolsConfig(
            bank_id_resolver=lambda: "probe-bank",
            include_bank_id_param=True,
        )
        mcp_tools._register_recall(mcp4, OversizedMemory(), cfg4)
        fn4 = (await mcp4.get_tool("recall")).fn
        oversized = await fn4(query="q", max_tokens=mcp_tools._MCP_RECALL_MIN_MAX_TOKENS)
        oversized_parsed = json.loads(oversized)
        print(
            "E86_OVERSIZED_RESULTS",
            len(oversized_parsed.get("results", [])),
            "TRUNCATED",
            oversized_parsed.get("truncated"),
            "DROPPED_COUNT",
            oversized_parsed.get("dropped_count"),
        )
        if len(oversized_parsed.get("results", [])) == 0 and not oversized_parsed.get("truncated"):
            failures.append(
                "E-86: an oversized single result trimmed to zero without a "
                "truncated/dropped_count marker - silent empty, not loud"
            )


asyncio.run(drive())
# ------------------------------------------------------------------ fix 2
import ast
import inspect

import hindsight_api.engine.reflect.agent as agent
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
if n_total != 6:
    failures.append(
        "expected 6 reflect-scope LLM call sites in engine/reflect/agent.py, found %d - "
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
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-grounding-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
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
        // Each block is self-verifying: it asserts its upstream anchors exist
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

describe("Dockerfile.hindsight recall-budget/reflect-grounding probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the two patch blocks it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(2);
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

    it("unpatched upstream is RED on both defects (proves the probe bites)", async () => {
      const { status, stdout } = await runProbe(false);
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

      // Defect 2 — the knob resolves to 0.9 and reaches zero call sites.
      expect(stdout).toContain("REFLECT_TEMP_DEFAULT 0.9");
      expect(stdout).toContain("REFLECT_CALL_SITES 6 WIRED 0");
      expect(stdout).toContain(
        "the knob is (still) dead on the agentic path",
      );

      // Upstream contracts the patches must NOT break are already green here,
      // so the RED runs prove the probe distinguishes defect from contract.
      expect(stdout).toContain("GENEROUS_KEEPS_ALL 60 of 60");
      expect(stdout).toContain("LEGACY_BYTES_MATCH True");
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN, including every safety property", async () => {
      const { status, stdout } = await runProbe(true);
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

      // Fix 2: the default is 0.1, the env resolver still honours overrides
      // and the `none` sentinel, all 7 agentic call sites pass the configured
      // temperature, and the provider forwards/omits correctly.
      expect(stdout).toContain("REFLECT_TEMP_DEFAULT 0.1");
      expect(stdout).toContain("RESOLVED 0.1 0.3 None");
      expect(stdout).toContain("REFLECT_CALL_SITES 6 WIRED 6");
      expect(stdout).toContain("PROVIDER_FORWARDS 0.1 OMITS_WHEN_NONE True");

      // Fix 3 (E-86): the exact live-reproduced footgun — budget:"low" +
      // max_tokens:50 against a bank with real hits — must never come back
      // as a silent empty; the max_tokens floor must hold at every tiny
      // value; and a single oversized result must still be loud, not silent.
      expect(stdout).toContain("SILENT_EMPTY False");
      expect(stdout).toMatch(/E86_FLOOR_MAX_TOKENS 1 RESULTS [1-9]\d*/);
      expect(stdout).toMatch(/E86_FLOOR_MAX_TOKENS 10 RESULTS [1-9]\d*/);
      expect(stdout).toMatch(/E86_FLOOR_MAX_TOKENS 50 RESULTS [1-9]\d*/);
      expect(stdout).toMatch(/E86_FLOOR_MAX_TOKENS 200 RESULTS [1-9]\d*/);
      expect(stdout).toMatch(/E86_OVERSIZED_RESULTS 0 TRUNCATED True DROPPED_COUNT 1/);
    }, 240_000);
  },
);
