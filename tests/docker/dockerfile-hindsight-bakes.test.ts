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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

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

  it("keeps the max_turns/ToolSearch standard-call fix (assert-guarded, fail-loud)", () => {
    // The STANDARD LLM-call path in claude_code_llm.py builds
    // ClaudeAgentOptions with allowed_tools=[] but WITHOUT tools=[], so
    // the built-in CLI tools stay loaded and ToolSearch burns the single
    // max_turns=1 turn → "Reached maximum number of turns (1)" → wasted
    // retries / failed memory ops. This build-time patch brings the
    // standard path to parity with the tool-calling path (tools=[] +
    // max_turns=2). It is self-verifying (asserts the anchor exists once
    // before patching, re-asserts the result). Guard the patch block so
    // nobody silently deletes it and reintroduces the max_turns wall.

    // The exact-once assert on the pre-patch anchor (fail-loud on drift).
    expect(dockerfile).toMatch(
      /assert s\.count\(OLD\) == 1, "switchroom max_turns\/ToolSearch standard-call fix:/,
    );
    // The OLD anchor reconstructs the upstream (pre-patch) standard-call shape.
    expect(dockerfile).toMatch(
      /max_turns=1,  # Single-turn for API-style interactions/,
    );
    // The NEW replacement adds tools=[] + max_turns=2 on the standard path.
    expect(dockerfile).toMatch(
      /tools=\[\],  # switchroom: disable built-in CLI tools so ToolSearch/,
    );
    expect(dockerfile).toMatch(
      /max_turns=2,  # switchroom: headroom so a stray ToolSearch turn/,
    );
    // Post-replace re-assertions must be present (verification-on-build).
    expect(dockerfile).toMatch(
      /assert "            tools=\[\],  # switchroom" in t,/,
    );
    expect(dockerfile).toMatch(
      /assert "max_turns=1,  # Single-turn" not in t,/,
    );
  });

  it("keeps the unit_entities FK-race fix (assert-guarded, fail-loud)", () => {
    // Upstream v0.8.4 defect: retain Phase-1 (entity resolution) and Phase-2
    // (the unit_entities child insert) run in SEPARATE committed transactions.
    // graph_maintenance.prune_orphan_entities can delete an entity in that
    // window (it momentarily has no unit_entities reference), so Phase-2's
    // bulk_insert_unit_entities then violates fk_unit_entities_entity_id_entities
    // — deterministic, non-retryable, memory silently dropped (fires on
    // session_handoff re-ingest). The build-time patch makes Phase-2 re-assert
    // (resurrect) the parent entity row in the SAME transaction as the child
    // insert (INSERT ... ON CONFLICT DO NOTHING), threading the entity metadata
    // Phase-1 already holds. Proven 15/15 RED -> 0/15 with memories persisted on
    // the real retain orchestrator path. Self-verifying (asserts each anchor
    // exactly once against unmodified upstream v0.8.4 before patching, re-asserts
    // the result). Guard the patch block so nobody silently deletes it.

    // The exact-once anchor guard (fail-loud on upstream drift).
    expect(dockerfile).toMatch(
      /assert n == 1, \(\s*\n\s*f"switchroom hindsight FK-race patch: anchor found \{n\}x/,
    );
    // The new idempotent same-txn re-assert op.
    expect(dockerfile).toMatch(/async def reassert_entities\(/);
    expect(dockerfile).toMatch(/INSERT INTO \{table\} \(id, bank_id, canonical_name\)/);
    expect(dockerfile).toMatch(/ON CONFLICT DO NOTHING/);
    // The entity_records threading param on the link path.
    expect(dockerfile).toMatch(
      /entity_records: dict\[str, dict\] \| None = None,/,
    );
    // The orchestrator wires entity_records from the Phase-1 result into Phase-2.
    expect(dockerfile).toMatch(
      /entity_records=phase1\.entities\.entity_records/,
    );
    // Post-replace re-assertions must be present (verification-on-build).
    expect(dockerfile).toMatch(
      /assert "async def reassert_entities\(" in ops_new,/,
    );
    expect(dockerfile).toMatch(
      /assert "entity_records\.get\(str\(eid\)\)" in er_new,/,
    );
    // The success line proves the block ran to completion.
    expect(dockerfile).toMatch(
      /switchroom hindsight unit_entities FK-race patch: reassert_entities \+ entity_records threading applied/,
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

  it("preserves upstream's start-all.sh as the post-shim CMD", () => {
    // The shim does broker auth, then `exec "$@"` which is whatever
    // CMD docker passes — must be upstream's start-all.sh so the
    // image continues to behave like upstream once boot creds are in
    // place.
    expect(dockerfile).toMatch(/^CMD\s+\["\/app\/start-all\.sh"\]/m);
  });
});
