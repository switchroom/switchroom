/**
 * Pin the docker/Dockerfile.hindsight bake list. PR #1266 introduced
 * this Dockerfile but four shape-bugs slipped through because no
 * structural test pinned them; each surfaced only on a real build +
 * runtime under the pinned UID 11000:
 *
 *   1. `pip install` against /app/api/.venv/bin/pip — but upstream
 *      :latest's venv is uv-managed and ships no `pip` binary, so the
 *      command exits 127 at build time.
 *   2. `COPY --chmod=0644` propagated the mode to the implicitly-
 *      created parent dir /usr/local/lib/switchroom, leaving it
 *      non-traversable from non-root → entrypoint Node fetcher fails
 *      with `Cannot find module …` at boot under USER hindsight.
 *   3. (Out of scope here, see CI matrix test.) The image was never
 *      added to .github/workflows/docker-images.yml so no CI build
 *      ever caught (1) or (2).
 *
 * These are grep-on-file structural tests — fast, no docker required,
 * sufficient to catch a regression that puts back the broken shape.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HINDSIGHT_PERF_ENV_KEYS } from "../../src/setup/hindsight-perf-defaults.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

/**
 * Every `RUN` instruction, as its own array of physical lines (continuations
 * folded in).
 *
 * Assertions about the CUDA stanza are scoped through this rather than through
 * a file-wide `dockerfile.search()`. A file-wide search is positional and
 * therefore fragile in a way that FAILS OPEN: the else-branch used to be
 * sliced between the first `else \` and the first `fi` anywhere in the file,
 * so adding an unrelated `if/else` earlier in the Dockerfile would silently
 * re-point the slice at foreign text and every assertion inside it would go
 * vacuous while staying green. Scoping to the instruction that actually
 * contains the CUDA install cannot drift that way.
 */
function runInstructions(): string[][] {
  const lines = dockerfile.split("\n");
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^RUN\b/.test(lines[i])) continue;
    const block = [lines[i]];
    while (/\\\s*$/.test(block[block.length - 1]) && i + 1 < lines.length) {
      block.push(lines[++i]);
    }
    out.push(block);
  }
  return out;
}

/** The single RUN instruction carrying the arch-gated CUDA torch install. */
function cudaTorchRun(): string[] {
  const matches = runInstructions().filter((b) =>
    b.join("\n").includes("TARGETARCH:-amd64"),
  );
  expect(
    matches,
    "exactly one RUN instruction must carry the arch-gated CUDA torch install",
  ).toHaveLength(1);
  return matches[0];
}

describe("Dockerfile.hindsight shape", () => {
  it("extends the canonical upstream image", () => {
    expect(dockerfile).toMatch(
      /^FROM\s+ghcr\.io\/vectorize-io\/hindsight:latest\b/m,
    );
  });

  it("installs claude-agent-sdk via `uv pip install` (NOT bare .venv/bin/pip)", () => {
    // Upstream :latest builds the venv with `uv sync`, which leaves
    // no `pip` binary in .venv/bin/. Calling .venv/bin/pip directly
    // → exit 127 at build time. The canonical uv-into-existing-venv
    // pattern is `VIRTUAL_ENV=<path> uv pip install …`.
    expect(dockerfile).toMatch(
      /VIRTUAL_ENV=\/app\/api\/\.venv\s+uv\s+pip\s+install[^\n]+claude-agent-sdk/,
    );
    // And must NOT use the broken form even as a fallback / OR-chain.
    expect(dockerfile).not.toMatch(
      /\/app\/api\/\.venv\/bin\/pip\s+install/,
    );
  });

  it("verifies the SDK import works at build time (fail-loud guard)", () => {
    expect(dockerfile).toMatch(
      /from\s+claude_agent_sdk\s+import\s+query/,
    );
  });

  it("reinstalls torch from a CUDA wheel index (the reranker runs on GPU)", () => {
    // The recall reranker is sentence-transformers + PyTorch, and upstream's
    // cross_encoder.py already selects `cuda` when torch.cuda.is_available().
    // Upstream's venv ships `torch==2.12.1+cpu` (torch.version.cuda is None),
    // which is the ONLY reason reranking is CPU-bound. Pin the CUDA reinstall.
    expect(dockerfile).toMatch(
      /--index-url\s+https:\/\/download\.pytorch\.org\/whl\/cu\d+/,
    );
    // CUDA local-version tag on an explicit version pin. A `+cpu` (or
    // untagged) requirement would resolve straight back to the CPU build and
    // silently undo the whole change while every other assertion here passed.
    const torchReq = dockerfile.match(/'torch==([^']+)'/);
    expect(torchReq, "the Dockerfile must pin an explicit torch requirement").not.toBeNull();
    expect(torchReq![1]).toMatch(/^\d+\.\d+\.\d+\+cu\d+$/);
    expect(torchReq![1]).not.toContain("+cpu");
    // uv against the existing venv — same rule as the SDK install above
    // (upstream's uv-managed venv ships no `pip` binary).
    expect(dockerfile).toMatch(
      /VIRTUAL_ENV=\/app\/api\/\.venv\s+uv\s+pip\s+install[\s\S]{0,120}?--index-url\s+https:\/\/download\.pytorch\.org/,
    );
  });

  it("asserts at BUILD time that torch is really a CUDA build (fail-loud guard)", () => {
    // The dangerous failure mode is a wheel that installs but resolves back to
    // CPU (or imports broken): the reranker silently stays slow, or the API
    // fails to boot, autoheal restart-loops the container, and fleet memory is
    // down until someone rolls the image tag back. Prove it at BUILD time,
    // where a failure is just a red CI job.
    //
    // The interpreter is part of the assertion, not incidental: the API runs
    // out of /app/api/.venv, and a bare `python3` is the image's SYSTEM python,
    // which has its own (or no) torch. Verifying there would green-light a
    // build whose venv torch is still `+cpu` — the guard would pass while the
    // thing it guards is broken. Pin the interpreter path.
    const block = cudaTorchRun();
    expect(block.join("\n")).toMatch(
      /\/app\/api\/\.venv\/bin\/python\s+-c\s+["']import torch;\s*assert torch\.version\.cuda,/,
    );
    expect(dockerfile).toContain(
      "switchroom hindsight CUDA-torch install: torch {torch.__version__} is not a CUDA build",
    );
    // The assert must FOLLOW the install — one that precedes it proves nothing.
    // Both indices are taken over the EXECUTABLE lines of this instruction, not
    // over the whole file: a file-wide search can be satisfied by a decoy in a
    // comment, which would let a real assert sit above a real install and still
    // read as ordered.
    const code = block.filter((l) => !/^\s*#/.test(l));
    const installIdx = code.findIndex((l) =>
      /--index-url\s+https:\/\/download\.pytorch\.org/.test(l),
    );
    const assertIdx = code.findIndex((l) => /assert torch\.version\.cuda,/.test(l));
    expect(installIdx, "the CUDA install line must exist").toBeGreaterThanOrEqual(0);
    expect(assertIdx).toBeGreaterThan(installIdx);
    // Every torch probe in this instruction — including the non-amd64 branch's
    // informational one — must use the venv interpreter, for the same reason.
    // Quote-agnostic: `-c 'import torch;` is the same command as `-c "import
    // torch;` to the shell, and a double-quote-only pattern would not see it.
    const probes = block.filter((l) => /-c\s+["']import torch;/.test(l));
    expect(probes.length, "the instruction must contain torch probes").toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe, "torch probes must run under the venv interpreter").toContain(
        "/app/api/.venv/bin/python",
      );
    }
  });

  it("restricts the CUDA torch payload to amd64 (fleet GPU hosts are x86_64)", () => {
    // Multiple GB of vendored nvidia-* libs per arch, on an image already
    // ~6.4GB, for an arch with no GPU host behind it. Dockerfile.voice makes
    // the same call. arm64 keeps upstream's CPU torch and reranks on CPU.
    expect(dockerfile).toMatch(/^ARG TARGETARCH$/m);
    expect(dockerfile).toMatch(/if \[ "\$\{TARGETARCH:-amd64\}" = "amd64" \]; then/);
    // ARG must be re-declared inside the stage it is used in: BuildKit's
    // built-in TARGETARCH is only bound to stages that declare it, and a
    // declaration above the FROM does not carry into the stage. Note which way
    // that fails — `${TARGETARCH:-amd64}` defaults an EMPTY value to amd64, so
    // a missing declaration takes the CUDA branch, not the CPU one. The
    // resulting hazard is an arm64 build attempting the x86_64 CUDA install
    // (a hard failure), never a silent CPU fallback on amd64.
    const fromIdx = dockerfile.search(/^FROM\s+ghcr\.io\/vectorize-io\/hindsight/m);
    const argIdx = dockerfile.search(/^ARG TARGETARCH$/m);
    expect(argIdx).toBeGreaterThan(fromIdx);

    // The non-amd64 branch is never EXECUTED by PR CI. Not because the job is
    // skipped — `build-hindsight` does run on pull_request and passes — but
    // because PR builds pin `platforms: linux/amd64` and skip the QEMU setup
    // step (`if: github.event_name != 'pull_request'`), so only the amd64 leg
    // is ever built there. This assertion is therefore the only thing standing
    // between that branch and an untested regression, and it has to be
    // airtight rather than indicative.
    //
    // Hence an ALLOWLIST, not a blocklist. Enumerating forbidden spellings
    // cannot hold: `pip3 install`, `uv add`, `apt-get install
    // nvidia-cuda-toolkit` and `sh /opt/install-torch.sh` all install things
    // while matching no plausible blocklist. Requiring each line to BE one of
    // the two known statements rejects every one of them by construction.
    const block = cudaTorchRun();
    const elseIdx = block.findIndex((l) => /^\s*else\s*\\?\s*$/.test(l));
    const fiIdx = block.findIndex((l) => /^\s*fi\s*;?\s*\\?\s*$/.test(l));
    expect(elseIdx, "the non-amd64 branch must exist").toBeGreaterThanOrEqual(0);
    expect(fiIdx).toBeGreaterThan(elseIdx);

    const ELSE_BRANCH_ALLOWED = [
      /^\s*echo "torch-cuda skipped on non-amd64 arch: \$\{TARGETARCH\}" >&2; \\$/,
      /^\s*\/app\/api\/\.venv\/bin\/python -c "import torch; print\(f'torch ok \(cpu build\): \{torch\.__version__\}'\)" >&2; \\$/,
    ];
    const elseLines = block
      .slice(elseIdx + 1, fiIdx)
      .filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
    expect(
      elseLines.length,
      "the non-amd64 branch must contain exactly its two known statements",
    ).toBe(ELSE_BRANCH_ALLOWED.length);
    for (const [i, pattern] of ELSE_BRANCH_ALLOWED.entries()) {
      expect(
        elseLines[i],
        `non-amd64 branch line ${i + 1} is not the expected statement — ` +
          "this branch is unbuilt by PR CI, so anything new here ships unverified",
      ).toMatch(pattern);
    }
  });

  it("installs the @anthropic-ai/claude-code CLI globally", () => {
    // Allow the install to be quoted + version-pinned, e.g.
    // `npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"`.
    expect(dockerfile).toMatch(
      /npm\s+install\s+-g\s+"?@anthropic-ai\/claude-code/,
    );
  });

  it("pins the runtime UID to 11000 to match HINDSIGHT_DEFAULT_UID", () => {
    // The auth-broker chowns the per-consumer socket to UID 11000 at
    // mode 0600; if the runtime UID differed, the entrypoint would
    // EACCES on the socket connect. The Dockerfile rewrites the
    // upstream `hindsight` user to UID 11000 at build time.
    expect(dockerfile).toMatch(/NEW_UID=11000\b/);
    expect(dockerfile).toMatch(/usermod\s+-u\s+"\$NEW_UID"\s+hindsight/);
  });

  it("restores 0755 on /usr/local/lib/switchroom after the COPY", () => {
    // `COPY --chmod=0644 docker/foo.cjs /usr/local/lib/switchroom/foo.cjs`
    // creates the parent dir implicitly AND propagates the file mode
    // (0644) onto the dir. A dir without `x` is not traversable; the
    // entrypoint shim then fails to find the .cjs file under USER 11000
    // with `Cannot find module '/usr/local/lib/switchroom/...'` and
    // crash-loops the container.
    //
    // Pin the explicit chmod that follows the COPY.
    expect(dockerfile).toMatch(
      /chmod\s+0755\s+\/usr\/local\/lib\/switchroom\b/,
    );
  });

  it("bakes the credential-fetcher .cjs at the canonical path", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=\d+\s+docker\/hindsight-fetch-creds\.cjs\s+\/usr\/local\/lib\/switchroom\/hindsight-fetch-creds\.cjs/,
    );
  });

  it("bakes the entrypoint shim at the canonical path with executable mode", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=0755\s+docker\/hindsight-entrypoint\.sh\s+\/usr\/local\/bin\/switchroom-hindsight-entrypoint\.sh/,
    );
  });

  it("bakes the maintenance sidecar (backup/autovacuum/retention) as executable", () => {
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=0755\s+docker\/hindsight-maintenance\.sh\s+\/usr\/local\/lib\/switchroom\/hindsight-maintenance\.sh/,
    );
  });

  it("creates /backups owned by hindsight BEFORE `USER hindsight` (so the named volume is writable)", () => {
    // A root-owned /backups mount point makes the fresh named volume
    // root-owned → the non-root hindsight process EACCESes on pg_dump and
    // backups silently never succeed (observed live on the v0.15.41 roll).
    expect(dockerfile).toMatch(/mkdir -p \/backups && chown hindsight:hindsight \/backups/);
    const chownIdx = dockerfile.search(/chown hindsight:hindsight \/backups/);
    const userIdx = dockerfile.search(/^USER\s+hindsight\b/m);
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(chownIdx); // chown runs as root, before the USER switch
  });

  it("ends as USER hindsight (so the entrypoint runs as UID 11000)", () => {
    expect(dockerfile).toMatch(/^USER\s+hindsight\b/m);
  });

  it("declares ENTRYPOINT pointing at the switchroom shim, not upstream's CMD", () => {
    expect(dockerfile).toMatch(
      /^ENTRYPOINT\s+\["\/usr\/local\/bin\/switchroom-hindsight-entrypoint\.sh"\]/m,
    );
  });

  it("keeps the #2392 claude_code env-isolation patch (assert-guarded, fail-loud)", () => {
    // The #2392 build-time patch neutralizes upstream's env isolation
    // (mkdtemp CONFIG_DIR + SECURESTORAGE="") that breaks file-based
    // creds. It is self-verifying: it asserts the upstream anchor is
    // present before patching. Guard the patch block itself so nobody
    // silently deletes it.
    expect(dockerfile).toMatch(
      /assert OLD_PATH in s, "switchroom #2392 patch:/,
    );
    expect(dockerfile).toMatch(
      /path = "\/run\/claude-creds"  # switchroom #2392:/,
    );
  });

  // ---------------------------------------------------------------------
  // RETIRED PATCHES — dropped in the v0.8.4 -> v0.8.5 base bump because
  // upstream now does the same thing natively. These are asserted ABSENT
  // rather than merely deleted: a patch that upstream has adopted must not
  // silently reappear on a future rebase, where it would either fail its
  // own exact-once anchor assert (breaking the build) or double-apply.
  //
  //  - max_turns/ToolSearch standard-call fix: 0.8.5 ships `tools=[]` on the
  //    standard path itself (claude_code_llm.py, alongside its own
  //    `max_turns=1  # Single-turn for API-style interactions`). With the
  //    built-in tools unloaded ToolSearch cannot fire, so our extra turn of
  //    headroom is dead weight.
  //  - unit_entities FK-race fix: upstream #2662 adds bulk_reassert_entities
  //    (engine/db/ops_postgresql.py) + reassert_entities_batch
  //    (entity_resolver.py). Strictly better than ours: it row-LOCKS the
  //    surviving parents so the pruner blocks, where ours only resurrected
  //    the parent after the fact.
  //  - duplicate-ANN-scan fix: 0.8.5 DELETED the `semantic_seeds` parameter
  //    from LinkExpansionRetriever.retrieve() and documented the removal
  //    ("Graph traversal deliberately chooses its own bounded seeds ...
  //    reusing their results would silently change graph-retrieval recall
  //    behavior"). Our patch's stated safety premise — that the parameter
  //    already exists and is already honoured — is now false, so re-adding
  //    it would fight a deliberate upstream design decision. The latency it
  //    bought is largely absorbed by the per-bank vector indexes that
  //    `hindsight-admin repair-bank` (upstream #2645) now maintains.
  //
  //    POSTSCRIPT (2026-07-27): upstream itself reversed that stance one day
  //    later in PR #2968 (merge b475f5cc), reintroducing seed reuse *with* a
  //    correctness guard — reuse only when the semantic floor is no stricter
  //    than the graph seed floor. We now carry THAT (see the #2968 block), so
  //    the guard below discriminates on the switchroom implementation's own
  //    markers rather than on the generic `semantic_seeds` token.
  // ---------------------------------------------------------------------
  it("does NOT carry the retired max_turns/ToolSearch patch (upstream ships tools=[])", () => {
    expect(dockerfile).not.toMatch(/switchroom max_turns\/ToolSearch standard-call fix/);
    expect(dockerfile).not.toMatch(
      /max_turns=2,  # switchroom: headroom so a stray ToolSearch turn/,
    );
  });

  it("does NOT carry the retired unit_entities FK-race patch (upstream #2662)", () => {
    expect(dockerfile).not.toMatch(/switchroom hindsight FK-race patch/);
    expect(dockerfile).not.toMatch(/reassert_entities/);
    expect(dockerfile).not.toMatch(/entity_records/);
  });

  it("does NOT carry the retired switchroom-authored duplicate-ANN-scan patch", () => {
    // NOTE: the bare tokens `semantic_seeds` / `_find_semantic_seeds` are NOT
    // usable as discriminators any more — the upstream #2968 carry below
    // legitimately reintroduces seed reuse under upstream's OWN design, with
    // upstream's correctness guard. What must stay dead is the *switchroom*
    // implementation, whose premise ("the parameter already exists and is
    // already honoured") 0.8.5 falsified. Its unique markers:
    expect(dockerfile).not.toMatch(/switchroom hindsight duplicate-ANN-scan patch/);
    expect(dockerfile).not.toMatch(/def _graph_semantic_seeds\(/);
    expect(dockerfile).not.toMatch(/semantic_seeds=_graph_semantic_seeds\(/);
    expect(dockerfile).not.toMatch(/_GRAPH_SEED_LIMIT/);
    expect(dockerfile).not.toMatch(/_GRAPH_SEED_MIN_SIMILARITY/);
    expect(dockerfile).not.toMatch(/temporal_seeds/);
  });

  it("keeps the cross-encoder saturation fix (assert-guarded, fail-loud)", () => {
    // apply_combined_scoring makes CE * recency * temporal * proof_count the
    // ONLY final score (RRF is explicitly zeroed). Measured live on bank
    // `overlord`: a 116-result recall had every CE score inside 0.9800-0.9999,
    // so the boosts — undamped worst-case ratio ~1.65 — decided the order and
    // the single highest-CE memory ranked 7th behind older, more-proven ones.
    // The patch DAMPS the boost product so it modulates the CE decision
    // instead of replacing it. Behaviour is proven against the pinned upstream
    // image in tests/docker/hindsight-search-patches.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight CE-saturation patch: \{name\} anchor found \{n\}x/,
    );
    // `import math` is a load-bearing dependency of _boost_authority, so its
    // presence is itself an anchor: if upstream drops or reorders it the build
    // fails loudly rather than emitting a NameError at recall time.
    expect(dockerfile).toMatch(
      /OLD_IMPORTS = "import math\\nfrom datetime import datetime, timezone\\n"/,
    );
    expect(dockerfile).toMatch(
      /assert "\\nimport math\\n" in t, "switchroom hindsight CE-saturation patch: `import math` is gone/,
    );

    // Named module constant tied to the MEASURED saturation spread, and a
    // derivation from the alphas — not a hand-tuned exponent.
    expect(dockerfile).toMatch(/_CE_DECISIVE_RELATIVE_GAP_DEFAULT: float = 0\.02/);
    expect(dockerfile).toMatch(/def _boost_authority\(/);
    expect(dockerfile).toMatch(
      /math\.log1p\(_CE_DECISIVE_RELATIVE_GAP\) \/ math\.log\(hi \/ lo\)/,
    );

    // The gap is an OPERATOR KNOB, not a baked constant. This damping is a
    // calibration judgement whose failure mode is a silent recall-quality
    // regression with no telemetry behind it, so backing it out must be a
    // container restart (one env var) rather than an image rebuild. A wide
    // gap clamps the exponent to 1.0 = exact upstream scoring.
    expect(dockerfile).toMatch(
      /_CE_DECISIVE_RELATIVE_GAP_ENV: str = .HINDSIGHT_CE_DECISIVE_RELATIVE_GAP./,
    );
    expect(dockerfile).toMatch(
      /_CE_DECISIVE_RELATIVE_GAP: float = _decisive_relative_gap\(\)/,
    );
    // A bad value must degrade to the default, never raise out of the scoring
    // path — an unparseable env var must not take recall down.
    expect(dockerfile).toMatch(/except \(TypeError, ValueError\):/);
    expect(dockerfile).toMatch(
      /if not math\.isfinite\(value\) or value <= 0\.0:/,
    );
    expect(dockerfile).toMatch(
      /HINDSIGHT_CE_DECISIVE_RELATIVE_GAP=<float>/,
    );

    // …and the knob the image reads must be one switchroom can actually set.
    // `resolveHindsightPerfOverrides` drops any key outside
    // HINDSIGHT_PERF_ENV_KEYS silently, and the patch reads this var once at
    // import, so an unmanaged name here is a documented escape hatch that
    // cannot be reached from switchroom.yaml at all. Derive the name from the
    // Dockerfile rather than restating it, so the two cannot drift apart.
    const envName = dockerfile.match(
      /_CE_DECISIVE_RELATIVE_GAP_ENV: str = "([A-Z0-9_]+)"/,
    )?.[1];
    expect(envName, "the patch must name its env knob").toBeDefined();
    expect(
      HINDSIGHT_PERF_ENV_KEYS.has(envName!),
      `${envName} is read by the baked patch but is not in HINDSIGHT_PERF_ENV_KEYS, ` +
        "so a hindsight.env line for it is discarded before it reaches the container",
    ).toBe(true);

    // The exponent is derived ONCE PER CALL from the alphas alone. That is what
    // makes a candidate's score a pure function of its own fields — no
    // candidate-set-relative quantity may appear.
    expect(dockerfile).toMatch(
      /_boost_exponent = _boost_authority\(recency_alpha, temporal_alpha, proof_count_alpha\)/,
    );
    expect(dockerfile).toMatch(
      /sr\.combined_score = sr\.cross_encoder_score_normalized \* \(_boost\*\*_boost_exponent\)/,
    );

    // Post-replace re-assertions (verification-on-build), including the
    // STRUCTURAL guard that no reformatted reintroduction of the withdrawn
    // min-max rescale can slip past an exact-string check.
    expect(dockerfile).toMatch(
      /assert "_CE_DECISIVE_RELATIVE_GAP_DEFAULT: float = 0\.02" in t,/,
    );
    expect(dockerfile).toMatch(
      /_ce_writes = re\.findall\(r"\^\\s\*sr\\\.cross_encoder_score_normalized\\s\*=/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight CE-saturation patch: boost product damped/,
    );
  });

  it("never rewrites the caller-visible cross_encoder_score_normalized field", () => {
    // engine/memory_engine.py applies the agent-supplied `min_scores.reranker`
    // floor DIRECTLY to cross_encoder_score_normalized, and `min_scores` is a
    // documented MCP recall parameter any agent may pass. The field is an
    // ABSOLUTE, caller-visible quantity — no switchroom patch may rewrite it.
    //
    // A withdrawn revision min-max rescaled it onto [0.1, 1.0] whenever the
    // spread fell under a threshold. Measured against the pinned upstream
    // image, that dropped 78 of 100 results at `min_scores: {reranker: 0.8}`
    // which upstream returned, was candidate-set-relative, and amplified 1e-7
    // of float noise into a ranking decision. This guard keeps it out.
    expect(dockerfile).not.toMatch(/_CE_SATURATION_SPREAD_THRESHOLD/);
    expect(dockerfile).not.toMatch(/_ce_spread/);
    expect(dockerfile).not.toMatch(/_ce_lo/);

    // Structural rather than exact-string: ANY assignment to the field trips
    // this, however it is reformatted or renamed around. The sole permitted
    // writer is upstream's own is_passthrough_reranker reseed, which patches
    // may quote verbatim as an anchor but must never alter.
    const ceWrites = [
      ...dockerfile.matchAll(/sr\.cross_encoder_score_normalized\s*=(?!=)[^\n]*/g),
    ].map((m) => m[0]);
    expect(
      ceWrites.filter((w) => !w.includes("1.0 - (0.9 * new_rank / denom)")),
      "only upstream's passthrough reseed may assign cross_encoder_score_normalized — " +
        "it carries the absolute min_scores.reranker floor",
    ).toEqual([]);

    // No re-weighting of the alphas or the boost formulae themselves.
    expect(dockerfile).not.toMatch(/_(RECENCY|TEMPORAL|PROOF_COUNT)_ALPHA[^\n]*=\s*\d/);
    expect(dockerfile).not.toMatch(/(recency|temporal|proof_count)_boost\s*=\s*1\.0 \+ \d/);
  });

  it("keeps the BM25 compound-token fix (assert-guarded, fail-loud)", () => {
    // tokenize_query shredded `v0.19.17` into v0/19/17, but to_tsvector indexes
    // it as ONE lexeme — zero overlap on the discriminating term, and the
    // stripped `19` then matched clock timestamps like 19:33:13. The patch
    // APPENDS the intact compound token, keeping the fragments, so the emitted
    // token list is a strict superset of upstream's.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight BM25 compound-token patch: anchor found \{n\}x/,
    );
    // Separators restricted to . / - so the token is always tsquery-safe unquoted.
    expect(dockerfile).toMatch(
      /_COMPOUND_TOKEN_RE = re\.compile\(r"\\\\w\+\(\?:\[\.\/-\]\\\\w\+\)\+"\)/,
    );
    expect(dockerfile).toMatch(/if compound not in tokens:/);
    // Append, never substitute — the upstream fragments must survive.
    expect(dockerfile).toMatch(/tokens\.append\(compound\)/);

    // ---- Negative guards: the withdrawn tsquery-narrowing half must not
    // return. Emitting `compound | (f1 & f2 & ...)` and dropping the standalone
    // fragments narrowed matching for EVERY ./-// token — verified on postgres
    // 16, a doc saying `shipped in 2026 during july` stopped matching a query
    // containing `2026-07-25`, and `a report about art` stopped matching
    // `state-of-the-art`. Every fact in these banks carries a date stamp.
    expect(dockerfile).not.toMatch(/compound_fragments: set\[str\] = set\(\)/);
    expect(dockerfile).not.toMatch(/compound_fragments\.update/);
    expect(dockerfile).not.toMatch(/groups\.append/);
    // sql/postgresql.py must not be touched at all by this patch.
    expect(dockerfile).not.toMatch(/apply\("sql\/postgresql\.py"/);

    // Post-replace re-assertions (verification-on-build), including the
    // build-time guard that the native tsquery is still a plain OR join.
    expect(dockerfile).toMatch(/assert "_COMPOUND_TOKEN_RE" in t,/);
    expect(dockerfile).toMatch(/assert "compound_fragments" not in pg,/);
    expect(dockerfile).toMatch(
      /switchroom hindsight BM25 compound-token patch: intact compound tokens appended/,
    );
  });

  it("keeps the LiteLLM empty-TimeoutError-message fix (assert-guarded, fail-loud)", () => {
    // Both retry loops ended their timeout handler with a bare `raise`,
    // re-raising an asyncio.TimeoutError with no args — so operators saw
    // `chunk 0: TimeoutError: ` with no timeout, attempt count, or scope. The
    // patch re-raises a message-carrying TimeoutError chained off the original
    // (safe on 3.11, where asyncio.TimeoutError IS TimeoutError, so every
    // upstack matcher still matches).

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight timeout-message patch: anchor found \{n\}x/,
    );
    // Message-carrying, chained re-raise.
    expect(dockerfile).toMatch(/"                raise TimeoutError\(\\n"/);
    expect(dockerfile).toMatch(/"                \) from e\\n"/);
    // BOTH handlers (the standard `call` path and the tool-calling path).
    expect(dockerfile).toMatch(/for label in \("call", "tool call"\):/);
    // Post-replace re-assertions (verification-on-build).
    expect(dockerfile).toMatch(
      /assert t\.count\("raise TimeoutError\("\) == 2,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight timeout-message patch: LiteLLM timeout re-raises now carry/,
    );
  });

  it("keeps the recall-admission-split fix (assert-guarded, fail-loud)", () => {
    // Background consolidation reaches recall through the SAME
    // MemoryEngine.recall_async a user's turn does, so both contended on the
    // single `_search_semaphore` admission gate. Measured on this host: mean
    // admission wait 5.43s, p90 15.7s, max 27.4s against a recall hook whose
    // per-bank socket timeout is 8s — fleet p50 pinned at 8.02s. The patch
    // admits background callers through a small reservation semaphore FIRST,
    // then the same shared one. Behaviour (including that total concurrency is
    // unchanged) is proven against the pinned upstream image in
    // tests/docker/hindsight-recall-isolation-patches.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight recall-admission-split patch: anchor found \{n\}x/,
    );
    // The admission helper, and the nesting order that makes it a RESERVATION
    // rather than a second budget: background takes its own semaphore and then
    // the shared one, so the peak is still recall_max_concurrent.
    expect(dockerfile).toMatch(
      /"async def _recall_admission\(shared, background_reservation, is_background\):\\n"/,
    );
    expect(dockerfile).toMatch(/"    if is_background:\\n"/);
    expect(dockerfile).toMatch(/"        async with background_reservation:\\n"/);
    expect(dockerfile).toMatch(/"            async with shared:\\n"/);
    // The two call sites: recall_async admits through the helper, and the
    // consolidator flags its recall as background.
    expect(dockerfile).toMatch(
      /"            async with _recall_admission\(\\n"/,
    );
    // The ARGUMENT LINE, pinned exactly. This is the load-bearing one: swapping
    // the third argument for a literal `False` reverts the whole split while
    // leaving the helper defined, the call site intact and `_search_semaphore`
    // present as an argument — every other check here would still pass.
    expect(dockerfile).toContain(
      '"                self._search_semaphore, self._background_search_semaphore, _background\\n"',
    );
    expect(dockerfile).toMatch(/"            _background=True,\\n"/);
    // The config knob + the boot validation that keeps a foreground floor.
    expect(dockerfile).toMatch(
      /ENV_CONSOLIDATION_RECALL_MAX_CONCURRENT = "HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT"/,
    );
    expect(dockerfile).toMatch(
      /DEFAULT_CONSOLIDATION_RECALL_MAX_CONCURRENT = 2/,
    );
    expect(dockerfile).toMatch(
      /and self\.consolidation_recall_max_concurrent >= self\.recall_max_concurrent/,
    );
    // The DEFAULT is derived from the shared budget rather than fixed, so
    // lowering HINDSIGHT_API_RECALL_MAX_CONCURRENT cannot turn a deployment
    // that boots today into one that refuses to boot. Only an EXPLICIT
    // incoherent value fails validation.
    expect(dockerfile).toMatch(
      /def _consolidation_recall_max_concurrent\(getenv\)/,
    );
    expect(dockerfile).toMatch(
      /return max\(1, min\(DEFAULT_CONSOLIDATION_RECALL_MAX_CONCURRENT, shared - 1\)\)/,
    );
    // Post-replace re-assertions (verification-on-build). The negative one is
    // load-bearing: a surviving bare acquisition would let background bypass
    // the reservation entirely.
    expect(dockerfile).toMatch(
      /assert "async def _recall_admission\(" in me_new,/,
    );
    expect(dockerfile).toMatch(
      /assert "async with self\._search_semaphore:" not in me_new,/,
    );
    expect(dockerfile).toMatch(/assert "_background=True," in cons_new,/);
    // …and the build-time twin of the argument pin above.
    expect(dockerfile).toMatch(
      /a hard-coded third argument silently reverts the admission split/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight recall-admission-split patch: background consolidation recalls now pass a/,
    );
    // The two config.py patch blocks are ORDER-COUPLED on the same
    // HindsightConfig.validate() anchor; this block additionally requires
    // `@classmethod / def from_env` to still follow it, so it must run first.
    // Swapping them fails the build loudly, but reads as upstream drift.
    expect(dockerfile).toMatch(
      /ORDER-COUPLED WITH THE worker-slot-ceiling BLOCK BELOW — DO NOT SWAP THEM/,
    );
  });

  it("keeps the worker-slot-ceiling fix (assert-guarded, fail-loud)", () => {
    // HINDSIGHT_API_WORKER_<TYPE>_MAX_SLOTS is a reservation, i.e. a FLOOR:
    // WorkerPoller._get_available_slots documents that in-flight beyond the
    // reservation is served from the shared pool, so one type could hold all
    // DEFAULT_WORKER_MAX_SLOTS = 10 slots. This patch adds the missing CEILING.
    // Behaviour is proven against the pinned upstream image in
    // tests/docker/hindsight-recall-isolation-patches.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight worker-slot-ceiling patch: anchor found \{n\}x/,
    );
    // The mechanism: a per-type limit table with a consolidation default, an
    // env parser whose empty string means "uncapped", and the config field.
    expect(dockerfile).toMatch(
      /WORKER_SLOT_LIMIT_TYPES: dict\[str, tuple\[str, int \| None\]\] = \{/,
    );
    expect(dockerfile).toMatch(
      /"consolidation": \("HINDSIGHT_API_WORKER_CONSOLIDATION_SLOT_LIMIT", 4\)/,
    );
    expect(dockerfile).toMatch(
      /def _parse_worker_slot_limits\(getenv, max_slots: int\)/,
    );
    expect(dockerfile).toMatch(/worker_slot_limits=_parse_worker_slot_limits\(/);
    // Same rule as the admission reservation: a DEFAULT cap is clamped to
    // worker_max_slots so lowering that knob cannot break boot; an EXPLICIT
    // over-large cap still fails validation below.
    expect(dockerfile).toMatch(
      /limits\[op_type\] = max\(1, min\(int\(default\), max_slots\)\)/,
    );
    // Boot validation, at the same point as the existing reservation-sum check.
    expect(dockerfile).toMatch(/if limit > self\.worker_max_slots:/);
    expect(dockerfile).toMatch(/if limit < reserved:/);
    // The ceiling bounds SELECTION, it is not a post-selection filter. Phase 2a
    // is one `ORDER BY created_at LIMIT n` across every non-consolidation type,
    // so discarding the surplus afterwards spends the shared budget on rows that
    // are never claimed — one capped type then starves every other type of the
    // whole batch. An at-ceiling type is excluded in the WHERE clause instead,
    // with a refill fetch for the unspent remainder.
    expect(dockerfile).toContain(
      "AND operation_type != ALL(${idx}::text[])",
    );
    expect(dockerfile).toMatch(
      /exhausted = sorted\(t for t, h in remaining_ceilings\.items\(\) if h <= 0\)/,
    );
    // The budget is spent per ACCEPTED row, never per selected row (otherwise
    // rows the ceiling drops under-budget phase 2b).
    expect(dockerfile).toMatch(/_accept\(\[row\]\)\n\s+remaining_shared -= 1/);
    // Scoped to the REPLACEMENT body. `remaining_shared -= len(rows)` is
    // upstream's line and MUST still appear verbatim in CLAIM_BODY_OLD — it is
    // part of the anchor being replaced. It must not survive into the new body.
    const claimBodyOldIdx = dockerfile.indexOf("CLAIM_BODY_OLD = r'''");
    const claimBodyNewIdx = dockerfile.indexOf("CLAIM_BODY_NEW = r'''");
    expect(claimBodyOldIdx).toBeGreaterThan(-1);
    expect(claimBodyNewIdx).toBeGreaterThan(claimBodyOldIdx);
    expect(dockerfile.slice(claimBodyOldIdx, claimBodyNewIdx)).toMatch(
      /remaining_shared -= len\(rows\)/,
    );
    expect(dockerfile.slice(claimBodyNewIdx)).not.toMatch(
      /remaining_shared -= len\(rows\)/,
    );
    // At zero headroom phase 2b is skipped OUTRIGHT — no busy-banks scan, no
    // FOR UPDATE locks on rows this worker must discard.
    expect(dockerfile).toMatch(
      /consolidation_shared = _headroom\("consolidation", remaining_shared\)/,
    );
    expect(dockerfile).toMatch(/if consolidation_shared > 0:/);
    // Enforcement runs BEFORE the row is marked processing — that UPDATE is the
    // actual claim, so enforcing after it would leave rows half-claimed.
    expect(dockerfile).toMatch(
      /remaining_ceilings = dict\(type_ceilings\) if type_ceilings else \{\}/,
    );
    expect(dockerfile).toMatch(/        # Mark all claimed rows as processing/);
    // Threaded from the poller through both DB backends.
    expect(dockerfile).toMatch(/"        type_ceilings=None,\\n"/);
    expect(dockerfile).toMatch(
      /for rel in \("engine\/db\/ops_postgresql\.py", "engine\/db\/ops_oracle\.py"\):/,
    );
    expect(dockerfile).toMatch(/slot_limits=config\.worker_slot_limits,/);
    // The reservations themselves must NOT be renamed here: renaming a shipped
    // env var is a breaking config change, filed upstream instead.
    expect(dockerfile).not.toMatch(
      /HINDSIGHT_API_WORKER_CONSOLIDATION_MIN_SLOTS/,
    );
    // Post-replace re-assertions (verification-on-build), including the
    // ORDERING guard that enforcement precedes the claiming UPDATE.
    expect(dockerfile).toMatch(
      /assert t\.index\("remaining_ceilings = dict\(type_ceilings\)"\) < t\.index\(/,
    );
    expect(dockerfile).toContain(
      "at-ceiling types are not excluded ",
    );
    expect(dockerfile).toContain(
      "phase 2b is not clamped by ",
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight worker-slot-ceiling patch: worker_slot_limits is a real per-type CAP/,
    );
  });

  it("keeps the sem-wait-always-logged fix (assert-guarded, fail-loud)", () => {
    // Two gates hid the admission wait. It was only logged above 0.01s, so
    // recalls that did NOT queue left no datum and the measured mean was biased
    // upwards by the missing zeros; and the whole completion line sits behind
    // `if not quiet:` while the consolidator recalls with _quiet=True, so the
    // BACKGROUND population this PR pins at 2 emitted nothing at all. Behaviour
    // is proven against the pinned upstream image in
    // tests/docker/hindsight-recall-isolation-patches.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight sem-wait-always-logged patch: anchor found \{n\}x/,
    );
    // The conditional is the anchor being replaced, and the append is now
    // unconditional.
    expect(dockerfile).toMatch(/"            if semaphore_wait > 0\.01:\\n"/);
    // The dead ternary goes with the gate: wait_parts can no longer be empty, so
    // the `else ""` branch was unreachable.
    expect(dockerfile).toContain(
      "wait_info = f\\\" | waits: {', '.join(wait_parts)}\\\"\\n",
    );
    // A quiet (background) recall still reports its admission wait — otherwise
    // the reservation backing consolidation up is invisible, which is the exact
    // "we mis-sized this from biased logs" failure the patch exists to prevent.
    expect(dockerfile).toContain("[RECALL {recall_id}] Complete (quiet):");
    // …as ONE line, not the multi-line buffer _quiet exists to suppress.
    expect(dockerfile).not.toMatch(
      /else:\n\s+logger\.info\("\\\\n" \+ "\\\\n"\.join\(log_buffer\)\)/,
    );
    // Post-replace re-assertions (verification-on-build), including the SCOPE
    // guard: the conn= threshold is deliberately untouched by this patch.
    expect(dockerfile).toMatch(
      /assert "if semaphore_wait > 0\.01:" not in t,/,
    );
    expect(dockerfile).toMatch(
      /assert 'if max_conn_wait > 0\.01:' in t,/,
    );
    expect(dockerfile).toContain(
      "a quiet (background) recall still ",
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight sem-wait-always-logged patch: sem= now emitted on every recall/,
    );
  });

  it("keeps the perturbed-JSON-retry fix (assert-guarded, fail-loud)", () => {
    // Upstream's `except json.JSONDecodeError` handler re-issued the SAME
    // call_kwargs, so behind a caching LiteLLM proxy every "retry" replayed
    // the identical unparseable body (measured 2026-07-26: 0.02s and the same
    // response id on the repeat, vs 37.66s and a new id once the cache was
    // bypassed). That is how a transient bad completion burned all attempts
    // and failed a retain — which in turn aged a queued memory toward .dead.
    //
    // SCOPE: this test is structural, not behavioural. Every assertion below
    // is an unanchored substring match, so it proves the patch is PRESENT,
    // never that it RUNS — indenting the perturbation body under a falsy
    // guard keeps all of them green (measured 2026-07-26). The behavioural
    // gate is tests/docker/hindsight-retry-perturbation-patches.test.ts,
    // which applies this block to the pinned image and asserts the retry is
    // actually a different request. Do not treat this file as sufficient.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight perturbed-JSON-retry patch: anchor found \{n\}x/,
    );
    // The load-bearing perturbation: bypass the PROXY response cache. It must
    // travel in `extra_body` — litellm's top-level `cache=` kwarg is consumed
    // by the SDK and never reaches the wire (measured, same run).
    expect(dockerfile).toMatch(/_cache\["no-cache"\] = True/);
    expect(dockerfile).toMatch(/call_kwargs\["extra_body"\] = _extra/);
    // Secondary perturbation, and only when the caller already set one, so
    // models that reject the parameter keep their kwargs untouched.
    expect(dockerfile).toMatch(
      /if call_kwargs\.get\("temperature"\) is not None:/,
    );
    // And it is capped at 0.7, not 1.0. The json_schema response_format is
    // advisory (one of the two measured bad bodies was prose emitted while a
    // schema was set), so a cap of 1.0 would make the LATE attempts the
    // likeliest to emit invalid JSON — a retry strategy that degrades as it
    // goes. An uncapped +0.3 ramp from 0.1 always ENDS on 1.0: the retain
    // path runs 4 attempts (0.1/0.4/0.7/1.0 — fact_extraction.py passes
    // max_retries=llm_max_retries, DEFAULT_LLM_MAX_RETRIES=3), and a caller
    // taking `call()`'s own max_retries=10 default saturates by attempt 4.
    expect(dockerfile).toMatch(
      /0\.7, float\(call_kwargs\["temperature"\]\) \+ 0\.3/,
    );
    expect(dockerfile).not.toMatch(
      /1\.0, float\(call_kwargs\["temperature"\]\) \+ 0\.3/,
    );
    // Guard the identifier the patch body depends on.
    expect(dockerfile).toMatch(
      /assert s\.count\("call_kwargs = self\._build_common_kwargs\("\) >= 1,/,
    );
    // Post-replace re-assertions (verification-on-build), including a parse
    // check so a bad splice fails the build rather than the container.
    expect(dockerfile).toMatch(
      /assert t\.count\(ANCHOR\) == 0, "switchroom hindsight perturbed-JSON-retry patch: unpatched handler still present"/,
    );
    expect(dockerfile).toMatch(/^ast\.parse\(t\)$/m);
    expect(dockerfile).toMatch(
      /switchroom hindsight perturbed-JSON-retry patch: invalid-JSON retries now bypass the proxy response cache/,
    );
  });

  it("keeps the upstream #2968 graph-seed-reuse carry (assert-guarded, fail-loud)", () => {
    // TEMPORARY CARRY. Upstream merged b475f5cc to `main` on 2026-07-27, after
    // v0.8.5 (the digest pinned in this Dockerfile) was cut, so there is no
    // release to upgrade to. DELETE the block — and flip this test into a
    // `does NOT carry` guard alongside the other retired patches — the moment
    // the FROM digest resolves to v0.8.6 or newer.
    //
    // SCOPE: structural, not behavioural. Every assertion here is a substring
    // match, so it proves the patch is PRESENT, never that it RUNS. The
    // behavioural gate is tests/docker/hindsight-graph-seed-patch.test.ts,
    // which applies this block to the pinned image and asserts the derived
    // seed ids equal the dedicated query's. Do not treat this file as
    // sufficient.

    // The provenance header must survive edits: without the merge SHA and the
    // deletion condition, a future rebaser cannot tell an adopted carry from a
    // switchroom-original patch.
    expect(dockerfile).toMatch(
      /# ── UPSTREAM CARRY: vectorize-io\/hindsight PR #2968 ─+/,
    );
    expect(dockerfile).toMatch(/#   merge commit:   b475f5cc/);
    expect(dockerfile).toMatch(
      /# DELETE THIS BLOCK WHEN, and only when, the `FROM` digest above resolves to\n# upstream v0\.8\.6 or newer/,
    );

    // The exact-once anchor guard (fail-loud on upstream drift). Shared by all
    // five patched files via apply().
    expect(dockerfile).toMatch(
      /the \{label!r\} anchor was found \{n\}x \(expected 1\) in \{rel\}\./,
    );

    // The divergence guard. v0.8.5 hardcodes the graph seed floor; upstream
    // main reads it from config. If a future base introduces the config key,
    // the mirrored 0.3 would silently ignore the operator's setting, so the
    // build must fail rather than diverge.
    expect(dockerfile).toMatch(
      /assert "graph_seed_min_similarity" not in _cfg,/,
    );

    // The load-bearing derivation, both halves.
    expect(dockerfile).toMatch(
      / +graph_seed_min_similarity=GRAPH_SEED_MIN_SIMILARITY,\\n"/,
    );
    expect(dockerfile).toMatch(
      / +preselected_semantic_seeds=semantic_bm25_results\[ft\]\.graph_seeds,\\n"/,
    );

    // The CORRECTNESS GUARD is the reason this carry is safe at all: reuse is
    // declined whenever the semantic arm's floor is stricter than the graph
    // seed floor, because the shared pool would then be NARROWER than the
    // dedicated query's result. Hard-coding the threshold would keep every
    // other assertion green while silently quieting recall.
    expect(dockerfile).toMatch(
      /if graph_seed_min_similarity is not None and sem_min <= graph_seed_min_similarity/,
    );
    // ...and the trim must not be able to cut a seed out of the pool it feeds
    // (thinking_budget below GRAPH_SEED_LIMIT).
    expect(dockerfile).toMatch(
      /semantic_candidate_limit = max\(limit, GRAPH_SEED_LIMIT if graph_seed_threshold is not None else 0\)/,
    );
    // An EMPTY preselected list must NOT re-trigger the scan; only None does.
    expect(dockerfile).toMatch(/"            if preselected_semantic_seeds is None:\\n"/);

    // The index-served UUID lookup, and the tolerance it must preserve:
    // non-canonical ids matched nothing under `id::text` and must still match
    // nothing, so they are filtered out BEFORE the ::uuid cast (which would
    // otherwise raise 22P02 for the whole query).
    expect(dockerfile).toMatch(/"            WHERE id = ANY\(\\n"/);
    expect(dockerfile).toMatch(/SELECT input\.unit_id::uuid/);
    expect(dockerfile).toMatch(
      /WHERE input\.unit_id ~ '\^\[0-9a-f\]\{\{8\}\}-/,
    );
    expect(dockerfile).toMatch(
      /assert "id::text = ANY\(\$1\)" not in ops,/,
    );

    // Post-replace re-assertions (verification-on-build): a patch that applied
    // but landed inert must fail the build.
    expect(dockerfile).toMatch(
      /assert le\.count\("await _find_semantic_seeds\("\) == 1,/,
    );
    expect(dockerfile).toMatch(
      /assert 'grouped\.get\("observation", \(\[\], \[\]\)\)\[0\]' not in cons,/,
    );
    // The repo-wide sweep: a missed caller of the reshaped combined query is an
    // AttributeError on a live recall path, so it must be a build failure.
    expect(dockerfile).toMatch(/for _p in BASE\.rglob\("\*\.py"\):/);
    expect(dockerfile).toMatch(/assert not _stale,/);
    // Every patched file is re-parsed, so a bad splice fails the build rather
    // than the container.
    expect(dockerfile).toMatch(/^    ast\.parse\(s\)$/m);
  });

  it("keeps the consolidation-maxItems-grammar fix (assert-guarded, fail-loud)", () => {
    // `_build_response_model()` constrained `creates` with
    // `PydanticField(max_length=clamped)` where `clamped` is the bank's
    // REMAINING OBSERVATION-SLOT COUNT, so the request schema carried
    // `"maxItems": 4230` on this fleet. llama.cpp/Ollama compile that to GBNF
    // and a repetition count that large fails to build — HTTP 400 "Failed to
    // initialize samplers: failed to parse grammar" — after which LiteLLM's
    // router fallback re-sent the whole batch, verbatim private corpus text
    // included, to the METERED OpenRouter deployment (56 such fallbacks logged
    // for `Received Model Group=gpt-oss-20b-consolidation`, 2026-07-28).
    //
    // SCOPE: this test is structural, not behavioural. Every assertion below is
    // an unanchored substring match, so it proves the patch is PRESENT, never
    // that the number it emits is compilable — raising the ceiling to 100_000
    // keeps all of them green. The behavioural gate is
    // tests/docker/hindsight-maxitems-grammar-patch.test.ts, which applies this
    // block to the pinned image and reads the `maxItems` pydantic actually
    // serialises at a production-like 4,230. Do not treat this file as
    // sufficient.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight consolidation-maxItems-grammar patch/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: anchor found \{n\}x \(expected 1\) in \{rel\} — upstream "/,
    );
    // The ceiling, and the branch that omits the constraint above it. Omitting
    // beats clamping: a clamp moves the threshold and asserts a bound that is
    // not true, so `maxItems` would still be a number nobody can compile at
    // some other bank size.
    expect(dockerfile).toMatch(/SWITCHROOM_MAX_CREATES_SCHEMA_CEILING = 64\\n/);
    expect(dockerfile).toMatch(
      /if max_creates > SWITCHROOM_MAX_CREATES_SCHEMA_CEILING:\\n/,
    );
    // The premise that makes omission safe: the cap is still enforced in
    // Python after validation. If upstream ever drops that truncation, this
    // patch must fail the build rather than silently uncap observations.
    expect(dockerfile).toMatch(
      /assert "creates = creates\[:remaining_observation_slots\]" in new,/,
    );
    // The caller contract the whole defect hangs on.
    expect(dockerfile).toMatch(
      /assert new\.count\("_build_response_model\(max_creates=remaining_observation_slots\)"\) == 1,/,
    );
    // Post-replace re-assertions (verification-on-build): a patch that applied
    // but landed inert must fail the build.
    expect(dockerfile).toMatch(
      /assert new\.count\("SWITCHROOM_MAX_CREATES_SCHEMA_CEILING"\) == 2,/,
    );
    expect(dockerfile).toMatch(/assert new\.count\("max_length=clamped"\) == 1,/);
    expect(dockerfile).toMatch(
      /switchroom hindsight consolidation-maxItems-grammar patch: the consolidation /,
    );
  });

  it("keeps the reflect-directive-isolation fix (assert-guarded, fail-loud)", () => {
    // `reflect_async` loaded its directives with `isolation_mode=True`, and
    // `list_directives` turns that flag into a hard
    // `tags IS NULL OR tags = '{}'` filter whenever the caller supplied no
    // tags — so an untagged reflect (the common case) silently dropped every
    // directive carrying at least one tag, from the system prompt AND from
    // `directives_applied` in the trace. Measured on this fleet 2026-07-29:
    // 172 active directives, 94 untagged; 45% of the operator's standing rules
    // never reached a reflect prompt. switchroom #3967, upstream
    // vectorize-io/hindsight#1269 / #3031.
    //
    // SCOPE: structural, not behavioural. Every assertion below is an
    // unanchored substring match, so it proves the patch is PRESENT, never that
    // it LANDED. The behavioural gate is
    // tests/docker/hindsight-reflect-directives-patch.test.ts, which loads real
    // directives out of a real database with the kwargs reflect actually passes
    // and reads which ones reach the trace and the prompt. Do not treat this
    // file as sufficient.

    // The exact-once anchor guard (fail-loud on upstream drift), and the
    // instruction a future maintainer needs when it fires.
    expect(dockerfile).toMatch(
      /switchroom hindsight reflect-directive-isolation patch/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: anchor found \{n\}x \(expected 1\) in engine\/memory_engine\.py — upstream "/,
    );
    expect(dockerfile).toMatch(
      /"reformatted reflect's directive fetch; re-author this patch in "/,
    );
    // The splice itself: the flag reflect passes, and the now-inverted upstream
    // comment that would otherwise sit directly above it.
    expect(dockerfile).toMatch(/"            isolation_mode=True,\\n"/);
    expect(dockerfile).toMatch(/"            isolation_mode=False,\\n"/);
    expect(dockerfile).toMatch(
      /# Use isolation_mode=True to prevent tag-scoped directives from leaking into untagged operations\\n/,
    );
    // The premise that makes the flip NARROW: the flag is consulted only on the
    // no-tags path. If upstream widens that condition, flipping it would start
    // changing TAGGED reflects too, and the build must fail rather than ship it.
    expect(dockerfile).toMatch(
      /assert "if not tags and not tag_groups and isolation_mode:" in t,/,
    );
    // Post-replace re-assertions (verification-on-build): a patch that applied
    // but landed inert must fail the build.
    expect(dockerfile).toMatch(/assert "isolation_mode=True," not in t,/);
    expect(dockerfile).toMatch(
      /assert t\.count\("            isolation_mode=False,\\n        \)\\n"\) == 1,/,
    );
    // The scoping the flag is NOT replacing: a tagged reflect must still be
    // scoped by the untagged-OR-matching clauses.
    expect(dockerfile).toMatch(
      /assert t\.count\("f\\"\(\(tags IS NULL OR tags = '\{\{\}\}'\) OR \(\{scoped_clause\}\)\)\\""\) == 2,/,
    );
    // The patched file is re-parsed, so a bad splice fails the build rather
    // than the container.
    expect(dockerfile).toMatch(/^ast\.parse\(s\)$/m);
    expect(dockerfile).toMatch(
      /switchroom hindsight reflect-directive-isolation patch: reflect now loads TAGGED /,
    );
  });

  it("keeps the mcp-recall-token-budget fix (assert-guarded, fail-loud)", () => {
    // The MCP recall tool serialized with `model_dump_json(indent=2)` and no
    // `exclude_none`, while the engine's token budget costs only fact TEXT —
    // measured live, 6,079 bytes of fact text became 40,857 bytes on the wire
    // (6.7x), so `max_tokens: 1500` delivered ~3.5k tokens.
    //
    // SCOPE: structural, not behavioural. Every assertion below is an
    // unanchored substring match, so it proves the patch is PRESENT, never
    // that the payload actually fits the budget. The behavioural gate is
    // tests/docker/hindsight-recall-budget-reflect-grounding-patches.test.ts,
    // which drives the real registered MCP tool and measures the tokens it
    // returns. Do not treat this file as sufficient.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight mcp-recall-token-budget patch/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: \{name\} anchor found \{n\}x \(expected 1\) in mcp_tools\.py — upstream "/,
    );
    // The helper, its rollback knob, and both recall branches routed through it.
    expect(dockerfile).toMatch(/def _recall_payload_within_budget\(/);
    expect(dockerfile).toMatch(
      /_MCP_RECALL_BUDGET_MODE_ENV = "HINDSIGHT_MCP_RECALL_BUDGET_MODE"/,
    );
    expect(dockerfile).toMatch(
      /assert t\.count\("_recall_payload_within_budget\(recall_result, max_tokens\)"\) == 2,/,
    );
    // The legacy branch must keep upstream's exact serialization (the
    // restart-level rollback) …
    expect(dockerfile).toMatch(
      /assert "recall_result\.model_dump_json\(indent=2\)" in t,/,
    );
    // … and the LOAD-BEARING scope guards: the reflect tool and — above all —
    // the ENGINE's text-only selector stay untouched, because the per-turn
    // auto-recall hook injects only fact text and an envelope-costed shared
    // selector would silently shrink every auto-recall across the fleet.
    expect(dockerfile).toMatch(
      /assert "reflect_result\.model_dump_json\(indent=2\)" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "text_tokens = len\(encoding\.encode\(text\)\)" in me,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight mcp-recall-token-budget patch: MCP recall now serializes /,
    );
  });

  it("keeps the reflect-mm-relevance-floor fix (assert-guarded, fail-loud)", () => {
    // On low/mid budget, `_all_mental_models_are_usable_and_fresh` released
    // the forced search_observations/recall layers for ANY fresh non-empty
    // mental model — it never checked `relevance`, and the mental-model search
    // is unfloored top-K. So any bank holding one fresh model tripped the
    // short-circuit on EVERY query regardless of topic.
    //
    // SCOPE: structural, not behavioural. The behavioural gate is
    // tests/docker/hindsight-recall-budget-reflect-grounding-patches.test.ts,
    // which drives the real decision across the measured relevance bands.
    // Do not treat this file as sufficient.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight reflect-mm-relevance-floor patch/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: \{name\} anchor found \{n\}x \(expected 1\) in engine\/reflect\/agent\.py — "/,
    );
    // The measured floor and its env knob (0 disables = upstream gating).
    expect(dockerfile).toMatch(
      /_REFLECT_MM_RELEVANCE_FLOOR_DEFAULT: float = 0\.55/,
    );
    expect(dockerfile).toMatch(
      /_REFLECT_MM_RELEVANCE_FLOOR_ENV: str = "HINDSIGHT_REFLECT_MM_RELEVANCE_FLOOR"/,
    );
    // Post-replace re-assertions: the floor is computed AND consulted, and the
    // short-circuit call site it gates is still wired.
    expect(dockerfile).toMatch(
      /assert "floor = _reflect_mm_relevance_floor\(\)" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "if floor > 0\.0 and relevance < floor:" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert t\.count\("_all_mental_models_are_usable_and_fresh\(output\)"\) == 1,/,
    );
    expect(dockerfile).toMatch(
      /assert "stop_forcing_from_iteration = iteration \+ 1" in t,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight reflect-mm-relevance-floor patch: a fresh mental model may /,
    );
  });

  it("keeps the reflect-temperature fix (assert-guarded, fail-loud)", () => {
    // `DEFAULT_LLM_TEMPERATURE_REFLECT = 0.9` existed but NO agentic reflect
    // call site passed `temperature`, and the litellm provider omits the kwarg
    // when None — so factual synthesis sampled at the provider default (~1.0).
    // A 20B model at ~1.0 was observed inventing dates its own cited memory
    // contradicts.
    //
    // SCOPE: structural, not behavioural. The behavioural gate is
    // tests/docker/hindsight-recall-budget-reflect-grounding-patches.test.ts,
    // which counts the wired call sites in the shipping module's AST (0/7 on
    // upstream) and resolves the config default. Do not treat this file as
    // sufficient.

    // The exact-once anchor guards (fail-loud on upstream drift) for both
    // halves: the config default and the call-site threading.
    expect(dockerfile).toMatch(/switchroom hindsight reflect-temperature patch/);
    expect(dockerfile).toMatch(
      /f"\{TAG\}: reflect-temperature default anchor found \{n\}x \(expected 1\) in config\.py — "/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: anchor found \{n\}x \(expected \{expect\}\) in engine\/reflect\/agent\.py — "/,
    );
    // The new default, low for factual synthesis, still env-overridable.
    expect(dockerfile).toMatch(
      /DEFAULT_LLM_TEMPERATURE_REFLECT = 0\.1 {2}# reflect: factual synthesis \(switchroom\)/,
    );
    // Post-replace re-assertions: exactly 7 wired call sites (6x reflect + the
    // reflect_tool_call kwargs), the site count itself pinned, the structured
    // -extraction non-goal untouched, and the provider still forwarding.
    expect(dockerfile).toMatch(/assert n_temp == 7,/);
    expect(dockerfile).toMatch(
      /assert t\.count\('scope="reflect",'\) == 6,/,
    );
    expect(dockerfile).toMatch(
      /assert 'scope="reflect_structured",' in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "if temperature is not None:" in prov,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight reflect-temperature patch: llm_temperature_reflect is now /,
    );
  });

  it("preserves upstream's start-all.sh as the post-shim CMD", () => {
    // The shim does broker auth, then `exec "$@"` which is whatever
    // CMD docker passes — must be upstream's start-all.sh so the
    // image continues to behave like upstream once boot creds are in
    // place.
    expect(dockerfile).toMatch(/^CMD\s+\["\/app\/start-all\.sh"\]/m);
  });
});
