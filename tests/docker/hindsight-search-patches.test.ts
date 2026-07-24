/**
 * Behavioural proof for the three search/provider patches
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image. `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch
 * blocks (grep-on-file, runs everywhere). This file proves the *outcome*: it
 * runs the same probe against unpatched upstream (must be RED on every bug)
 * and against upstream + the patch blocks applied (must be GREEN).
 *
 * The three defects, all reproduced live on bank `overlord` before the fix:
 *
 *  1. Cross-encoder saturation. `apply_combined_scoring` makes
 *     `CE * recency_boost * temporal_boost * proof_count_boost` the only final
 *     score (RRF is explicitly zeroed). A 116-result recall had every CE score
 *     inside 0.9800-0.9999, so the ±5% proof_count boost decided the order and
 *     the single highest-CE memory ranked 7th behind older, more-proven ones.
 *  2. `tokenize_query` shredded `v0.19.17` into `v0`/`19`/`17`, while
 *     `to_tsvector` indexes it as ONE lexeme — zero overlap on the only
 *     discriminating term, and the stripped `19` then matched clock
 *     timestamps like `19:33:13`.
 *  3. Both LiteLLM timeout handlers ended in a bare `raise`, re-raising an
 *     `asyncio.TimeoutError` whose `str()` is empty → `TimeoutError: ` with no
 *     cause on the operator-facing surface.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * Skips (green) when docker is unavailable or the pinned upstream image is not
 * already present locally — it deliberately never pulls a multi-GB third-party
 * image. CI is the authority for suites it can run; this one is host-local.
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
 * The three patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' … PYEOF` heredocs by their unique patch names.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const wanted = [
    "CE-saturation patch",
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
 * Python probe. Exits 0 only when all three fixes are in effect; prints the
 * offending assertions otherwise. Deliberately asserts OUTCOMES (final rank
 * order, the emitted tsquery string) rather than merely calling the code.
 */
const PROBE = String.raw`
import sys
from datetime import datetime, timedelta, timezone

from hindsight_api.engine.search.reranking import apply_combined_scoring
from hindsight_api.engine.search.retrieval import tokenize_query
from hindsight_api.engine.search.types import MergedCandidate, RetrievalResult, ScoredResult
from hindsight_api.engine.sql import create_sql_dialect

failures = []
UTC = timezone.utc
NOW = datetime(2026, 7, 25, tzinfo=UTC)


def mk(uid, ce, proof):
    r = RetrievalResult(
        id=uid, text=uid, fact_type="observation",
        occurred_start=NOW - timedelta(days=10), proof_count=proof,
    )
    return ScoredResult(
        candidate=MergedCandidate(retrieval=r, rrf_score=0.0),
        cross_encoder_score_normalized=ce,
    )


# Fix 1 -- saturated CE band (as measured live). Same date on both rows, so
# recency/temporal are identical and proof_count is the ONLY other signal.
fresh = mk("fresh-high-ce", 0.9999, 1)
old = mk("old-high-proof", 0.9800, 10)
rows = [fresh, old]
apply_combined_scoring(rows, NOW)
order = [s.id for s in sorted(rows, key=lambda s: s.combined_score, reverse=True)]
print("SATURATED_ORDER", order, fresh.combined_score, old.combined_score)
if order[0] != "fresh-high-ce":
    failures.append("saturated CE: proof_count decided the ranking")

# A healthy (well-spread) encoder must be left completely alone.
a, b = mk("hi", 0.90, 1), mk("lo", 0.40, 10)
apply_combined_scoring([a, b], NOW)
print("HEALTHY", a.cross_encoder_score_normalized, b.cross_encoder_score_normalized)
if abs(a.cross_encoder_score_normalized - 0.90) > 1e-9 or abs(b.cross_encoder_score_normalized - 0.40) > 1e-9:
    failures.append("healthy CE spread was rescaled (must be a no-op)")

# An exactly-tied set stays untouched: upstream leaves that case to the
# caller-declared is_passthrough_reranker flag on purpose.
t1, t2 = mk("t1", 0.7, 1), mk("t2", 0.7, 10)
apply_combined_scoring([t1, t2], NOW)
if abs(t1.cross_encoder_score_normalized - 0.7) > 1e-9:
    failures.append("exactly-tied CE set was rescaled")

# Fix 2 -- compound tokens survive tokenization and reach the tsquery.
toks = tokenize_query("rollout v0.19.17")
print("TOKENS", toks)
if "v0.19.17" not in toks:
    failures.append("tokenize_query destroyed the intact version token")

tsq = create_sql_dialect("postgresql").prepare_bm25_text(toks, "rollout v0.19.17")
print("TSQUERY", tsq)
if "(v0.19.17 | (v0 & 19 & 17))" not in tsq:
    failures.append("native tsquery lost the compound group")
if [p for p in tsq.split(" | ") if p.strip() == "19"]:
    failures.append("bare fragment 19 still OR-ed standalone (matches clock timestamps)")
if "rollout" not in tsq:
    failures.append("plain word token dropped from tsquery")

# A query with no compound token must be byte-identical to upstream.
plain = create_sql_dialect("postgresql").prepare_bm25_text(
    tokenize_query("hello world"), "hello world"
)
print("PLAIN", plain)
if plain != "hello | world":
    failures.append("plain query changed shape: " + repr(plain))

# Fix 3 -- both timeout re-raises carry a message.
import hindsight_api.engine.providers.litellm_llm as m
src = open(m.__file__).read()
n = src.count("raise TimeoutError(")
print("TIMEOUT_RAISES", n)
if n != 2:
    failures.append("expected 2 message-carrying timeout raises, found " + str(n))

print("FAILURES", failures)
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

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight search patches change real behaviour (skipped without docker / the pinned upstream image)",
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
      "unpatched upstream is RED on all three defects (proves the probe bites)",
      () => {
        const { status, stdout } = runProbe(false);
        expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);
        // Each defect must be individually reproduced, not just "something failed".
        expect(stdout).toContain("saturated CE: proof_count decided the ranking");
        expect(stdout).toContain("tokenize_query destroyed the intact version token");
        expect(stdout).toContain("native tsquery lost the compound group");
        expect(stdout).toContain("bare fragment 19 still OR-ed standalone");
        expect(stdout).toContain("found 0");
        // The concrete inversion: the highest-CE row loses to the high-proof row.
        expect(stdout).toMatch(/SATURATED_ORDER \['old-high-proof', 'fresh-high-ce'\]/);
        expect(stdout).toContain("TOKENS ['rollout', 'v0', '19', '17']");
        expect(stdout).toContain("TSQUERY rollout | v0 | 19 | 17");
      },
      240_000,
    );

    it(
      "upstream + the baked patch blocks is GREEN",
      () => {
        const { status, stdout } = runProbe(true);
        expect(status, `probe failed:\n${stdout}`).toBe(0);
        expect(stdout).toContain("FAILURES []");
        // Highest-CE row now wins despite proof_count 1 vs 10.
        expect(stdout).toMatch(/SATURATED_ORDER \['fresh-high-ce', 'old-high-proof'\]/);
        // Intact version token preserved AND grouped so its fragments only
        // score when they all co-occur.
        expect(stdout).toContain("v0.19.17");
        expect(stdout).toContain("TSQUERY rollout | (v0.19.17 | (v0 & 19 & 17))");
        // Non-compound queries are unchanged.
        expect(stdout).toContain("PLAIN hello | world");
        expect(stdout).toContain("TIMEOUT_RAISES 2");
      },
      240_000,
    );
  },
);
