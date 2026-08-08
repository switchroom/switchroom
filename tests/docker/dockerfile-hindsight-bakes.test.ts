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
    // because the per-arch matrix pins `arch: ["amd64"]` on pull_request (the
    // arm64 leg on its native ubuntu-24.04-arm runner only fans out on a
    // main/tag/dispatch push), so only the amd64 leg is ever built there. This
    // assertion is therefore the only thing standing between that branch and
    // an untested regression, and it has to be airtight rather than indicative.
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

  it("bakes the text-search stopword source at the stable version-independent path", () => {
    // The entrypoint's provision_text_search() re-materializes this file into
    // the CURRENT embedded-pg install's share/tsearch_data on every boot. It
    // MUST live at a version-independent path (not inside a pg0 version dir) so
    // an embedded-pg version bump — which extracts a fresh install dir — cannot
    // orphan it and make every to_tsvector('hindsight_english', …) fail with
    // "could not open stop-word file". A stopword file is world-readable data,
    // so 0644 (not executable).
    expect(dockerfile).toMatch(
      /COPY\s+--chmod=0644\s+docker\/hindsight-extra\.stop\s+\/usr\/local\/lib\/switchroom\/hindsight_extra\.stop/,
    );
  });

  it("keeps the PG text-search recall-fallback fix (assert-guarded, fail-loud)", () => {
    // switchroom runs the native (Postgres) BM25 arms through a CUSTOM
    // text-search regconfig (HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE
    // = hindsight_english). When that regconfig is missing — a fresh/empty
    // volume that booted before the entrypoint provisioned it, or an embedded-pg
    // version bump that orphaned its stopword file — Postgres raises SQLSTATE
    // 42704 ("text search configuration ... does not exist") or "could not open
    // stop-word file". Upstream's retrieve_semantic_bm25_combined caught only
    // Oracle's DRG-10599/ORA-30600/ORA-29902 and re-`raise`d everything else, so
    // EVERY recall 500s — a total outage, not a degraded one. The patch widens
    // the existing dialect-agnostic semantic-only fallback (the Oracle branch
    // already built it) to also trip on the PG signatures, reusing the very same
    // rebuild. Behaviour is proven against the pinned upstream image in
    // tests/docker/hindsight-search-patches.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift), naming the
    // module and the re-author path.
    expect(dockerfile).toMatch(
      /switchroom hindsight PG text-search recall-fallback patch: anchor found \{n\}x/,
    );
    expect(dockerfile).toMatch(
      /\(expected 1\) in search\/retrieval\.py — upstream reformatted the BM25 try\/except/,
    );
    // The three trigger signatures, all load-bearing: the asyncpg SQLSTATE, the
    // stopword-file message, and the config-missing message (case-folded).
    expect(dockerfile).toMatch(
      /_pg_text_search_unavailable = getattr\(e, "sqlstate", None\) == "42704"/,
    );
    expect(dockerfile).toMatch(/"could not open stop-word file" in err_str/);
    expect(dockerfile).toMatch(
      /"text search configuration" in err_str\.lower\(\) and "does not exist" in err_str\.lower\(\)/,
    );
    // The pg_search (ParadeDB BM25) "no bm25 index" signature (follow-up to
    // #4470): SQLSTATE XX000 AND the stable, table-name-agnostic substring —
    // never XX000 alone (Postgres internal_error is a catch-all).
    expect(dockerfile).toMatch(
      /getattr\(e, "sqlstate", None\) == "XX000"\s*\n\s*and "does not contain a using bm25 index" in err_str\.lower\(\)/,
    );
    // The widened condition must be an OR onto the EXISTING Oracle guard — a
    // separate `if` could double-run the rebuild or diverge. Pin that the
    // Oracle codes and the new sentinel share one branch.
    expect(dockerfile).toMatch(
      /if _include_bm25 and \("DRG-10599" in err_str or "ORA-30600" in err_str or "ORA-29902" in err_str or _pg_text_search_unavailable\):/,
    );
    // Post-replace re-assertions (verification-on-build), including the
    // LOAD-BEARING one: the dialect-agnostic semantic-only rebuild the Oracle
    // branch already had must stay the SINGLE fallback path both branches reach —
    // the patch only widened its TRIGGER, it did not add a second rebuild.
    expect(dockerfile).toMatch(
      /assert "_pg_text_search_unavailable" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert 'getattr\(e, "sqlstate", None\) == "42704"' in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "could not open stop-word file" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert 'getattr\(e, "sqlstate", None\) == "XX000"' in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "does not contain a using bm25 index" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert t\.count\("rows = await conn\.fetch\(fb_query, \*fb_params\)"\) == 1,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight PG text-search recall-fallback patch: recall degrades to semantic-only/,
    );
  });

  it("keeps the pg_search tokenizer-drift guard (assert-guarded, fail-loud)", () => {
    // Epic #4474, finding C1. The stemmed/stopworded ParadeDB variant the fleet
    // needs for recall quality cannot be expressed through
    // HINDSIGHT_API_TEXT_SEARCH_EXTENSION_PG_SEARCH_TOKENIZER (_pg_search.py
    // takes a bare tokenizer NAME and emits an UNSTEMMED cast), so it can only
    // exist as hand-built DDL — and nothing upstream defends it: every
    // "does the index match the config" decision keys on the `key_field`
    // reloption alone (migrations.py:887) and never inspects the tokenizer.
    // The text_signals migration then DROPs and re-CREATEs the index on a
    // POPULATED memory_units from the config knob, silently reverting it to
    // unstemmed. Behaviour is proven against the pinned upstream image in
    // tests/docker/hindsight-pg-search-tokenizer-drift-patch.test.ts.

    // The exact-once anchor guard (fail-loud on upstream drift), naming the
    // file and the re-author path.
    expect(dockerfile).toMatch(
      /switchroom hindsight \{NAME\}: anchor found \{n\}x \(expected \{count\}\) in \{rel\}/,
    );

    // The three mechanisms, all load-bearing.
    // 1. expressibility is defined as a ROUND-TRIP through the same normalizer
    //    config uses, so the predicate can never drift from what config emits.
    expect(dockerfile).toMatch(
      /return normalize_pg_search_tokenizer\(cast\) == cast\.strip\(\)\.lower\(\)/,
    );
    // 2. the boot path compares tokenizers, not just key_field…
    expect(dockerfile).toMatch(/check_pg_search_tokenizer_drift\(/);
    // 3. …and every rebuild reads the PRE-EXISTING definition before dropping.
    expect(dockerfile).toMatch(/SELECT indexdef FROM pg_indexes /);
    expect(dockerfile).toMatch(/def pg_search_rebuild_bm25_columns\(/);

    // The stable, greppable operator signal.
    expect(dockerfile).toMatch(
      /PG_SEARCH_TOKENIZER_DRIFT_MARKER = "pg_search_tokenizer_drift"/,
    );

    // THE CRASH-LOOP CONSTRAINT, pinned. ensure_text_search_extension runs on
    // EVERY boot and already raises RuntimeError on a schema mismatch with data
    // present (migrations.py:768 → :922 → :940); a guard that raised there
    // would take the SEMANTIC arm down alongside the keyword one — a full
    // memory outage, strictly worse than the silent degradation being fixed.
    // Both halves are pinned: the guard body carries no `raise` statement, and
    // migrations.py's RuntimeError count is unchanged by the patch.
    expect(dockerfile).toMatch(
      /assert not _raises, f"switchroom hindsight \{NAME\}: guard body contains a raise statement/,
    );
    expect(dockerfile).toMatch(
      /assert m\.count\("raise RuntimeError\("\) == 9,/,
    );

    // Post-replace re-assertions (verification-on-build): both rebuild call
    // sites in each patched file must be the rebuild-aware builder, with no
    // config-only call site left behind.
    expect(dockerfile).toMatch(
      /assert m\.count\("pg_search_rebuild_bm25_columns\("\) == 2,/,
    );
    expect(dockerfile).toMatch(
      /assert m\.count\("pg_search_bm25_columns\("\) == 0,/,
    );
    expect(dockerfile).toMatch(
      /assert a\.count\("pg_search_rebuild_bm25_columns\("\) == 2,/,
    );
    expect(dockerfile).toMatch(
      /assert a\.count\("pg_search_bm25_columns\("\) == 0,/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight pg_search tokenizer-drift guard: rebuilds preserve an inexpressible tokenizer/,
    );

    // #4478: a rebuild must re-emit the pushdown filter columns on BOTH
    // branches, or the tokenizer fix silently un-does the pushdown fix.
    expect(dockerfile).toMatch(
      /filter_fields = pg_search_filter_fields\(table\)/,
    );
  });

  it("keeps the pg_search BM25 filter-field pushdown (assert-guarded, fail-loud)", () => {
    // Epic #4474, phase P4 (#4478). Upstream indexes only (id, text, context
    // [, text_signals]), so ParadeDB cannot push the recall arm's
    // `bank_id = $n AND fact_type = '<lit>'` into the Tantivy scan — it
    // degrades them to a post-scoring heap_filter and every keyword arm scores
    // the WHOLE table. Measured on an 800k-row corpus: 171,517 shared buffer
    // hits per arm uncorrected vs 405 corrected (423x), and the uncorrected
    // index runs 2-10x SLOWER than the native tsvector+GIN comparator.
    // RESULTS are identical either way, so nothing but a plan or a latency
    // chart can see the defect — which is why this needs a pinned guard.
    // Behaviour is proven against the pinned upstream image in
    // tests/docker/hindsight-pg-search-filter-pushdown-patch.test.ts.

    // 1. the field map, scoped to the one table with a `@@@` arm.
    expect(dockerfile).toMatch(
      /PG_SEARCH_FILTER_FIELDS: dict\[str, tuple\[str, \.\.\.\]\] = \{/,
    );
    expect(dockerfile).toMatch(/"memory_units": \("bank_id", "fact_type"\),/);

    // 2. THE LOAD-BEARING CONSTRAINT: the filter cast is the `literal`
    //    tokenizer, hard-coded, never the configured text tokenizer. Equality
    //    pushdown needs the whole column value to be one token, so a stemmed /
    //    ngram / lindera cast here stops the predicate matching AT ALL — i.e.
    //    empty keyword recall, not merely slow keyword recall.
    expect(dockerfile).toMatch(/PG_SEARCH_FILTER_TOKENIZER = "literal"/);
    expect(dockerfile).toMatch(
      /assert "normalized" not in _filter_col_body, \(/,
    );

    // 3. both helpers, and the builder's new optional parameter (optional so
    //    every upstream call site keeps its exact upstream output).
    expect(dockerfile).toMatch(/def pg_search_filter_fields\(/);
    expect(dockerfile).toMatch(/def pg_search_filter_columns\(/);
    expect(dockerfile).toMatch(/filter_fields: Sequence\[str\] = \(\),/);

    // 4. the fresh-install create site actually requests them — the one
    //    memory_units BM25 create site the tokenizer-drift block does not own.
    expect(dockerfile).toMatch(/pg_search_filter_fields\("memory_units"\)/);

    // 5. NEGATIVE GUARD, deliberate: the query is NOT rewritten. #4478's
    //    original plan folded bank_id/fact_type into paradedb.boolean(must =>
    //    ...), which EXPLAIN showed is unnecessary — ParadeDB absorbs the plain
    //    SQL WHERE once the columns carry the literal tokenizer. engine/sql/
    //    postgresql.py stays untouched; if a patch ever starts rewriting the
    //    arm, that is a re-litigation of a measured decision.
    //    Comment lines are stripped first: the block's own header EXPLAINS the
    //    rejected design, and the guard is about emitted code, not prose.
    const dockerfileCode = dockerfile
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(dockerfileCode).not.toMatch(/paradedb\.boolean\(\s*must\s*=>/);

    // 6. the build FAILS if upstream grows a second search arm the field map
    //    does not cover, rather than shipping an index that cannot push it down.
    expect(dockerfile).toMatch(
      /_arm_tables = set\(re\.findall\(r"paradedb\\\.match\\\('\(\\w\+\)'", _pg_sql\)\)/,
    );
    expect(dockerfile).toMatch(
      /assert _pg_sql\.count\("id @@@ paradedb\.boolean\("\) == 1,/,
    );
    expect(dockerfile).toMatch(
      /assert _pg_sql\.count\("WHERE bank_id = \{bank_id_param\}"\) == 2,/,
    );

    // 7. the boot-path detector exists and is LOG-ONLY. Repairing a live index
    //    on the boot path is the #4474/C2 fail-closed window (a DROP/CREATE on
    //    a populated memory_units), and a raise there would take the semantic
    //    arm down with the keyword one.
    expect(dockerfile).toMatch(
      /PG_SEARCH_FILTER_FIELD_DRIFT_MARKER = "pg_search_filter_field_drift"/,
    );
    expect(dockerfile).toMatch(/def check_pg_search_filter_field_drift\(/);

    // 8. the stable operator signal.
    expect(dockerfile).toMatch(
      /switchroom hindsight pg_search filter-field pushdown: bank_id\/fact_type indexed as pdb\.literal fast fields/,
    );
  });

  it("keeps the text-search backend migration-path fix (assert-guarded, fail-loud)", () => {
    // #4506. Five defects in `ensure_text_search_extension`, all OBSERVED in a
    // rehearsal against a clone of the live 801,792-row memory_units.
    // Behaviour is proven against the pinned upstream image in
    // tests/docker/hindsight-text-search-migration-patch.test.ts; this pins the
    // shape so a silent removal cannot ship.

    // D1a. THE LOAD-BEARING CONSTRAINT: the data guard fires only when the
    //      column type must genuinely change AND the target backend reads the
    //      column's contents. Keyed on the (column, index) PAIR — as upstream
    //      did — a merely-dropped index over a surviving column is fatal on
    //      EVERY backend, including the one already in use, and the error's own
    //      "set it back" advice cannot work. That was a one-way trapdoor.
    expect(dockerfile).toMatch(
      /target_search_vector_is_content = text_search_extension not in \(/,
    );
    expect(dockerfile).toMatch(
      /if column_recreate_needed and target_search_vector_is_content:/,
    );

    // D1b. …and the rebuild path must not drop a correctly typed, POPULATED
    //      column. `search_vector` is recreated EMPTY and only ever written on
    //      INSERT, so an unconditional DROP on an index-only rebuild is silent
    //      data loss in its own right.
    expect(dockerfile).toMatch(
      /if current_col_type and current_col_type != target_column_type:/,
    );

    // D2. the pg_search branch installs its own extension. Without this the
    //     BM25 CREATE INDEX dies on `schema "pdb" does not exist`, because
    //     nothing else in the boot path ever creates it (the entrypoint stages
    //     the .so only, by design).
    expect(dockerfile).toMatch(
      /CREATE EXTENSION IF NOT EXISTS pg_search CASCADE/,
    );
    expect(dockerfile).toMatch(
      /assert _branch\.index\("CREATE EXTENSION IF NOT EXISTS pg_search"\) < _branch\.index\("USING bm25"\)/,
    );
    // D2b. …and it is NOT wrapped in upstream's pgroonga-style "already exists /
    //      no permission" fallback. `IF NOT EXISTS` makes that probe unreachable
    //      as a suppressor, and the reconcile runs in ONE implicit transaction —
    //      so on a real failure the probe fires on an already-aborted
    //      transaction and buries the actual ParadeDB error under "current
    //      transaction is aborted". That is exactly the diagnostic an operator
    //      needs when prestart_pg0 (best-effort, `|| true`) left
    //      shared_preload_libraries=pg_search ineffective.
    expect(dockerfile).not.toMatch(
      /except Exception:\s*\n\s*has_ext = conn\.execute\(text\("SELECT 1 FROM pg_extension WHERE extname = 'pg_search'"\)\)/,
    );
    expect(dockerfile).toMatch(
      /assert "SELECT 1 FROM pg_extension WHERE extname = 'pg_search'" not in m, \(/,
    );

    // D3. the second memory table is reconciled under the name it actually has
    //     (alembic t5o6p7q8r9s0 renamed reflections -> mental_models), and the
    //     dead name is gone from the source entirely.
    expect(dockerfile).toMatch(/"mental_models",\s+# renamed from `reflections`/);
    expect(dockerfile).toMatch(/assert '"reflections",' not in m, \(/);

    // D4. the detector never reports a backend it cannot read.
    expect(dockerfile).toMatch(
      /indeterminate \(TEXT search_vector, no text-search index\)/,
    );

    // the stable operator signal.
    expect(dockerfile).toMatch(
      /switchroom hindsight text-search backend migration path: reconciles mental_models/,
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
    // Anchored on the LEADING underscore of the switchroom constant names, so
    // they cannot be satisfied-by-accident by upstream's own
    // HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY (v0.8.6+), which legitimately
    // appears in this file now that the #2968 carry is retired.
    expect(dockerfile).not.toMatch(/(?<![A-Za-z0-9])_GRAPH_SEED_LIMIT/);
    expect(dockerfile).not.toMatch(/(?<![A-Za-z0-9])_GRAPH_SEED_MIN_SIMILARITY/);
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

  it("keeps the work-conserving recall-admission gate (assert-guarded, fail-loud)", () => {
    // v2 of the admission split: the strict reservation above fixed foreground
    // starvation but capped background at consolidation_recall_max_concurrent
    // even with ZERO foreground waiters, so a large consolidation drain crawled
    // at 2/8 of the admission budget (~23h measured). The gate block replaces
    // the two-semaphore reservation with ONE work-conserving priority gate:
    // foreground first, background borrows every idle slot, old reservation
    // kept as background's guaranteed floor. Behaviour (RED on the strict
    // reservation AND on upstream, GREEN patched) is proven in
    // tests/docker/hindsight-work-conserving-admission-patch.test.ts.

    // The exact-once anchor guard (fail-loud on drift of the split block's
    // output, which is this block's anchor set).
    expect(dockerfile).toMatch(
      /switchroom hindsight work-conserving-admission patch: anchor found \{n\}x/,
    );
    // The gate class and its borrow predicate — the two clauses ARE the fix:
    // idle borrowing (work-conserving) and the background floor (no
    // starvation in either direction).
    expect(dockerfile).toMatch(/"class _RecallAdmissionGate:\\n"/);
    expect(dockerfile).toMatch(/"    def _bg_may_admit\(self\) -> bool:\\n"/);
    expect(dockerfile).toMatch(/"        if not self\._fg_waiters:\\n"/);
    expect(dockerfile).toMatch(
      /"        return self\._background_active < self\._background_reservation\\n"/,
    );
    // The floor-first grant pass in _wake — without it the floor clause above
    // is dead code under contention (an ungranted foreground waiter implies
    // active == total at all times, so a foreground-first pass re-takes every
    // freed slot and background starves to zero under sustained foreground
    // pressure). Pinned as code AND as a build assert.
    expect(dockerfile).toMatch(
      /"            if self\._background_active >= self\._background_reservation:\\n"/,
    );
    expect(dockerfile).toMatch(
      /the floor-first grant pass is /,
    );
    expect(dockerfile).toMatch(
      /the floor clause alone is unreachable under contention/,
    );
    // Cancellation safety, asyncio.Semaphore style: a waiter granted and
    // cancelled in the same tick hands its slot back, a departing foreground
    // waiter re-runs the grant pass so background borrowing cannot stay
    // latched off, and release is fully SYNCHRONOUS (no await between
    // "recall finished" and "slot returned", so a cancellation delivered
    // during teardown cannot leak a slot).
    expect(dockerfile).toMatch(/"                self\._release\(is_background\)\\n"/);
    expect(dockerfile).toMatch(/"                self\._wake\(\)\\n"/);
    expect(dockerfile).toMatch(
      /assert "    def _release\(self, is_background: bool\) -> None:" in me,/,
    );
    expect(dockerfile).toMatch(/assert "async def _release" not in me,/);
    // The call site, ARGUMENT pinned: admit(False) would silently revert the
    // priority split while every other check stays green.
    expect(dockerfile).toContain(
      '"            async with self._recall_admission_gate.admit(_background):\\n"',
    );
    // Post-replace re-assertions: the strict helper and BOTH old semaphores
    // are fully retired (no bypass path), the borrow + floor clauses exist,
    // and every #4212/#4213 string present before the edit survives it.
    expect(dockerfile).toMatch(
      /assert "async def _recall_admission\(" not in me,/,
    );
    expect(dockerfile).toMatch(/assert "_search_semaphore" not in me,/);
    expect(dockerfile).toMatch(
      /assert "class _RecallAdmissionGate:" in me,/,
    );
    expect(dockerfile).toMatch(
      /assert \(token in me\) == \(token in me_before\),/,
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight work-conserving-admission patch: recall admission is now a/,
    );
    // Order coupling: the gate block must follow BOTH the split block (its
    // anchors are that block's output) and the #3142\/#4212 block (whose
    // post-conditions still expect the semaphore this block retires).
    const splitAt = dockerfile.indexOf(
      "switchroom hindsight recall-admission-split patch",
    );
    const rerankAt = dockerfile.indexOf(
      "switchroom #3142: foreground-priority lane",
    );
    const gateAt = dockerfile.indexOf(
      "switchroom hindsight work-conserving-admission patch",
    );
    expect(splitAt).toBeGreaterThan(-1);
    expect(rerankAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(splitAt);
    expect(gateAt).toBeGreaterThan(rerankAt);
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

  it("does NOT carry the retired upstream #2968 graph-seed-reuse carry", () => {
    // RETIRED in the v0.8.5 -> v0.8.6 base bump. v0.8.6 contains upstream merge
    // b475f5cc natively, so the carry's own stated exit condition ("DELETE THIS
    // BLOCK WHEN ... the FROM digest resolves to v0.8.6 or newer") is met. It
    // self-detected the bump: its `graph_seed_min_similarity not in _cfg`
    // assertion fired against the 0.8.6 image, exactly as designed.
    //
    // Asserted ABSENT rather than merely deleted: re-adding it on a later
    // rebase would double-apply on top of the native implementation.
    expect(dockerfile).not.toMatch(/# ── UPSTREAM CARRY: vectorize-io\/hindsight PR #2968/);
    expect(dockerfile).not.toMatch(/merge commit: {3}b475f5cc/);
    expect(dockerfile).not.toMatch(/preselected_semantic_seeds/);
    expect(dockerfile).not.toMatch(/assert "graph_seed_min_similarity" not in _cfg,/);
    expect(dockerfile).not.toMatch(/GRAPH_SEED_LIMIT = /);

    // The behaviour the carry pinned must NOT become "whatever upstream's
    // default is". The carry mirrored v0.8.5's hardcoded 0.3; switchroom now
    // emits the key explicitly instead (src/setup/hindsight-perf-defaults.ts,
    // HINDSIGHT_DEFAULT_GRAPH_SEED_MIN_SIMILARITY), and the retirement note in
    // the Dockerfile has to say so or the next reader cannot tell an adopted
    // carry from an abandoned one.
    expect(dockerfile).toMatch(/# ── RETIRED IN THE v0\.8\.5 -> v0\.8\.6 BASE BUMP/);
    expect(dockerfile).toMatch(/HINDSIGHT_API_GRAPH_SEED_MIN_SIMILARITY/);
  });

  it("does NOT carry the retired consolidation-maxItems-grammar patch", () => {
    // RETIRED in the v0.8.5 -> v0.8.6 base bump. v0.8.6 adds
    // `_build_response_model(..., supports_max_items: bool = True)` driven by
    // HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS, which omits the `maxItems` schema
    // hint entirely when false — so the GBNF-compilation failure that pushed
    // verbatim private corpus text to a METERED provider is now fixable by
    // configuration. switchroom emits the key on the local-LLM path; see
    // HINDSIGHT_DEFAULT_LLM_SUPPORTS_MAX_ITEMS.
    //
    // Asserted ABSENT: the patch's anchor no longer exists on 0.8.6 (verified —
    // it fails with `anchor found 0x`), so re-adding it would break the build,
    // and its ceiling constant would be a second, drifting opinion about a
    // behaviour upstream now owns.
    expect(dockerfile).not.toMatch(/switchroom hindsight consolidation-maxItems-grammar patch/);
    expect(dockerfile).not.toMatch(/SWITCHROOM_MAX_CREATES_SCHEMA_CEILING/);
    expect(dockerfile).not.toMatch(/max_length=clamped/);

    // The replacement has to be named where the patch used to be, or the next
    // reader sees a deleted egress control and no successor.
    expect(dockerfile).toMatch(/HINDSIGHT_API_LLM_SUPPORTS_MAX_ITEMS/);
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
    expect(dockerfile).toMatch(/"                isolation_mode=True,\\n"/);
    expect(dockerfile).toMatch(/"                isolation_mode=False,\\n"/);
    // v0.8.6 wrapped the fetch in `if apply_all_directives: / else:`. This
    // patch flips the ELSE (default) branch only; the opt-in branch is left
    // byte-for-byte upstream, and the build asserts it still exists.
    expect(dockerfile).toMatch(
      /# Scope directives like memories: untagged directives always apply, tagged\\n/,
    );
    expect(dockerfile).toMatch(
      /assert "        if apply_all_directives:\\n" in t,/,
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
      /assert t\.count\("                isolation_mode=False,\\n            \)\\n"\) == 2,/,
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
    // The legacy branch must keep upstream's exact returns on BOTH branches
    // (the restart-level rollback): model_dump_json(indent=2) on the
    // bank_id-param branch, model_dump() python objects — no JSON round-trip —
    // on the single-bank branch …
    expect(dockerfile).toMatch(
      /assert "recall_result\.model_dump_json\(indent=2\)" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "return recall_result\.model_dump\(\)" in t,/,
    );
    // … the trim must prune source_facts by the retained results'
    // source_fact_ids (source_facts is keyed by SOURCE FACT id — a disjoint
    // id space from result ids; keying on result ids deletes the source facts
    // of RETAINED observations) …
    expect(dockerfile).toMatch(
      /assert "for fid in \(r\.source_fact_ids or \[\]\)" in t,/,
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
    // Post-replace re-assertions: exactly 6 wired call sites (5x reflect + the
    // reflect_tool_call kwargs), the site count itself pinned, the structured
    // -extraction non-goal untouched, and the provider still forwarding.
    // v0.8.6 deleted the mid-loop budget-rewrite call site, so both counts
    // dropped by one; they are asserted exactly so the next upstream change
    // fails the build instead of leaving a site at the provider default.
    expect(dockerfile).toMatch(/assert n_temp == 6,/);
    expect(dockerfile).toMatch(
      /assert t\.count\('scope="reflect",'\) == 5,/,
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

  it("keeps the MM-refresh-debounce fix (assert-guarded, fail-loud)", () => {
    // Upstream refreshes every `refresh_after_consolidation: true` mental
    // model at the end of EVERY completed consolidation operation, gated only
    // by "any in-scope memory since last_refreshed_at" — always true under
    // sustained ingestion. Measured 2026-08-01 (llm_requests): finn's 4
    // models refreshed 1,902x in one day (20.77M tokens); fleet-wide 3,003
    // refresh calls / 36.6M tokens. The patch floors the interval between
    // consolidation-triggered refreshes of one model.
    //
    // SCOPE: structural, not behavioural. The behavioural gate is
    // tests/docker/hindsight-mm-refresh-debounce-patch.test.ts, which runs
    // the shipping `_trigger_mental_model_refreshes` and asserts which
    // candidates are actually submitted. Do not treat this file as
    // sufficient.
    expect(dockerfile).toMatch(/switchroom hindsight MM-refresh-debounce patch/);
    // Exact-once anchor guards for both halves (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /f"\{TAG\}: _trigger_mental_model_refreshes def anchor found \{n\}x \(expected 1\) in "/,
    );
    expect(dockerfile).toMatch(
      /f"\{TAG\}: staleness-loop anchor found \{n\}x \(expected 1\) in "/,
    );
    // The helper's safety shape: NULL last_refreshed_at is never debounced,
    // and interval <= 0 short-circuits to exact upstream behaviour.
    expect(dockerfile).toMatch(/if _MM_REFRESH_MIN_INTERVAL_S <= 0\.0:/);
    expect(dockerfile).toMatch(/if not last:/);
    // A bad value degrades to the default, never raises out of consolidation.
    expect(dockerfile).toMatch(/except \(TypeError, ValueError\):/);
    expect(dockerfile).toMatch(/if not math\.isfinite\(value\) or value < 0\.0:/);
    // The debounce is consulted BEFORE the staleness round-trip.
    expect(dockerfile).toMatch(/if _mm_refresh_debounced\(candidate\):/);
    // Post-replace re-assertions (verification-on-build).
    expect(dockerfile).toMatch(
      /assert t\.count\("if _mm_refresh_debounced\(candidate\):"\) == 1,/,
    );
    expect(dockerfile).toMatch(/assert t\.count\(LOOP_ANCHOR\) == 0,/);

    // …and the knob the image reads must be one switchroom can actually set.
    // `resolveHindsightPerfOverrides` drops any key outside
    // HINDSIGHT_PERF_ENV_KEYS silently, and the patch reads this var once at
    // import, so an unmanaged name here is a documented escape hatch that
    // cannot be reached from switchroom.yaml at all. Derive the name from the
    // Dockerfile rather than restating it, so the two cannot drift apart.
    const envName = dockerfile.match(
      /_MM_REFRESH_MIN_INTERVAL_ENV: str = "([A-Z0-9_]+)"/,
    )?.[1];
    expect(envName, "the patch must name its env knob").toBeDefined();
    expect(
      HINDSIGHT_PERF_ENV_KEYS.has(envName!),
      `${envName} is read by the baked patch but is not in HINDSIGHT_PERF_ENV_KEYS, ` +
        "so a hindsight.env line for it is discarded before it reaches the container",
    ).toBe(true);
  });

  it("keeps the reranker-foreground-priority fix #3142 (assert-guarded, fail-loud)", () => {
    // Carries upstream vectorize-io/hindsight PR #3142 (OPEN — a source fork
    // patch, not an adopted-upstream retire). Reranking is CPU-bound in a fixed
    // thread pool; upstream drains ONE FIFO queue, so an interactive
    // (foreground) rerank waits behind the wall of background reranks
    // consolidation/reflect fan out. The patch swaps ThreadPoolExecutor for a
    // _PriorityRerankExecutor (PriorityQueue ordered (priority, seq);
    // foreground jumps ahead of queued background, never preempts a running
    // one) and threads a `background` flag from the recall call site through
    // rerank() to every provider's predict().
    //
    // SCOPE: structural, not behavioural. The behavioural gate is
    // tests/docker/hindsight-search-patches.test.ts, which applies the block to
    // the real image and probes _PriorityRerankExecutor ordering + that a
    // background rerank still resolves. Do not treat this file as sufficient.
    expect(dockerfile).toMatch(
      /switchroom #3142: foreground-priority lane for the local cross-encoder pool/,
    );
    // The fail-loud anchor-drift message names the re-author path.
    expect(dockerfile).toMatch(
      /switchroom #3142 reranker-foreground-priority patch: anchor found \{n\}x/,
    );
    expect(dockerfile).toMatch(
      /re-author this patch in docker\/Dockerfile\.hindsight/,
    );
    // The three files it patches, by their in-image paths.
    expect(dockerfile).toContain(
      "/app/api/hindsight_api/engine/cross_encoder.py",
    );
    expect(dockerfile).toContain(
      "/app/api/hindsight_api/engine/search/reranking.py",
    );
    expect(dockerfile).toContain(
      "/app/api/hindsight_api/engine/memory_engine.py",
    );
    // The new executor class + the 14-way count-asserted predict-signature edit.
    expect(dockerfile).toContain("class _PriorityRerankExecutor:");
    expect(dockerfile).toMatch(
      /async def predict\(self, pairs: list\[tuple\[str, str\]\], \*, background: bool = False\) -> list\[float\]:/,
    );
    // #4212 dual-signal reconciliation: the rerank call site no longer derives
    // priority from RequestContext.internal ALONE. It routes through a module-level
    // helper that folds in the admission `_background` signal (threaded down from
    // recall_async) so a background-admitted recall can never rerank as foreground.
    expect(dockerfile).toContain(
      "def _reconcile_rerank_priority(_background: bool, request_context) -> bool:",
    );
    expect(dockerfile).toContain("return bool(_background or internal)");
    expect(dockerfile).toContain(
      "background_rerank = _reconcile_rerank_priority(_background, request_context)",
    );
    // `_background` is threaded into _search_with_retries and forwarded at the call site.
    expect(dockerfile).toContain("_background=_background,  # switchroom #4212");
    // The harmful-direction warning must be baked (fires when _background is set
    // without the internal context — the one divergence that starves interactive reranks).
    expect(dockerfile).toContain(
      "background-admitted recall would rerank as foreground",
    );
    // The pre-reconciliation single-signal derivation must be GONE as an injection —
    // the build's own post-condition asserts its absence in the patched source.
    expect(dockerfile).toContain(
      'assert "background_rerank = bool(request_context is not None and request_context.internal)" not in me',
    );
    // #4213: the reranker pool teardown classmethod + its wiring into close().
    expect(dockerfile).toContain(
      "def shutdown_executor(cls, wait: bool = True) -> None:",
    );
    expect(dockerfile).toContain(
      "await asyncio.to_thread(LocalSTCrossEncoder.shutdown_executor)",
    );
    // Build-time post-conditions gate #4212/#4213 presence in the patched source.
    expect(dockerfile).toMatch(
      /_reconcile_rerank_priority\(_background, request_context\)" in me, "switchroom #4212/,
    );
    expect(dockerfile).toMatch(
      /asyncio\.to_thread\(LocalSTCrossEncoder\.shutdown_executor\)" in me, "switchroom #4213/,
    );
    // Post-replace verification-on-build: full surface present, exact-14, and
    // both orthogonal switchroom-local mods asserted to SURVIVE the patch
    // (a re-ordered future patch that drops either fails the build here).
    // 14 predict() signatures at v0.8.6, 15 at v0.9.0: upstream added
    // MultiCrossEncoder (the reranker failover chain), whose predict() shares
    // the signature line. The EXACT count is the drift detector — a range would
    // stop catching an upstream reranker that never learns `background`.
    expect(dockerfile).toContain(
      'assert ce.count("*, background: bool = False) -> list[float]:") == 15',
    );
    // v0.9.0 only: MultiCrossEncoder sits BETWEEN the engine and the member that
    // owns the foreground-priority pool. Without this forward it would accept
    // `background` and drop it, silently reinstating the bug #3142 fixes behind
    // a chain that still type-checks.
    expect(dockerfile).toContain(
      "scores = await member.predict(pairs, background=background)",
    );
    expect(dockerfile).toContain(
      'assert ce.count("await member.predict(pairs)") == 0',
    );
    expect(dockerfile).toMatch(
      /_background_search_semaphore" in me, "switchroom recall-admission-split mod lost/,
    );
    expect(dockerfile).toMatch(
      /_boost_authority\(" in rr and "measured cross-encoder saturation" in rr/,
    );
    // The patch reads NO env var (nothing to reconcile against
    // HINDSIGHT_PERF_ENV_KEYS): the behaviour is unconditional, so assert the
    // absence of a knob rather than leaving a silent gap.
    const blockStart = dockerfile.indexOf(
      "# --- switchroom #3142: foreground-priority lane",
    );
    const blockEnd = dockerfile.indexOf("\nPYEOF", blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    expect(dockerfile.slice(blockStart, blockEnd)).not.toMatch(
      /os\.environ|getenv|HINDSIGHT_[A-Z0-9_]+_ENV/,
    );
  });

  it("RETIRED the temporal-language patch at v0.9.0, leaving no residue", () => {
    // switchroom #4313 pinned dateparser's `languages=` with an image patch
    // because upstream auto-detected across 200+ locales inline on the shared
    // asyncio loop (99.8ms/call vs 0.6ms pinned, ~165x; 128 loop blocks/20min).
    // Upstream #3154 (v0.9.0) implements the same pin natively, so the block was
    // DELETED rather than rebased — carrying both would be a duplicate knob.
    //
    // What replaces it is NOT in this file: switchroom emits
    // HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES=en as an always-on default
    // (src/setup/hindsight-perf-defaults.ts). Upstream's default is None = the
    // slow auto-detect, so the emission — not the image — is now what buys the
    // speedup. These assertions exist so a revert of the deletion reds here.
    // Assert on the CODE the block emitted, not on the name: the retirement
    // note deliberately still says "HINDSIGHT_API_TEMPORAL_LANGUAGES" in prose,
    // and a test that banned the string would only teach people to delete the
    // explanation.
    expect(dockerfile).not.toContain(
      'ENV_TEMPORAL_LANGUAGES = "HINDSIGHT_API_TEMPORAL_LANGUAGES"',
    );
    expect(dockerfile).not.toContain('DEFAULT_TEMPORAL_LANGUAGES = "en"');
    expect(dockerfile).not.toContain("temporal_languages=_parse_str_list(");
    expect(dockerfile).not.toContain("_resolve_temporal_languages()");
    expect(dockerfile).not.toContain("languages=self._languages");
    expect(dockerfile).not.toMatch(/temporal-language patch: anchor found/);

    // The tombstone stays: the next person to read this file must find out WHY
    // the block is absent and that an env emission is load-bearing, not infer
    // that the pin was simply dropped.
    expect(dockerfile).toContain(
      "# --- RETIRED (v0.9.0): switchroom #4313 dateparser language pin ---",
    );
    expect(dockerfile).toContain("HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES");
  });

  it("keeps the temporal-offload fix (assert-guarded, fail-loud)", () => {
    // dateparser.search_dates() ran synchronously on the shared asyncio loop
    // from retrieve_all_fact_types_parallel() — 186 EVENT LOOP BLOCKED events in
    // 4.5h, max 14.95s, driven by multi-KB consolidation queries. The patch
    // offloads it to a single-worker ThreadPoolExecutor and bounds its input
    // with HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS (default 2000).

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /switchroom hindsight temporal-offload patch: anchor found \{n\}x/,
    );

    // The config.py char-cap knob, wired end to end.
    expect(dockerfile).toContain(
      'ENV_TEMPORAL_MAX_QUERY_CHARS = "HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS"',
    );
    expect(dockerfile).toContain("DEFAULT_TEMPORAL_MAX_QUERY_CHARS = 2000");
    expect(dockerfile).toContain("    temporal_max_query_chars: int");
    expect(dockerfile).toContain(
      "temporal_max_query_chars=_parse_non_negative_int(",
    );

    // The off-loop machinery: a DELIBERATELY single-worker executor and an
    // async wrapper that offloads via run_in_executor.
    expect(dockerfile).toContain(
      'ThreadPoolExecutor(max_workers=1, thread_name_prefix="hindsight-temporal")',
    );
    expect(dockerfile).toContain(
      "async def extract_temporal_constraint_async(",
    );
    expect(dockerfile).toContain("loop.run_in_executor(");
    // The single async call site now awaits the off-loop wrapper.
    // v0.9.0 moved this call site inside upstream's `if enable_temporal_retrieval:`
    // block and wrapped it across lines, so match the wrapped form.
    expect(dockerfile).toContain(
      'await extract_temporal_constraint_async(\\n"\n        "            query_text',
    );

    // The analyzer truncates its input before search_dates.
    expect(dockerfile).toContain(
      "search_query = search_query[: self._max_query_chars]",
    );

    // The locale pin MUST survive the truncation. At v0.9.0 it arrives via
    // upstream's shared `_search_kwargs()` helper (#3154) rather than our
    // retired `languages=self._languages`, so the truncated call must still
    // SPREAD it — losing the spread silently restores the 200+-locale
    // auto-detect with no error anywhere.
    expect(dockerfile).toContain(
      "self._search_dates(search_query, settings=settings, **self._search_kwargs())",
    );
    expect(dockerfile).toMatch(
      /search_dates call no longer spreads \*\*self\._search_kwargs\(\)/,
    );
    // Warm-up and analyze() must resolve the same locale set.
    expect(dockerfile).toContain(
      'assert \'self._search_dates("today", **self._search_kwargs())\' in qa',
    );
    // The knob switchroom now emits must still be parsed by config.py — if
    // upstream ever drops it, the emitted `en` becomes a no-op, which is the
    // 165x regression wearing a green build.
    expect(dockerfile).toContain(
      'ENV_QUERY_ANALYZER_LANGUAGES = "HINDSIGHT_API_QUERY_ANALYZER_LANGUAGES"',
    );
    // temporal_extraction.py's get_default_analyzer() builds an UNLANGUAGED
    // analyzer. It is unreachable only because retrieval.py always passes an
    // explicit analyzer; assert that argument survives so an upstream change
    // that makes the fallback reachable fails the build instead of quietly
    // un-pinning the recall path.
    expect(dockerfile).toContain(
      'assert "analyzer=query_analyzer" in rt',
    );

    // The RED guard: the untruncated on-loop call must be GONE from analyze().
    expect(dockerfile).toContain(
      'assert qa.count("self._search_dates(query, settings=settings, **self._search_kwargs())") == 0,',
    );
    expect(dockerfile).toMatch(
      /switchroom hindsight temporal-offload patch: temporal extraction runs on a/,
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
