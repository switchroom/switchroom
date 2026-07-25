/**
 * Behavioural proof for the two search/provider patches
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image. `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch
 * blocks (grep-on-file, runs everywhere). This file proves the *outcome*: it
 * runs the same probe against unpatched upstream (must be RED on every bug)
 * and against upstream + the patch blocks applied (must be GREEN).
 *
 * The two defects, both reproduced live on bank `overlord` before the fix:
 *
 *  1. `tokenize_query` shredded `v0.19.17` into `v0`/`19`/`17`, while
 *     `to_tsvector` indexes it as ONE lexeme — zero overlap on the only
 *     discriminating term, and the stripped `19` then matched clock
 *     timestamps like `19:33:13`.
 *  2. Both LiteLLM timeout handlers ended in a bare `raise`, re-raising an
 *     `asyncio.TimeoutError` whose `str()` is empty → an operator-facing
 *     "TimeoutError:" with no cause.
 *
 * (A third patch — damping the ranking boost product — was deliberately split
 * out of this PR. It is a calibration change rather than a defect fix, so it
 * ships separately with its own probe coverage in order to stay independently
 * revertible. Nothing here depends on it.)
 *
 * Beyond proving those two fixes, the probe pins the property that makes the
 * BM25 change SAFE, because an earlier revision of this work violated it and
 * it is not visible from the patch text alone:
 *
 *  - `tokenize_query` stays a STRICT SUPERSET of upstream's token list, so the
 *    OR-joined query can only match more documents than upstream, never fewer.
 *    A document that never enters the BM25 candidate set can never be reranked
 *    back in, so a recall loss there is unrecoverable downstream.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE (this used to be the weak point — the suite reported green
 * on every CI run because the pinned upstream image is never present on a
 * hosted runner, so the only behavioural evidence for a ranking change
 * affecting 12 live agents silently skipped). Now:
 *
 *   - Locally, with no docker or no cached image, it still skips — it must not
 *     pull a 6.4GB third-party image onto a dev box.
 *   - In CI, `.github/workflows/docker-e2e.yml` has a dedicated
 *     `hindsight-probe` job that PULLS THE PINNED DIGEST and sets
 *     `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1`. Under that marker an
 *     unavailable docker/image is a HARD FAILURE, never a green skip.
 *   - Both probe runs assert a `PROBE_EXECUTED` sentinel, so a probe that
 *     dies early or short-circuits can never be mistaken for a pass.
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
const TEST_PHASE = "hindsight-search-patches";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The two patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' … PYEOF` heredocs by their unique patch names.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const wanted = [
    "BM25 compound-token patch",
    "timeout-message patch",
  ];
  return wanted.map((name) => {
    const b = blocks.find((x) => x.includes(name));
    if (!b) {
      throw new Error(
        `Dockerfile.hindsight no longer contains the "${name}" RUN block — ` +
          `if it was deliberately removed, delete this test with it.`,
      );
    }
    return b;
  });
}

/**
 * Python probe. Exits 0 only when both fixes are in effect AND every
 * safety property above holds; prints the offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES rather than merely calling the code or
 * grepping its source. Concretely, this file asserts:
 *
 *  - the token list `tokenize_query` returns, and that it stays a strict
 *    superset of upstream's across 8 query shapes;
 *  - the exact tsquery string `prepare_bm25_text` emits — that the intact
 *    compound is present, that every bare fragment upstream emitted survives
 *    as a standalone OR arm, and that a non-compound query is byte-identical
 *    to upstream;
 *  - two REAL driven timeouts — a hanging completion forced through both
 *    LiteLLM retry loops — checked for the timeout/scope facts in the message
 *    and for still being caught by an upstack `except asyncio.TimeoutError`.
 *
 * It asserts nothing about how results are finally ordered. The ranking patch
 * was split into its own PR and its ordering/scoring-safety probes went with
 * it. The test below enforces that this paragraph stays true.
 */
const PROBE = String.raw`
import asyncio
import re
import sys

from hindsight_api.engine.search.retrieval import tokenize_query
from hindsight_api.engine.sql import create_sql_dialect

failures = []


# ------------------------------------------------------------------ fix 2
dialect = create_sql_dialect("postgresql")

toks = tokenize_query("rollout v0.19.17")
print("TOKENS", toks)
if "v0.19.17" not in toks:
    failures.append("tokenize_query destroyed the intact version token")

tsq = dialect.prepare_bm25_text(toks, "rollout v0.19.17")
print("TSQUERY", tsq)

# STRICT SUPERSET. Every token upstream emitted must still be emitted, in
# order, so the OR-joined query can only ever match MORE documents than
# upstream - never fewer. This is the entire safety argument for touching a
# shared BM25 candidate-generation arm under 12 live agents.
SUPERSET_CASES = [
    "rollout v0.19.17", "2026-07-25", "state-of-the-art", "github.com/foo/bar",
    "hello world", "2026-07-25 at 19:33:13", "19 v0.19.17", "...",
]
superset_ok = True
for q in SUPERSET_CASES:
    upstream_tokens = re.sub(r"[^\w\s]", " ", q.lower()).split()
    got = tokenize_query(q)
    if got[: len(upstream_tokens)] != upstream_tokens:
        failures.append("tokenize_query is no longer a strict superset of upstream for %r: %r vs %r" % (q, upstream_tokens, got))
        superset_ok = False
        break
print("SUPERSET_OK", superset_ok)

# NON-SEMVER COMPOUNDS. to_tsvector does NOT index every compound as a single
# lexeme - postgres 16 expands state-of-the-art into a PHRASE query and indexes
# 2026 standalone in "shipped in 2026 during july". So every bare fragment must
# remain a standalone OR arm. An earlier revision emitted only
# "compound | (f1 & f2 & ...)", which stopped a query containing 2026-07-25
# matching a doc that mentions only the year, and stopped state-of-the-art
# matching a doc about art. Every fact in these banks carries a date stamp, so
# that is the common path, not a corner case.
for q, frags in (("2026-07-25", ["2026", "07", "25"]), ("state-of-the-art", ["state", "of", "the", "art"])):
    emitted = dialect.prepare_bm25_text(tokenize_query(q), q)
    arms = [p.strip() for p in emitted.split("|")]
    print("COMPOUND_TSQUERY", q, repr(emitted))
    missing = [f for f in frags if f not in arms]
    if missing:
        failures.append("bare fragments %r no longer standalone OR arms for %r - narrows matching vs upstream" % (missing, q))
    if q not in emitted:
        failures.append("intact compound %r missing from the tsquery" % q)

plain = dialect.prepare_bm25_text(tokenize_query("hello world"), "hello world")
print("PLAIN", plain)
if plain != "hello | world":
    failures.append("plain query changed shape: " + repr(plain))

# ------------------------------------------------------------------ fix 3
# Behavioural, not a grep: drive a REAL timeout through both retry loops and
# assert the raised exception carries a message and is still caught by an
# upstack "except asyncio.TimeoutError".
from hindsight_api.engine.providers.litellm_llm import LiteLLMLLM


class _HangingLLM(LiteLLMLLM):
    async def _acompletion(self, **kwargs):
        await asyncio.sleep(30)


async def _drive_timeouts():
    llm = _HangingLLM(
        provider="openai", api_key="unused", base_url="http://127.0.0.1:1",
        model="gpt-4o-mini", timeout=0.05,
    )
    out = {}
    calls = {
        "call": lambda: llm.call([{"role": "user", "content": "hi"}], max_retries=0, initial_backoff=0.0),
        "call_with_tools": lambda: llm.call_with_tools([{"role": "user", "content": "hi"}], [], max_retries=0, initial_backoff=0.0),
    }
    for label, make in calls.items():
        try:
            await make()
            out[label] = ("NO_RAISE", "")
        except asyncio.TimeoutError as e:
            # Reaching this handler at all proves the upstack matcher still
            # works after the patch swaps the re-raised exception object.
            out[label] = ("CAUGHT_BY_ASYNCIO_TIMEOUTERROR", str(e))
        except BaseException as e:
            out[label] = ("WRONG_TYPE:" + type(e).__name__, str(e))
    return out


timeouts = asyncio.run(_drive_timeouts())
for label, (how, msg) in sorted(timeouts.items()):
    print("TIMEOUT", label, how, repr(msg))
    if how != "CAUGHT_BY_ASYNCIO_TIMEOUTERROR":
        failures.append("%s timeout no longer caught by an upstack asyncio.TimeoutError handler (%s)" % (label, how))
    elif not msg.strip():
        failures.append("%s timeout raised an EMPTY message - operators see a bare TimeoutError with no cause" % label)
    elif "timed out after" not in msg or "scope=" not in msg:
        failures.append("%s timeout message lost the timeout/scope facts: %r" % (label, msg))

print("FAILURES", failures)
# Sentinel: proves the probe ran to completion. The harness asserts this, so a
# probe that dies early or short-circuits can never be mistaken for a pass.
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
  const name = `sr-hs-probe-${patched ? "patched" : "upstream"}-${RUN_ID.slice(0, 8)}`;
  try {
    execFileSync(
      "docker",
      [
        "run", "-d",
        "--name", name,
        "--label", `switchroom.test=${TEST_PHASE}`,
        "--label", `switchroom.test.run=${RUN_ID}`,
        "--user", "root",
        "--network", "none",
        UPSTREAM_IMAGE,
        "sleep", "300",
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

describe("Dockerfile.hindsight search-patch probe is real, not a silent skip", () => {
  it("header's rank-order claim matches what the probe actually checks", () => {
    // This header went stale once already: after the ranking patch was split
    // into its own PR it still advertised "final rank order" while no
    // rank-order assertion remained anywhere in the file. Because this file
    // moves between branches with and without that patch, the claim can drift
    // in EITHER direction, so assert both. A prose claim cannot be trusted to
    // stay true by discipline — tie it to the probe source mechanically.
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const header = src.slice(0, src.indexOf("const PROBE ="));
    const probeChecksRankOrder = /SATURATED_ORDER|combined_score/.test(PROBE);
    const headerClaimsRankOrder = /rank\s+order/i.test(header);
    expect(
      headerClaimsRankOrder,
      probeChecksRankOrder
        ? "the probe asserts final rank order but the header does not say so — " +
          "understated coverage hides the file's most important guarantee"
        : "the header advertises rank-order coverage but the probe asserts " +
          "nothing about rank order — describe what this file actually checks",
    ).toBe(probeChecksRankOrder);
  });

  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
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
  "Dockerfile.hindsight search patches change real behaviour",
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

    it(
      "unpatched upstream is RED on both defects (proves the probe bites)",
      () => {
        const { status, stdout } = runProbe(false);
        expect(stdout, "probe did not run to completion").toContain("PROBE_EXECUTED");
        expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

        // Defect 2 — the intact compound never reaches the tsquery.
        expect(stdout).toContain("tokenize_query destroyed the intact version token");
        expect(stdout).toContain("TOKENS ['rollout', 'v0', '19', '17']");
        expect(stdout).toContain("TSQUERY rollout | v0 | 19 | 17");
        expect(stdout).toContain("intact compound '2026-07-25' missing from the tsquery");

        // Defect 3 — driven for real: both timeout paths raise an EMPTY message.
        expect(stdout).toContain(
          "call timeout raised an EMPTY message",
        );
        expect(stdout).toContain(
          "call_with_tools timeout raised an EMPTY message",
        );
        expect(stdout).toMatch(/TIMEOUT call CAUGHT_BY_ASYNCIO_TIMEOUTERROR ''/);
        expect(stdout).toMatch(
          /TIMEOUT call_with_tools CAUGHT_BY_ASYNCIO_TIMEOUTERROR ''/,
        );
      },
      240_000,
    );

    it(
      "upstream + the baked patch blocks is GREEN, including every safety property",
      () => {
        const { status, stdout } = runProbe(true);
        expect(stdout, "probe did not run to completion").toContain("PROBE_EXECUTED");
        expect(status, `probe failed:\n${stdout}`).toBe(0);
        expect(stdout).toContain("FAILURES []");

        // Fix 2: the intact compound is APPENDED, never substituted — the
        // fragments upstream emitted all survive as standalone OR arms, so the
        // query can only match more documents than upstream, never fewer.
        expect(stdout).toContain("TOKENS ['rollout', 'v0', '19', '17', 'v0.19.17']");
        expect(stdout).toContain("TSQUERY rollout | v0 | 19 | 17 | v0.19.17");
        expect(stdout).toContain("SUPERSET_OK True");
        expect(stdout).toContain(
          "COMPOUND_TSQUERY 2026-07-25 '2026 | 07 | 25 | 2026-07-25'",
        );
        expect(stdout).toContain(
          "COMPOUND_TSQUERY state-of-the-art 'state | of | the | art | state-of-the-art'",
        );
        // Non-compound queries are byte-identical to upstream.
        expect(stdout).toContain("PLAIN hello | world");

        // Fix 3: both driven timeouts now carry the timeout/attempts/scope
        // facts AND are still caught by an upstack asyncio.TimeoutError.
        expect(stdout).toMatch(
          /TIMEOUT call CAUGHT_BY_ASYNCIO_TIMEOUTERROR 'LiteLLM call timed out after 0\.05s on 1 attempts \(TimeoutError, scope=memory\)'/,
        );
        expect(stdout).toMatch(
          /TIMEOUT call_with_tools CAUGHT_BY_ASYNCIO_TIMEOUTERROR 'LiteLLM tool call timed out after 0\.05s on 1 attempts \(TimeoutError, scope=tools\)'/,
        );
      },
      240_000,
    );
  },
);
