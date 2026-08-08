import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { isClaudeModel } from "../../telegram-plugin/gateway/model-command.js";
import {
  LITELLM_ROUTER_MARGIN_S,
  LITELLM_TIMEOUT_TIERS,
  assertClientBudget,
  clientBudgetSeconds,
} from "../litellm/timeout-budget.js";
import {
  isDegradedHostCapabilitiesRead,
  readHostCapabilities,
  warnDegradedHostCapabilities,
  type HostCapabilitiesRead,
} from "./host-capabilities.js";
import {
  hindsightPerfEnv,
  resolveHindsightPerfOverrides,
} from "./hindsight-perf-defaults.js";
import {
  HINDSIGHT_PG_SHARED_BUFFERS_ENV,
  hindsightMemBudgetWarning,
  hindsightPgEnv,
  parseDockerSizeToMib,
  resolveHindsightPgOverrides,
} from "./hindsight-pg-defaults.js";
import {
  HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING,
  resolveCheckedHindsightContextBudget,
} from "./hindsight-context-budget.js";
import { isLoopbackHttpUrl, isSelfHostedHttpUrl } from "./self-hosted-url.js";

/**
 * Default Hindsight host ports.
 *
 * The API port defaults to **18888**, NOT the upstream default of 8888.
 * 8888 is a heavily-contended port on a typical host — Coolify, nginx
 * front-proxies, tunnel gateways, and Jupyter all grab it. Because the
 * hindsight container runs `--network host` and binds `HINDSIGHT_API_PORT`
 * directly on the host, a default of 8888 collided with a foreign listener
 * (nginx-tunnel-gateway on 127.0.0.1:8888) and crash-looped for hours while
 * fleet memory was silently down (2026-07 incident). Defaulting to 18888
 * — a port nothing else conventionally claims — removes the collision at the
 * source. `pickHindsightPorts()` + the caller-side preflight still guard
 * against 18888 itself being occupied.
 *
 * The UI port stays at 9999 (uncontended in the incident); it is
 * informational and unused by switchroom.
 */
export const HINDSIGHT_DEFAULT_API_PORT = 18888;
export const HINDSIGHT_DEFAULT_UI_PORT = 9999;

/**
 * Default MCP endpoint URL switchroom writes into agent `.mcp.json` /
 * `memory.config.url` when the operator hasn't overridden it. Derived from
 * `HINDSIGHT_DEFAULT_API_PORT` so the scaffolded URL and the container's
 * bound port can never silently drift apart — the exact failure mode behind
 * the 2026-07 outage (agents pointed at 18888 while the container bound
 * 8888). Change the port in ONE place and both move together.
 */
export const HINDSIGHT_DEFAULT_MCP_URL = `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/mcp/`;

/**
 * Default REST base URL (no `/mcp/` suffix) for hindsight's HTTP API — the
 * form the vendored plugin's hooks expect as `HINDSIGHT_API_URL`. Derived
 * from {@link HINDSIGHT_DEFAULT_MCP_URL} so the port lives in exactly one
 * place: every `?? "http://127.0.0.1:18888"` literal fallback that used to be
 * scattered across scaffold/doctor/agent/memory should reference this instead.
 */
export const HINDSIGHT_DEFAULT_API_BASE_URL = HINDSIGHT_DEFAULT_MCP_URL.replace(/\/mcp\/?$/, "");

// Re-exported, not defined here: the value now lives in hindsight-perf-defaults
// so it is a MANAGED key an operator can override via `hindsight.env` (rather
// than by re-running `docker run -e …`, which the next `switchroom apply`
// discards). The re-export keeps the existing import sites (and their tests)
// working. See that module for the rationale and the shipped default of 1000.
export { HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE } from "./hindsight-perf-defaults.js";
// Re-exported, not defined here: these moved to hindsight-perf-defaults so they
// are MANAGED keys an operator can override via `hindsight.env`. Before the
// move each was a bare constant emitted unconditionally on both launch paths
// and absent from HINDSIGHT_PERF_ENV_KEYS, so a yaml line for one of them was
// silently dropped. The re-export keeps existing import sites (and their tests)
// working unchanged.
export {
  HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING,
  HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES,
  HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT,
  HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT,
  HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S,
  HINDSIGHT_DEFAULT_CONSOLIDATION_RESERVED_SLOTS,
  HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT,
  HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND,
} from "./hindsight-perf-defaults.js";

/**
 * Default consumer slug for the hindsight broker socket. Path-as-identity
 * — the broker binds `/run/switchroom/auth-broker/<slug>/sock` and chowns
 * it to the configured UID. See `auth.consumers[]` in `src/config/schema.ts`
 * and RFC H §4.8.
 */
export const HINDSIGHT_CONSUMER_NAME = "hindsight";

/**
 * Stable hindsight worker identity pinned into the container env so
 * every recreate reclaims stranded `processing` async ops via
 * upstream `recover_own_tasks()` (keyed on worker_id). Without this the
 * worker falls back to the container hostname (ephemeral), and a
 * crash-orphaned consolidation can block a bank forever. Mirrors the
 * entrypoint-side default; docker-run must set it too so recover fires
 * *before* the deferred reaper.
 */
export const HINDSIGHT_DEFAULT_WORKER_ID = "switchroom-hindsight";
/**
 * The authority container's exact name. Kept as a constant so exact-name
 * container checks (see {@link isHindsightRunning}) never accidentally
 * substring-match the recall-pool sibling `switchroom-hindsight-recall`.
 */
export const HINDSIGHT_CONTAINER_NAME = "switchroom-hindsight";
/** Named volume holding embedded pg — dual mounts = dual writers. */
export const HINDSIGHT_DATA_VOLUME = "switchroom-hindsight-data";

/**
 * Default UID for the hindsight container's broker socket. The container
 * runs as the upstream `hindsight` user; we pick a fixed UID in the
 * consumer range (>10000, not colliding with switchroom agent UIDs at
 * 10001-10999) so the chowned socket is readable inside.
 *
 * Operators can override per-install via `auth.consumers[].uid` in
 * `switchroom.yaml`.
 */
export const HINDSIGHT_DEFAULT_UID = 11000;

/**
 * GHCR repository (no tag) for switchroom's hindsight image. The image is
 * published per-version as `:vX.Y.Z` on a release tag AND as `:latest` on
 * every main build (see `.github/workflows/docker-images.yml`). Standalone
 * paths (`memory setup`) default to `:latest`; a version-pinned rollout
 * threads the target tag through so the recreate pulls the SAME pinned
 * image the rest of the fleet moved to (not floating `:latest`).
 */
export const HINDSIGHT_IMAGE_REPO = "ghcr.io/switchroom/switchroom-hindsight";

/**
 * Docker image for switchroom's hindsight (extends upstream with the
 * `claude-code` LLM provider's runtime deps). Pulled from GHCR at apply
 * time; built from `docker/Dockerfile.hindsight` when `--build-local`.
 * The default floating `:latest` tag — used by the standalone `memory
 * setup` path. A pinned rollout overrides the tag via {@link hindsightImageRef}.
 */
export const HINDSIGHT_IMAGE = `${HINDSIGHT_IMAGE_REPO}:latest`;

/**
 * Resolve the hindsight image reference for a given target tag.
 *
 * The release workflow publishes the hindsight image with the `v`-prefixed
 * git tag (`TAG_VERSION="${GITHUB_REF#refs/tags/}"` → `:v0.15.18`), so a
 * rollout target like `v0.15.18` or `0.15.18` maps to `…hindsight:v0.15.18`.
 * When `tag` is undefined/empty, returns the floating `:latest` image
 * ({@link HINDSIGHT_IMAGE}) — preserving the standalone `memory setup`
 * behavior. Normalizes so a bare `0.15.18` and a `v0.15.18` both resolve to
 * the `:v0.15.18` tag the workflow actually publishes. A non-normalizable
 * tag (e.g. `sha-…`, garbage) also floats to `:latest` — the release
 * workflow only publishes per-version `:vX.Y.Z` images, so there is no
 * concrete image to pin to.
 */
export function hindsightImageRef(tag?: string): string {
  const normalized = normalizeHindsightVersionTag(tag);
  if (!normalized) return HINDSIGHT_IMAGE;
  return `${HINDSIGHT_IMAGE_REPO}:${normalized}`;
}

/**
 * Canonicalize a hindsight image version tag to the `vX.Y.Z` form the
 * release workflow publishes (`TAG_VERSION="${GITHUB_REF#refs/tags/}"` →
 * `:vX.Y.Z`). Accepts either an already-`v`-prefixed `vX.Y.Z` or a bare
 * `X.Y.Z` and returns the canonical `vX.Y.Z`. Anything else — an empty /
 * undefined value, a `sha-…` pin, or garbage — returns `undefined`, which
 * callers treat as "no concrete version → float to `:latest`".
 *
 * This is the single source of truth for pin normalization, shared by
 * {@link hindsightImageRef} and `resolveHindsightPinTag` (src/cli/update.ts)
 * so both callsites gate identically.
 */
export function normalizeHindsightVersionTag(candidate?: string): string | undefined {
  const t = candidate?.trim();
  if (!t) return undefined;
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(t);
  return m ? `v${m[1]}` : undefined;
}

/**
 * Default Claude model for hindsight's LLM operations (retain / reflect /
 * consolidation — recall is local-only, no LLM). Matches the fleet-wide
 * `SWITCHROOM_DEFAULT_MAIN_MODEL` in `src/agents/scaffold.ts` so a fresh
 * deployment uses one consistent model across agents and memory.
 *
 * Upstream `vectorize-io/hindsight` defaults to a date-pinned older
 * sonnet (`claude-sonnet-4-5-20250929`) via PROVIDER_DEFAULT_MODELS in
 * /app/api/hindsight_api/config.py. Without this override the container
 * silently drifts behind the rest of switchroom on every upstream
 * hindsight pull. Pinning here keeps both surfaces in lockstep.
 *
 * Operators who need a different model can still override at runtime
 * via `docker run -e HINDSIGHT_API_LLM_MODEL=...` or by editing the
 * generated compose snippet.
 */
export const HINDSIGHT_DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Default LiteLLM model for Hindsight's LLM ops when the `litellm` routing
 * carve-out is enabled and no `memory.config.llm_model` override is set.
 * OpenRouter (not Anthropic OAuth) so background memory-op cost (fact
 * extraction, recall synthesis, consolidation) doesn't burn the Claude
 * subscription quota (added 2026-07-07, per Ken). Must be a model_name
 * registered in litellm's model_list, routed via the model-mapped path (see
 * {@link isClaudeModel}), NOT the Anthropic pass-through.
 */
export const HINDSIGHT_DEFAULT_LITELLM_MODEL =
  "openrouter/google/gemini-3.1-flash-lite";

/**
 * Run hindsight's MCP server in stateless HTTP mode.
 *
 * Upstream defaults to stateful (`HINDSIGHT_API_MCP_STATELESS=false`):
 * the server assigns an `Mcp-Session-Id` on the client's first
 * `initialize`, and every subsequent request must echo it back. That
 * mode is for clients that want SSE streaming / GET subscriptions —
 * neither of which switchroom uses; agent retain/recall are POST-only
 * tool calls with idempotent request/response semantics.
 *
 * Stateful mode has a sharp edge for our deploy model: bouncing the
 * hindsight container wipes its in-memory session registry, but every
 * agent's claude MCP client keeps caching the now-stale session id.
 * Every retain after the bounce errors with "Session not found" until
 * each agent is also restarted. Operationally this means a single
 * `switchroom memory --restart` silently breaks the fleet's retain
 * path. Stateless mode dodges the whole class of failures — every
 * request is self-contained, no session to invalidate.
 *
 * Operators with bespoke MCP clients that need streaming can flip
 * this back via `docker run -e HINDSIGHT_API_MCP_STATELESS=false`.
 */
export const HINDSIGHT_DEFAULT_MCP_STATELESS = true;

/**
 * Bounded dead-letter auto-requeue safety net (#3795 / #3797).
 *
 * `docker/hindsight-maintenance.sh` (Section 7) already implements a recovery
 * sweep: it POSTs each FK-race dead-letter — a `retain` op the engine
 * MISclassified as a deterministic failure during the unit_entities
 * ForeignKeyViolation race (#3794), so it sits `status='failed'` with an
 * intact `task_payload`, `retry_count=0`, `next_retry_at IS NULL` and is never
 * revisited — back to the engine's own `/retry` endpoint (failed → pending),
 * after which the worker's claim loop picks it up and the STALLED memory lands.
 * The classifier PREVENTION fix is an engine change tracked in #3797 and is
 * out of scope here; this is the RECOVERY half.
 *
 * The script reads these two knobs from its process environment and defaults
 * them OFF (`REQUEUE_DEAD_LETTERS=0`). Nothing in `src/` surfaced them, so the
 * sweep never ran on the fleet. Pinning them on the container's env here is the
 * durable enable — it lands on BOTH launch paths (docker-run + compose).
 *
 * The bound matters because each requeued op re-runs LLM fact extraction (real
 * spend). Steady-state FK-race rate is ~zero and the historical backlog was
 * ~14-23, so 25/tick is a safe ceiling that clears a realistic burst without
 * risking a large unexpected spend if the classifier regresses.
 */
export const HINDSIGHT_DEFAULT_REQUEUE_DEAD_LETTERS = "1";
export const HINDSIGHT_DEFAULT_REQUEUE_MAX = "25";

/**
 * DEFER the hindsight MCP tool-surface allowlist (29 advertised tools) — the
 * 2026-06-07 adversarial audit (3 independent host-caller hunts) found it is
 * high-blast-radius for ~no net benefit. Recorded so we don't re-attempt it.
 *
 * The server DOES support a global allowlist (`HINDSIGHT_API_MCP_ENABLED_TOOLS`,
 * config.py:1665 — comma-separated, filters BOTH tools/list and invocation,
 * GLOBALLY across all banks). But "trim to ~5" is unsafe: the agent and
 * switchroom's host code legitimately reach a BROAD set on the same banks:
 *   • agent (model-invoked via MEMORY_GUIDANCE + the fleet CLAUDE.md): recall,
 *     reflect, sync_retain, retain, delete_document, AND — instructed in EVERY
 *     agent's CLAUDE.md (profiles/default/CLAUDE.md.hbs:70-72) — create_directive,
 *     list_directives, delete_directive, refresh_mental_model, update_mental_model;
 *   • host setup (src/memory/hindsight.ts): create_bank, create_mental_model,
 *     list_mental_models, update_bank;
 *   • host (src/agents/status.ts): list_banks; (src/cli/vault-sweep.ts): list_memories;
 *   • an agent Stop hook (bin/user-profile-refresh-hook.sh): refresh_mental_model.
 * The minimum SAFE allowlist is therefore ~16 of 29 — and the audit found TWO
 * callers a first-pass grep missed (refresh_mental_model, create_directive), so
 * a too-narrow list would SILENTLY break a model-instructed capability across
 * the whole fleet (the allowlist filters the SHARED singleton). Completeness
 * can't be guaranteed cheaply, and a miss is a silent fleet-wide degradation.
 *
 * And the token win is already captured: Claude Code tool-search (#2198) defers
 * all 29 schemas out of the AGENT's context regardless of the advertised count,
 * so the allowlist would only shave the tool-search-OFF fallback path (~5-6k tok
 * at 16/29) — not worth the blast radius. NOT shipping it.
 *
 * The two PHANTOM callers the audit surfaced WERE fixed (real bugs, independent
 * of the allowlist): vault-sweep's `delete_memory` (no such tool; a memory id is
 * not a document_id either — proven live) and hindsight.ts addMemoryTag's
 * `update_memory`, both of which now FAIL HONESTLY instead of silently
 * reporting success.
 *
 * CORRECTION (2026-07-27, hindsight 0.8.4/0.8.5 re-audit): the second of those
 * was mis-diagnosed, and the "29 advertised tools" figure above is stale. The
 * server advertises **32** (verified live against 0.8.4 and against the 0.8.5
 * wheel), and `update_memory` / `invalidate_memory` / `clear_mental_model` are
 * real, unconditionally-registered tools — the 2026-06-07 tools/list snapshot
 * simply predated them. The real gap is narrower than "phantom tool":
 * `update_memory` has no PER-MEMORY tag-write argument, so `switchroom memory
 * demote` still cannot work. And because the tool IS real, the unknown argument
 * is silently dropped (isError stays false) rather than rejected — so that
 * callsite verifies by reading the tag back off the memory unit the call
 * returns; an isError check could never fire there. vault-sweep's single-memory delete path was subsequently
 * reworked onto the real `invalidate_memory` tool. The allowlist verdict is
 * unchanged — the safe minimum is now ~18 of 32, so the blast-radius argument
 * gets stronger, not weaker.
 */

/**
 * Named volume that the auth-broker singleton chowns the hindsight
 * consumer socket into. Generated by `src/agents/compose.ts` from
 * `auth.consumers[].name`; mirrored here so the standalone `switchroom
 * memory --start` path (which doesn't go through compose) can bind it.
 */
export const HINDSIGHT_BROKER_SOCK_VOLUME = `auth-broker-${HINDSIGHT_CONSUMER_NAME}-sock`;

/**
 * Shared creds-mirror volume for the hindsight consumer (#2578).
 *
 * When the hindsight `auth.consumers[]` entry declares `mirror_dir`, the
 * auth-broker pushes the effective-account `.credentials.json` there the
 * instant it detects exhaustion (see `mirrorAccountToConsumer` in
 * src/auth/broker/server.ts, landed in #2577). For that push to reach
 * hindsight, broker and hindsight must share a volume: the broker mounts
 * it at the operator-chosen `mirror_dir`, hindsight mounts the SAME named
 * volume at its creds-read path (`/run/claude-creds`, the entrypoint's
 * `CLAUDE_CONFIG_DIR`), REPLACING the private per-container tmpfs. This
 * closes the up-to-30-min pull-latency gap for failover.
 *
 * Name is canonical (unprefixed) so it matches what `src/agents/compose.ts`
 * declares on the switchroom compose project (`consumer-creds-<name>`) —
 * the two projects are separate but reference the same volume by name.
 */
export const HINDSIGHT_CREDS_MIRROR_VOLUME = `consumer-creds-${HINDSIGHT_CONSUMER_NAME}`;

/**
 * The consumer-side creds-read path — hindsight's `CLAUDE_CONFIG_DIR`, where
 * the entrypoint fetches `.credentials.json` and the claude subprocess reads
 * it. In mirror mode the broker's pushed file lands here via the shared
 * volume; otherwise it is a per-container tmpfs.
 */
export const HINDSIGHT_CRED_DIR = "/run/claude-creds";

/**
 * Resolve the hindsight consumer's `mirror_dir` from a loaded config, or
 * `undefined` when unset (mirror-mode off → tmpfs, pull-only — unchanged
 * pre-#2578 behavior). Callers pass the result to `startHindsight` /
 * `generateHindsightComposeSnippet` to decide tmpfs-vs-shared-volume.
 */
export function hindsightConsumerMirrorDir(config: {
  auth?: { consumers?: Array<{ name: string; mirror_dir?: string }> };
}): string | undefined {
  return config.auth?.consumers?.find((c) => c.name === HINDSIGHT_CONSUMER_NAME)
    ?.mirror_dir;
}


/**
 * Retain LLM budget — output cap and the deadline that must bracket it.
 *
 * These numbers used to live in unrelated places (a vendor default inside the
 * image, a client timeout in the plugin, a deployment timeout in the LiteLLM
 * config) with nothing tying them together, which is exactly how the
 * 2026-07-25 incident happened: a ~190s job under a 90s deadline, and a single
 * request that ran 767.6s. Emitting them from one derivation, behind an
 * assertion, makes an inconsistent budget impossible to ship.
 *
 * `HINDSIGHT_RETAIN_CHUNK_SIZE` mirrors the vendor default we do NOT override
 * (`hindsight_api/config.py` `DEFAULT_RETAIN_CHUNK_SIZE = 3000`). It appears
 * here only because the daemon refuses to boot unless
 * `retain_max_completion_tokens > retain_chunk_size`, and that precondition
 * must be checked before we hand the container an env it will die on.
 */
export const HINDSIGHT_RETAIN_CHUNK_SIZE = 3000;

/**
 * Max output tokens for a retain fact-extraction call.
 *
 * The vendor default is 64000 (`config.py DEFAULT_RETAIN_MAX_COMPLETION_TOKENS`),
 * which is less a cap than permission to run away: at the measured local
 * generation rate (87.1 and 80.6 tok/s across the two Ollama boxes,
 * 2026-07-25) 64000 tokens is a ~12 minute call. It was observed doing exactly
 * that — one request generated the full 64000 tokens over 767.6s, and every
 * call exceeding 8192 completion tokens (n=17 in a 110-minute window) blew
 * hindsight's own client timeout. Each runaway also tripped the per-deployment
 * timeout on both local boxes, cooling them and dumping fleet traffic onto the
 * metered OpenRouter fallback.
 *
 * 16384 is ~3.4 minutes at the slower measured rate: headroom for a
 * legitimately verbose extraction, far too little for a reasoning loop.
 */
export const HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS = 16384;

/**
 * Slowest measured local generation rate, tokens/second (2026-07-25: 87.1 and
 * 80.6 tok/s across the two Ollama boxes). Take the slower — a budget that
 * only holds on the faster box is not a budget.
 */
export const HINDSIGHT_RETAIN_MIN_TOKENS_PER_SECOND = 80.6;

/**
 * Token-budget-derived per-call deadline, from the output cap (#3611):
 *
 *   ceil(maxCompletionTokens / minTokensPerSecond)
 *   = ceil(16384 / 80.6) = 204s
 *
 * Exactly long enough for the model to emit its whole permitted output at the
 * slowest measured rate. Raising the token cap moves this automatically; the
 * two can no longer drift apart.
 *
 * This is now a FLOOR on the emitted retain deadline rather than the emitted
 * value itself — see {@link hindsightRetainClientTimeoutSeconds} for why, and
 * for the second lower bound it is taken against.
 */
export function hindsightRetainLlmTimeoutSeconds(
  maxCompletionTokens: number = HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
  tokensPerSecond: number = HINDSIGHT_RETAIN_MIN_TOKENS_PER_SECOND,
): number {
  if (!(maxCompletionTokens > 0) || !(tokensPerSecond > 0)) {
    throw new Error(
      `hindsight retain budget: maxCompletionTokens (${maxCompletionTokens}) and ` +
        `tokensPerSecond (${tokensPerSecond}) must both be positive`,
    );
  }
  return Math.ceil(maxCompletionTokens / tokensPerSecond);
}

/**
 * Hindsight's per-call LLM deadline for the RETAIN lane — the value emitted as
 * `HINDSIGHT_API_RETAIN_LLM_TIMEOUT`.
 *
 * This one number sits between two deadlines and has to satisfy both, which is
 * why it is derived rather than chosen:
 *
 *   litellm chain (200 + 90) + margin 10  <=  THIS  <  retain client deadline
 *                          300            <=  300  <         310
 *
 * ── Lower bound (new, #3611's missing half) ─────────────────────────────────
 * litellm's router fallback runs INSIDE this one request: up to 200s on the
 * local `gpt-oss-20b-retain` group, then up to 90s on
 * `gpt-oss-20b-retain-openrouter`. #3611 set this to the token-derived 204s
 * while the chain below it was already 290s, so the retain fallback hop had 4s
 * of headroom and could never complete. {@link clientBudgetSeconds} now takes
 * the max of the two lower bounds, so the token derivation is preserved as a
 * FLOOR (204s — never starve a legitimately full-length extraction) rather than
 * being the whole answer.
 *
 * Raising this from 204 to 300 does not reopen the 767.6s runaway #3611 fixed.
 * A runaway is cut by `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS` at the
 * source and by litellm's own 200s per-deployment timeout upstream of this
 * client — a longer CLIENT deadline cannot make an upstream call run longer, it
 * only stops the client abandoning a failover that is still in flight.
 *
 * ── Upper bound (#3611's assertion, unchanged) ──────────────────────────────
 * Must stay strictly under the retain POST deadline the plugin holds, or the
 * plugin walks away while hindsight is still working — see
 * {@link assertHindsightRetainBudget}.
 */
export function hindsightRetainClientTimeoutSeconds(): number {
  return clientBudgetSeconds(
    LITELLM_TIMEOUT_TIERS.retain,
    hindsightRetainLlmTimeoutSeconds(),
  );
}

/**
 * The retain CLIENT deadline: how long a caller waits for one retain POST.
 *
 * DERIVED, not hand-set: one margin above
 * {@link hindsightRetainClientTimeoutSeconds}, so the plugin always outlives
 * hindsight's own LLM deadline by construction. It was the literal `280` until
 * the retain chain grew past it — a hand-set number in a chain of derived ones
 * is the drift bug wearing a different hat.
 *
 * Mirrored by `DEFAULT_RETAIN_CLIENT_DEADLINE_S` in the plugin's
 * `vendor/hindsight-memory/scripts/lib/retain_split.py`, which sizes its
 * content bound and the backlog-drain timeout off the same number (#3610).
 * `tests/setup/hindsight.test.ts` enforces that the two stay equal, so the
 * mirror is a check rather than a comment.
 */
export const HINDSIGHT_RETAIN_CLIENT_DEADLINE_S =
  hindsightRetainClientTimeoutSeconds() + LITELLM_ROUTER_MARGIN_S;

/**
 * Fail loudly on an inconsistent retain budget, at config-emit time, before a
 * container is ever handed it. Precedent: the daemon's own
 * `retain_max_completion_tokens > retain_chunk_size` boot check.
 *
 * 1. **`maxCompletionTokens > chunkSize`** — the daemon refuses to boot
 *    otherwise, and a crash-looping hindsight is no memory backend for the
 *    entire fleet.
 * 2. **server per-call timeout < client POST deadline** — a hung LLM call must
 *    die server-side and surface as a real error rather than the client
 *    abandoning first. When the client gives up first the server keeps
 *    generating (and, on a metered fallback, keeps billing) against a request
 *    nobody is waiting for. That is the 767.6s call.
 *
 * What this deliberately does NOT promise: the server deadline is per
 * extraction call and one retain runs many calls sequentially, so satisfying
 * it does not mean a whole POST fits inside the client deadline. Bounding
 * total content is the plugin's job (`lib/retain_split.py`); the two are
 * complementary halves of the same guarantee.
 */
export function assertHindsightRetainBudget(budget: {
  maxCompletionTokens: number;
  chunkSize: number;
  serverTimeoutS: number;
  clientDeadlineS: number;
}): void {
  const { maxCompletionTokens, chunkSize, serverTimeoutS, clientDeadlineS } = budget;
  if (maxCompletionTokens <= chunkSize) {
    throw new Error(
      `hindsight retain budget: HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS ` +
        `(${maxCompletionTokens}) must exceed retain_chunk_size (${chunkSize}) or the ` +
        `hindsight container refuses to boot (config.py validate_retain_*).`,
    );
  }
  if (serverTimeoutS >= clientDeadlineS) {
    throw new Error(
      `hindsight retain budget: server per-call timeout (${serverTimeoutS}s) must be ` +
        `strictly less than the retain client deadline (${clientDeadlineS}s), or the ` +
        `client abandons first and the server keeps generating against a request ` +
        `nobody is waiting for. Lower HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS, ` +
        `or raise HINDSIGHT_RETAIN_CLIENT_DEADLINE_S and ` +
        `DEFAULT_RETAIN_CLIENT_DEADLINE_S in ` +
        `vendor/hindsight-memory/scripts/lib/retain_split.py together.`,
    );
  }
}

/**
 * Hindsight's per-call LLM deadline for the INTERACTIVE lane — emitted as both
 * `HINDSIGHT_API_LLM_TIMEOUT` (the global default, used by recall and the
 * default LLM config) and `HINDSIGHT_API_REFLECT_LLM_TIMEOUT`, because both
 * route to the `gpt-oss-20b` group.
 *
 * `90 (local) + 60 (openrouter fallback) + 10 (margin) = 160s`.
 *
 * Previously NOT EMITTED AT ALL, so it silently took hindsight's vendor default
 * of 120s (`hindsight_api/config.py:733 DEFAULT_LLM_TIMEOUT`). When the
 * interactive fallback hop was raised 25s → 60s on 2026-07-26 the chain became
 * 150s against that unmoved 120s default, so the fallback could not complete —
 * the same paired-drift defect as the retain lane, in the lane where a person
 * is actually waiting. An unset knob is still half of a pair; it just has
 * nobody's name on it. Emitting it explicitly is what makes it derivable.
 *
 * 160s is also the value Ken set for this lane on 2026-07-26, arrived at
 * independently — the derivation reproduces it rather than replacing it.
 *
 * The measured interactive floor is comfortably under this: reflect durations
 * over 24h (n=36) were max 118.2s, p99 95.5s, p95 82.9s, median 29.2s.
 */
export function hindsightInteractiveLlmTimeoutSeconds(): number {
  return clientBudgetSeconds(LITELLM_TIMEOUT_TIERS.interactive);
}

/**
 * Hindsight's per-call LLM deadline for the CONSOLIDATION lane — emitted as
 * `HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT`.
 *
 * `200 (local) + 90 (openrouter fallback) + 10 (margin) = 300s`.
 *
 * Also previously unemitted, so it took the same 120s vendor default while its
 * routing chain was 290s — the identical defect as the interactive lane. The
 * live symptom was in the logs: 173 `exceeded timeout=120.0s` errors and
 * 160/630 consolidation calls needing at least one retry.
 */
export function hindsightConsolidationLlmTimeoutSeconds(): number {
  return clientBudgetSeconds(LITELLM_TIMEOUT_TIERS.consolidation);
}

/**
 * Every LLM timeout budget hindsight is handed, as `[key, value]` pairs.
 *
 * Asserted before it returns, so both emit paths ({@link startHindsight} and
 * {@link generateHindsightComposeSnippet}) fail loudly on a violation and can
 * never drift from each other — or from the litellm routing chain each budget
 * is derived from.
 *
 * Two independent assertions run per lane:
 *   - {@link assertClientBudget}: the budget covers `local + fallback + margin`,
 *     so the router's fallback hop can actually complete (the 2026-07-25/26
 *     defect).
 *   - {@link assertHindsightRetainBudget}: retain-specific — the token cap
 *     exceeds the chunk size (or the container refuses to boot) and hindsight's
 *     deadline stays strictly under the plugin's POST deadline (#3611).
 *
 * Honest caveat, and it applies to BOTH of them from this call site:
 *
 *  - The three {@link assertClientBudget} calls below cannot fail as written.
 *    Each budget comes from {@link clientBudgetSeconds}, which returns
 *    `max(floor, local + fallback + margin)`, and the assertion's threshold is
 *    that same `local + fallback + margin`. Asserting a value against the
 *    lower bound it was clamped to is a tautology.
 *  - {@link assertHindsightRetainBudget}'s `server < client` half is tautological
 *    for the same reason: {@link HINDSIGHT_RETAIN_CLIENT_DEADLINE_S} is now
 *    derived from {@link hindsightRetainClientTimeoutSeconds} plus one margin.
 *    Its `maxCompletionTokens > chunkSize` half is NOT — those two are
 *    independent constants and it can still fire.
 *
 * They are kept deliberately, as the guard that catches the NEXT edit rather
 * than this one: the moment any lane's budget is hand-set, or read from config,
 * or `clientBudgetSeconds` is bypassed, these stop being tautologies and become
 * the emit-time failure that keeps a broken budget out of a container. They are
 * defence in depth, not the primary mechanism, and this comment exists so
 * nobody mistakes them for it.
 *
 * The checks that can actually FAIL today, and are therefore the load-bearing
 * ones, all live in tests over files nothing derives:
 *   - `src/litellm/timeout-budget.test.ts` exercises {@link assertClientBudget}
 *     directly against the shipped-bug values (204/120) and its boundaries.
 *   - `src/litellm/repo-config.test.ts` compares the declared tiers against the
 *     real `docker/litellm-proxy/litellm-config.yaml`.
 *   - `tests/setup/hindsight.test.ts` asserts
 *     {@link HINDSIGHT_RETAIN_CLIENT_DEADLINE_S} equals
 *     `DEFAULT_RETAIN_CLIENT_DEADLINE_S` in the plugin's `retain_split.py`.
 */
export function hindsightLlmBudgetEnv(llm?: HindsightLlmConfig): Array<[string, string]> {
  // Second, independent bound on the SAME retain cap: the declared context
  // window. #3611's 16384 is a TIME budget (don't generate for 12 minutes);
  // this one is a CONTEXT budget (don't overflow the slot). Both are real
  // caps, so the tighter wins — see hindsight-context-budget.ts for why an
  // overflow is invisible and therefore has to be caught here.
  const contextBudget = resolveCheckedHindsightContextBudget(llm);
  const maxCompletionTokens = Math.min(
    HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
    contextBudget.retain.maxCompletionTokens,
  );

  const interactiveS = hindsightInteractiveLlmTimeoutSeconds();
  const retainS = hindsightRetainClientTimeoutSeconds();
  const consolidationS = hindsightConsolidationLlmTimeoutSeconds();

  assertClientBudget({
    role: "interactive",
    tier: LITELLM_TIMEOUT_TIERS.interactive,
    clientBudgetS: interactiveS,
  });
  assertClientBudget({
    role: "retain",
    tier: LITELLM_TIMEOUT_TIERS.retain,
    clientBudgetS: retainS,
  });
  assertClientBudget({
    role: "consolidation",
    tier: LITELLM_TIMEOUT_TIERS.consolidation,
    clientBudgetS: consolidationS,
  });

  assertHindsightRetainBudget({
    maxCompletionTokens,
    chunkSize: HINDSIGHT_RETAIN_CHUNK_SIZE,
    serverTimeoutS: retainS,
    clientDeadlineS: HINDSIGHT_RETAIN_CLIENT_DEADLINE_S,
  });

  return [
    ["HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS", String(maxCompletionTokens)],
    // Interactive lane: recall + the default LLM config, and reflect, both of
    // which route to `gpt-oss-20b`. Emitted explicitly so the 120s vendor
    // default can never silently become half of a mismatched pair again.
    ["HINDSIGHT_API_LLM_TIMEOUT", String(interactiveS)],
    ["HINDSIGHT_API_REFLECT_LLM_TIMEOUT", String(interactiveS)],
    ["HINDSIGHT_API_RETAIN_LLM_TIMEOUT", String(retainS)],
    ["HINDSIGHT_API_CONSOLIDATION_LLM_TIMEOUT", String(consolidationS)],
    // Consolidation token budget — DERIVED from the declared context window,
    // not hand-set. Batch size is the number of facts stuffed into one prompt,
    // so it is the dominant term in prompt size and therefore a context
    // decision (see the block above HINDSIGHT_DEFAULT_CONSOLIDATION_RESERVED_SLOTS).
    // Upstream's `consolidation_max_completion_tokens` default is None (no
    // cap at all), which is exactly the unbounded half of the overflow.
    ["HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE", String(contextBudget.consolidation.batchSize)],
    [
      "HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS",
      String(contextBudget.consolidation.maxCompletionTokens),
    ],
    // Reflect's accumulated-context bound. Upstream defaults it to 100_000 —
    // three times a 32k slot, i.e. not a bound at all on a local backend: a
    // long agentic reflect walks straight through the window and is
    // context-shifted into the same silent HTTP-200 garbage.
    [
      "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS",
      String(contextBudget.reflect.maxContextTokens),
    ],
    // Per-bank labels on the `hindsight_operation_*` families.
    //
    // Upstream defaults this OFF — "to avoid high-cardinality OTel metric
    // growth" (`DEFAULT_METRICS_INCLUDE_BANK_ID` in the vendored `config.py`).
    // That is the right default for a multi-tenant SaaS with unbounded
    // tenants and the wrong one here: this fleet is single-tenant by
    // invariant (`reference/invariants.md`), so the label's cardinality is
    // bounded by the agent roster (12 today) and grows with headcount, not
    // with traffic.
    //
    // The cost of leaving it off: `hindsight_operation_duration_seconds`
    // carried operation/source/success/budget/tenant and nothing identifying
    // the BANK, so no per-bank SLO could be built from `/metrics` at all.
    // Through the 2026-07 recall regression the aggregate histogram looked
    // merely mediocre while overlord and klanker sat at ~97 % own-bank
    // timeout and lawgpt at 0 % — an outage on two banks averaged into a
    // shrug across twelve. Emitting the label is what makes the two
    // distinguishable without parsing 12 separate JSONL files.
    ["HINDSIGHT_API_METRICS_INCLUDE_BANK_ID", "true"],
  ];
}

/**
 * Consolidation throughput knobs.
 *
 * ## The binding constraint is LOCAL GPU SLOTS, not subscription quota
 *
 * These values used to be throttled to a hard ceiling of 2 concurrent model
 * calls because consolidation ran on the Anthropic subscription. **That
 * premise is no longer what this fleet runs.** `hindsight.llm.consolidation`
 * in switchroom.yaml points the lane at `provider: litellm`, `model:
 * openai/gpt-oss-20b-consolidation`, `base_url: http://127.0.0.1:4010/v1` —
 * a loopback LiteLLM proxy routing to self-hosted Ollama boxes on the
 * tailnet. On that path there is no shared Anthropic quota to exhaust and no
 * marginal cash cost per call; a consolidation op is a request against a
 * finite pool of local inference slots.
 *
 * The resource to protect changed shape entirely:
 *
 *   - OLD: a shared, fleet-wide, *rate-limited* budget where one bad fan-out
 *     429s the live agents. The only safe answer was a hard low ceiling.
 *   - NEW: a fixed local slot pool that queues rather than 429s. Over-issuing
 *     costs latency for the *interactive* lanes (recall / reflect / retain)
 *     sharing that pool; it cannot wall the fleet's Claude turns.
 *
 * Interactive-lane protection therefore lives elsewhere, and this is the knob
 * to reach for first: `HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT`
 * (src/setup/hindsight-perf-defaults.ts — DERIVED from the effective global and
 * retain caps, landing on 2 with switchroom's own defaults) is a process-wide
 * semaphore on consolidation LLM calls — see the engine's
 * `llm_wrapper._build_per_op_semaphores`, where a consolidation call must
 * acquire the per-op semaphore AND the global one. Every knob in THIS block
 * sits outside that semaphore, so raising them pipelines a consolidation op's
 * non-LLM stages (recall, embedding, db_write) and improves cross-bank
 * fairness — it does not multiply concurrent LLM calls.
 *
 * - RESERVED_SLOTS 1: the worker's reserved *floor* for consolidation — one
 *   bank
 *   is always guaranteed a slot. Deliberately NOT the ceiling; see
 *   {@link HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT}.
 * - LLM_PARALLELISM 2: at most two tag-groups in flight within one op.
 * - MAX_MEMORIES_PER_ROUND 500: a correctness knob as much as a throughput
 *   one — see the constant's own note.
 * - LLM_BATCH_SIZE: **no longer a constant here.** Derived from the declared
 *   backend context window — see below and `hindsight-context-budget.ts`.
 *
 * RESERVED_SLOTS and LLM_PARALLELISM are LEFT at their throttled values. On the
 * local-inference path they are not the binding constraint, and leaving them
 * low keeps the subscription-path ceiling intact for any operator who has NOT
 * moved consolidation off `claude-code` — still switchroom's shipped default
 * provider ({@link HINDSIGHT_DEFAULT_MODEL} / `resolveHindsightLlm`).
 *
 * ## RESTORE CONDITION — before pointing consolidation back at Claude
 *
 * If `hindsight.llm.consolidation` (or the global `hindsight.llm`) is ever set
 * back to `provider: claude-code`, consolidation is once again spending the
 * fleet's shared subscription quota and **these values must go back down**:
 * `MAX_MEMORIES_PER_ROUND` to 100 and
 * {@link HINDSIGHT_DEFAULT_CONSOLIDATION_SLOT_LIMIT} to 1, keeping
 * RESERVED_SLOTS × LLM_PARALLELISM at 2. The failure mode that justifies the
 * throttle is recorded immediately below and has happened for real.
 *
 * ## History — why the hard throttle existed (2026-07-06 incident)
 *
 * Kept, not deleted: it is the reason to be careful about the restore
 * condition above.
 *
 * Consolidation was LLM-bound via the claude-code provider (observed
 * ~510s/op), and every concurrent op was a live claude (Sonnet) subprocess
 * spending the subscription's quota. Since 2026-07-05 hindsight is UNPINNED
 * (auth.consumers[hindsight] has no `account:`) — it follows the fleet-active
 * account and shares the SAME live-turn quota the agents use. That made the
 * hard ceiling on concurrent model calls (MAX_SLOTS × LLM_PARALLELISM) a
 * direct tax on the fleet: on 2026-07-06 an 18-way consolidation fan-out
 * (3 × 6) across multiple banks exhausted the shared account (429 rate-limit
 * wall) and starved live agent turns. Operator decision at the time:
 * hindsight keeps sharing the fleet's failover, but consolidation must NEVER
 * be able to exhaust the quota — so the concurrency ceiling was throttled to
 * 1 × 2 = 2 concurrent model calls (was 18), and per-round scope was cut to
 * 100 so an op could not monopolise a slot for long.
 *
 * ## LLM_BATCH_SIZE is a CONTEXT-WINDOW decision, not only a quota one
 *
 * This block used to read: *"LLM_BATCH_SIZE 12 (unchanged): facts per LLM
 * call — tokens-per-call, not concurrency, so it doesn't affect the
 * shared-quota ceiling."* That was true of the QUOTA ceiling and actively
 * misleading about the CONTEXT ceiling, and it went silently wrong the moment
 * hindsight's backend moved off Claude's 200k window onto a local llama.cpp
 * slot. Nothing in the codebase knew how big the backend's window was.
 *
 * Measured over 24h of live traffic (LiteLLM_SpendLogs, `openai/gpt-oss:20b`,
 * n=695) against a **32,768-token slot** (`-c 65536 -np 2 --context-shift
 * --keep 4`):
 *   - p50 prompt 5,244 tok; **p90 prompt 32,270 tok**; max 32,754 tok — batch
 *     12 routinely produced prompts that filled the entire window.
 *   - 262/695 = **38%** of calls exceeded 16,384 prompt tokens.
 *   - malformed-response rate 44% / 47% on the two local boxes vs **2%** on a
 *     131k-window OpenRouter route. The variable is the window, not the model.
 *
 * And the overflow is INVISIBLE: llama.cpp context-shift discards the oldest
 * tokens keeping only the first `--keep` (=4), which throws away the system
 * prompt and JSON schema mid-generation; the model then answers
 * conversationally and returns **HTTP 200 with `finish_reason: stop`**.
 *
 * So batch size and the completion caps are DERIVED from
 * `hindsight.llm.context_window` and asserted to fit before launch. Picking
 * "better" constants would only relocate the same latent bug to the next
 * backend swap.
 *
 * **Caveat on the p90 above (added 2026-08-09).** That 32,270 figure measures
 * whole prompts at batch 12; it is NOT a per-fact marginal cost, and dividing
 * it by 12 to get one is the mistake that left
 * `HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT` at 2,500 — low by ~1.8×. A
 * 32,768-token backend therefore passed preflight at batch 6 and then
 * truncated in production. The marginal cost has since been measured directly
 * per batch size; see that constant's docstring in
 * `hindsight-context-budget.ts`.
 */
// Batch-size CEILING — the value the derivation lands on whenever the declared
// window is large enough to fit it (131k and 200k both are), so a big-window
// operator keeps the historical tuned 12. The budget only ratchets DOWN from
// here. Kept under the historical name because that is what it still means.
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE =
  HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING;
// Re-exported, not defined here: the value now lives in hindsight-perf-defaults
// so it is a MANAGED key an operator can override via `hindsight.env`. The
// re-export keeps the existing import sites (and their tests) working.
export { HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM } from "./hindsight-perf-defaults.js";



/**
 * Container resource caps (memory + pids only; CPU intentionally NOT capped).
 *
 * Live observed RSS on a 9-agent fleet: 3.4 GiB. Capping memory at
 * 4g prevents a runaway reranker batch from eating the host (which
 * is shared with Coolify on dev/canary boxes and would be shared
 * with the agent fleet on any single-host install). 2g soft
 * reservation protects the working set under host pressure.
 *
 * **CPU cap intentionally NOT set (v0.13.23).** v0.13.22 shipped
 * `--cpus=2.0` on the theory that bursts of concurrent rerank tasks
 * would starve the agent fleet. Live measurement immediately after
 * deploy showed the opposite: the cross-encoder rerank is dominated
 * by per-pair compute, not contention. Capping CPU at 2 cores
 * forced each rerank to serialize through 2 cores instead of using
 * whatever the host had free, which made each pass 3-10x SLOWER
 * (rerank p50 rose from ~4.9s pre-deploy → 7-20s post-deploy,
 * despite all the other smart-defaults staying in place). Removing
 * the cap restored ~2.1s reranks. Bursts are bounded by
 * `RERANKER_LOCAL_MAX_CONCURRENT` (restored to vendor default of 4)
 * — that's the right knob for fleet-fairness, not a wall-clock CPU
 * cap.
 *
 * PIDs cap is defense-in-depth, matches the agent `coding` profile.
 */
// 4g→8g (2026-06-19): baseline RSS is ~3.4g on a 9-agent fleet — only
// ~600m of headroom under the old 4g cap, and the consolidation-throughput
// bump above (LLM_PARALLELISM 4→6 = more in-flight synthesis) pushes it
// higher. 8g gives comfortable headroom on the 60g host. Reservation 2g→4g.
//
// 8g→16g (2026-07-29): the 8g cap stopped being headroom and became a
// treadmill. Live cgroup on `switchroom-hindsight`: `memory.current` pinned
// at 99.5% of the 8 GiB ceiling with ~2.2 GiB of that anon (the API process,
// the embedder, the cross-encoder, next-server) — leaving the working set of
// a ~12 GB bank to fight over the remainder as reclaimable page cache. The
// symptom is not an OOM kill, it is churn: ~24.5 GB/hour re-read from disk
// and 7,400+ reclaim events, i.e. the container is paying disk latency to
// hold a set it very nearly fits. 16g on the 60g host buys the page cache
// room to stop thrashing, and `shared_buffers` moves WITH it in the same
// commit (hindsight-pg-defaults.ts) so the cap and the buffer pool can never
// drift — `hindsight-pg-defaults.test.ts` pins them equal.
//
// **`--memory-swap` is deliberately NOT emitted, on either launch path.**
// When it is omitted Docker sets MemorySwap = 2 × Memory, so the container
// keeps a swap cushion equal to its RAM cap (live: Memory=8g/MemorySwap=16g,
// with ~900 MiB actually in swap — which is why 7,400 reclaim events have
// produced zero OOM kills). Setting `--memory-swap` EQUAL to `--memory`
// disables swap entirely; doing that in the same change that pins ~1.5 GiB
// more unreclaimable shared memory converts graceful degradation into a hard
// OOM kill that takes memory down for the whole fleet. Never emit a
// memory-swap equal to the memory limit — `tests/setup/hindsight.test.ts`
// asserts the invariant on BOTH the run-args and compose paths.
//
// **This is the DEFAULT, not the value.** It was the value until this knob landed: with
// no config path, an operator who raised the live container's cap by hand had
// it silently reverted to 16g by the next `switchroom memory setup --recreate`
// — while `shared_buffers` (which IS configurable, via `hindsight.env`) stayed
// where they had put it. That is how a 16 GiB cap ended up carrying a 12 GiB
// buffer pool on the live fleet. Override with `hindsight.mem_limit`; see
// {@link resolveHindsightMemLimit} for the resolution and
// {@link import("./hindsight-pg-defaults.js").hindsightMemBudgetWarning} for
// the check that now names the dangerous combination out loud.
export const HINDSIGHT_DEFAULT_MEM_LIMIT = "16g";
export const HINDSIGHT_DEFAULT_MEM_RESERVATION = "4g";
export const HINDSIGHT_DEFAULT_PIDS_LIMIT = 1000;

/**
 * `/dev/shm` size for the hindsight container.
 *
 * Hindsight's embedded PostgreSQL allocates large shared-memory segments
 * for parallel query workers / large sorts (observed: a single segment
 * request of ~533MB). Docker's DEFAULT shm is only 64MB, so without this
 * flag every such allocation fails with `could not resize shared memory
 * segment ... No space left on device` and ALL memory writes/queries die
 * (2026-06-06 fleet outage). 2g gives comfortable headroom over the
 * observed peak while staying well under `HINDSIGHT_DEFAULT_MEM_LIMIT`
 * (16g) so shm can't starve the app. Applies to BOTH the standalone
 * `docker run` path and the compose snippet below — keep them in sync.
 */
export const HINDSIGHT_DEFAULT_SHM_SIZE = "2g";

/**
 * Container healthcheck. Hits the in-container `/health` endpoint (which
 * reports DB connectivity) and exits non-zero on any failure — including
 * connection-refused (URLError) and non-200 (HTTPError), both of which
 * raise and propagate to a non-zero process exit. `python3` is always
 * present in the upstream image; `curl`/`wget` are not, so we don't rely
 * on them. `HINDSIGHT_HEALTHCHECK_PY` is the bare script body (compose
 * exec-form `["CMD","python3","-c",PY]`); `HINDSIGHT_HEALTHCHECK_CMD` is
 * the shell string for `docker run --health-cmd`.
 */
export const HINDSIGHT_HEALTHCHECK_PY =
  'import urllib.request,sys; sys.exit(0 if urllib.request.urlopen("http://localhost:8888/health",timeout=4).getcode()==200 else 1)';
export const HINDSIGHT_HEALTHCHECK_CMD = `python3 -c '${HINDSIGHT_HEALTHCHECK_PY}'`;

/**
 * Check if a TCP port is free for binding on 127.0.0.1.
 * Returns true if free, false if something is already listening.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Best-effort: describe the process currently holding `port`, for a loud
 * preflight error. Returns a short "pid 1234 (nginx)" style string, or null
 * when nothing readable holds it (or the probe tools aren't available). Never
 * throws — this is decoration on an error message, not a control-flow signal.
 */
export function describePortHolder(port: number): string | null {
  // `ss` is present on virtually every modern Linux host and needs no root
  // to list listeners with their owning process (-p). Fall back to `lsof`.
  const probes: Array<[string, string[]]> = [
    ["ss", ["-ltnpH", `sport = :${port}`]],
    ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]],
  ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, {
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      if (!out) continue;
      // ss users:(("nginx",pid=1234,fd=6))  |  lsof: nginx 1234 ...
      const ssMatch = out.match(/users:\(\("([^"]+)",pid=(\d+)/);
      if (ssMatch) return `pid ${ssMatch[2]} (${ssMatch[1]})`;
      const firstDataLine = out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !/^COMMAND\b/.test(l));
      if (firstDataLine) {
        const parts = firstDataLine.split(/\s+/);
        if (cmd === "lsof" && parts.length >= 2) {
          return `pid ${parts[1]} (${parts[0]})`;
        }
        return firstDataLine.slice(0, 80);
      }
    } catch {
      // tool missing / non-zero exit — try the next probe.
    }
  }
  return null;
}

/**
 * Preflight guard run by callers immediately before `startHindsight()`.
 * Verifies the chosen host ports are actually bindable RIGHT NOW; if a
 * foreign process already holds one, returns the offending port + a
 * best-effort holder description so the caller can fail LOUD (or reassign)
 * instead of launching a container that will crash-loop on `[Errno 98]
 * address already in use`.
 *
 * This closes the exact gap behind the 2026-07 outage: the `--recreate`
 * path reused the previously-published host port via
 * `getRunningHindsightPorts()` and handed it straight to `docker run`,
 * with no free-check — so when a foreign service (nginx) had claimed that
 * port in the meantime, hindsight crash-looped silently.
 *
 * Returns `null` when both ports are free.
 */
export async function preflightHindsightPorts(ports: {
  apiPort: number;
  uiPort: number;
}): Promise<{ port: number; holder: string | null } | null> {
  for (const port of [ports.apiPort, ports.uiPort]) {
    if (!(await isPortFree(port))) {
      return { port, holder: describePortHolder(port) };
    }
  }
  return null;
}

/**
 * Find a free port starting at `start`, incrementing until one is found
 * or `maxAttempts` ports have been tried.
 */
export async function findFreePort(
  start: number,
  maxAttempts = 50,
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = start + i;
    if (port < 1024) continue;
    if (await isPortFree(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Pick host ports for the Hindsight container.
 */
export async function pickHindsightPorts(): Promise<{
  apiPort: number;
  uiPort: number;
}> {
  if (
    (await isPortFree(HINDSIGHT_DEFAULT_API_PORT)) &&
    (await isPortFree(HINDSIGHT_DEFAULT_UI_PORT))
  ) {
    return {
      apiPort: HINDSIGHT_DEFAULT_API_PORT,
      uiPort: HINDSIGHT_DEFAULT_UI_PORT,
    };
  }
  const apiPort = await findFreePort(18888);
  const uiPort = await findFreePort(19999);
  if (apiPort === null || uiPort === null) {
    throw new Error(
      "Could not find a free port for Hindsight. " +
        "Stop whatever is using 18888 / 19999 and retry.",
    );
  }
  return { apiPort, uiPort };
}

/**
 * Wall-clock budget for the one-shot `docker ps` / `docker --version` probes
 * below.
 *
 * The docker CLI has NO client-side request timeout: against an unresponsive
 * dockerd these calls block FOREVER, and an unbounded `execFileSync` here
 * hangs whatever called it. That is load-bearing on the rollout path —
 * {@link isHindsightContainerExists} is reached from `executeRollout`'s
 * `refresh-hindsight` step, so a hang here strands hostd's
 * `fleetMutationInFlight` latch exactly the way the unbounded subcommand
 * spawns did (see `ROLLOUT_PROBE_TIMEOUT_MS` in `src/cli/rollout.ts`).
 *
 * A healthy daemon answers these in milliseconds, so anything past this
 * budget IS the wedge. All three probes already fail closed on any throw, and
 * a timeout throws — so bounding them changes nothing on a healthy host and
 * converts an infinite hang into a clean `false` on a wedged one.
 */
export const DOCKER_PROBE_TIMEOUT_MS = 60 * 1000;

/**
 * Minimal one-shot docker runner: stdout on success, `null` on ANY failure
 * (non-zero exit, docker absent, or a timeout kill against a wedged daemon).
 *
 * Injectable so the rollout executor can supply a runner bounded by its own
 * budget, and so tests can exercise these probes without docker.
 */
export type DockerProbe = (args: string[]) => string | null;

export const defaultDockerProbe: DockerProbe = (args) => {
  try {
    return execFileSync("docker", args, {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: DOCKER_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch {
    return null;
  }
};

/**
 * Why docker can't be used, when it can't.
 *
 * `docker --version` succeeding only proves the CLI is on PATH. On macOS
 * (Docker Desktop ships the CLI but the VM is frequently stopped) that is
 * the far more common failure, and telling the operator to "install Docker"
 * when it is already installed sends them down the wrong road — review L8.
 * `docker ps` is the cheapest probe that actually reaches the daemon.
 */
export type DockerAvailability = "ok" | "no-cli" | "daemon-unreachable";

/**
 * Distinguish "no docker CLI on PATH" from "CLI present, daemon not
 * answering", so callers can print the right next step.
 */
export function probeDockerAvailability(
  probe: DockerProbe = defaultDockerProbe,
): DockerAvailability {
  if (probe(["--version"]) === null) return "no-cli";
  if (probe(["ps", "--quiet"]) === null) return "daemon-unreachable";
  return "ok";
}

/**
 * Check if Docker is usable — CLI present AND daemon reachable.
 */
export function isDockerAvailable(probe: DockerProbe = defaultDockerProbe): boolean {
  return probeDockerAvailability(probe) === "ok";
}

/**
 * Docker's `--filter name=…` is a SUBSTRING match, so `name=switchroom-hindsight`
 * also matches the recall-pool sibling `switchroom-hindsight-recall`. Every
 * "is the authority container up/present?" check must therefore match the name
 * EXACTLY, or a running pool with a dead authority reads as "authority up" (and
 * the reverse). We filter by the shared prefix (cheap server-side narrowing)
 * and then exact-compare `{{.Names}}` in-process — robust across docker
 * versions, which disagree on whether an anchored `^…$` regex sees the leading
 * `/`. Returns whether any returned row's name equals `want` exactly.
 */
export function dockerNameMatchesExactly(
  probe: DockerProbe,
  args: string[],
  want: string,
): boolean {
  const out = probe(args);
  return (out ?? "")
    .split("\n")
    .map((n) => n.trim())
    .some((n) => n === want);
}

/**
 * Check if the switchroom-hindsight AUTHORITY container is currently running.
 * Exact-name match, so a running recall-pool sibling never counts as the
 * authority being up (see {@link dockerNameMatchesExactly}).
 */
export function isHindsightRunning(probe: DockerProbe = defaultDockerProbe): boolean {
  return dockerNameMatchesExactly(
    probe,
    ["ps", "--filter", "name=switchroom-hindsight", "--format", "{{.Names}}"],
    HINDSIGHT_CONTAINER_NAME,
  );
}

/**
 * Check if the switchroom-hindsight AUTHORITY container exists (running or
 * stopped). Exact-name match for the same reason as {@link isHindsightRunning}.
 */
export function isHindsightContainerExists(probe: DockerProbe = defaultDockerProbe): boolean {
  return dockerNameMatchesExactly(
    probe,
    ["ps", "-a", "--filter", "name=switchroom-hindsight", "--format", "{{.Names}}"],
    HINDSIGHT_CONTAINER_NAME,
  );
}

/**
 * LiteLLM routing config for the hindsight container. When provided to
 * `startHindsight`, the container switches to `--network host` (so
 * `127.0.0.1:4010` is directly reachable) and the Claude Agent SDK
 * subprocess inherits `ANTHROPIC_BASE_URL` + `ANTHROPIC_CUSTOM_HEADERS`,
 * routing consolidation/reflect LLM calls through the proxy for spend
 * tracking and guardrails while keeping the Max subscription as the
 * billing source.
 */
export interface LiteLLMHindsightConfig {
  /** LiteLLM proxy base URL, e.g. 'http://127.0.0.1:4010'. */
  baseUrl: string;
  /** Per-service virtual key for spend attribution. */
  apiKey: string;
  /**
   * LiteLLM model_name for Hindsight's LLM ops. Defaults to
   * {@link HINDSIGHT_DEFAULT_LITELLM_MODEL} when omitted. A Claude model/alias
   * (per {@link isClaudeModel}) rides the Anthropic OAuth pass-through;
   * anything else rides the model-mapped route.
   */
  model?: string;
}

/**
 * Operator override for the hindsight container's LLM (both fields
 * optional). Sourced from the top-level `hindsight.llm` block in
 * switchroom.yaml (see `HindsightConfigSchema` in `src/config/schema.ts`)
 * and threaded through `startHindsight` / `generateHindsightComposeSnippet`.
 *
 * When absent (or a field is absent), the container falls back to the
 * subscription-honest defaults: provider=`claude-code`, model=
 * {@link HINDSIGHT_DEFAULT_MODEL}. So an operator who sets nothing gets the
 * exact prior behaviour.
 */
export interface HindsightLlmConfig {
  /** `HINDSIGHT_API_LLM_PROVIDER`. Default `claude-code`. */
  provider?: string;
  /** `HINDSIGHT_API_LLM_MODEL`. Default {@link HINDSIGHT_DEFAULT_MODEL}. */
  model?: string;
  /**
   * Global `HINDSIGHT_API_LLM_BASE_URL`. Default endpoint every op inherits
   * absent a per-op `base_url`. Emitted only when set (#3687). A loopback value
   * forces host networking via {@link collectHindsightLlmBaseUrls}.
   */
  base_url?: string;
  /**
   * Global `HINDSIGHT_API_LLM_API_KEY`. Default credential every op inherits
   * absent a per-op `api_key`. Emitted only when set (#3687).
   */
  api_key?: string;
  /**
   * Declared context window (tokens) of the backend. NOT an upstream env var
   * — switchroom derives the token budget from it (see
   * `hindsight-context-budget.ts`). Absent → a per-provider default.
   */
  context_window?: number;
  /** Per-op override for the `retain` LLM op. Falls back to the global. */
  retain?: HindsightPerOpLlmConfig;
  /** Per-op override for the `reflect` LLM op. Falls back to the global. */
  reflect?: HindsightPerOpLlmConfig;
  /** Per-op override for the `consolidation` LLM op. Falls back to the global. */
  consolidation?: HindsightPerOpLlmConfig;
}

/**
 * Per-operation LLM override (retain / reflect / consolidation). The engine
 * reads `HINDSIGHT_API_<OP>_LLM_MODEL` (+ `_PROVIDER` / `_BASE_URL` /
 * `_API_KEY` siblings) and, for any field NOT set, falls back to the global
 * `HINDSIGHT_API_LLM_*`. So switchroom only emits the vars an operator
 * actually configured — an absent field means "inherit the global", which is
 * already the engine's behaviour. All fields optional.
 */
export interface HindsightPerOpLlmConfig {
  /** `HINDSIGHT_API_<OP>_LLM_MODEL`. */
  model?: string;
  /** `HINDSIGHT_API_<OP>_LLM_PROVIDER`. */
  provider?: string;
  /** `HINDSIGHT_API_<OP>_LLM_BASE_URL`. snake_case to match the zod config shape. */
  base_url?: string;
  /** `HINDSIGHT_API_<OP>_LLM_API_KEY`. snake_case to match the zod config shape. */
  api_key?: string;
  /**
   * Declared context window (tokens) for THIS op's backend. Overrides the
   * global `hindsight.llm.context_window`. Not emitted as env — it drives the
   * derived token budget. All three lanes are budgeted independently, so a
   * value here only ratchets this op.
   */
  context_window?: number;
}

/** The three LLM ops that support a per-op model override. */
const HINDSIGHT_LLM_OPS = ["retain", "reflect", "consolidation"] as const;
type HindsightLlmOp = (typeof HINDSIGHT_LLM_OPS)[number];

/**
 * Resolve the per-op LLM env vars from an optional operator override. Returns
 * a flat `[key, value]` list — ONLY the vars an operator actually set, so an
 * unconfigured op (or unset field) emits nothing and the engine transparently
 * falls back to the global `HINDSIGHT_API_LLM_*`. Never emits empty values.
 *
 * Shared by the `docker run` path ({@link startHindsight}) and the compose-gen
 * path ({@link generateHindsightComposeSnippet}) so they never drift.
 */
export function resolveHindsightPerOpLlm(
  llm?: HindsightLlmConfig,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!llm) return out;
  for (const op of HINDSIGHT_LLM_OPS) {
    const cfg = llm[op as HindsightLlmOp] as HindsightPerOpLlmConfig | undefined;
    if (!cfg) continue;
    const prefix = `HINDSIGHT_API_${op.toUpperCase()}_LLM`;
    const model = cfg.model?.trim();
    const provider = cfg.provider?.trim();
    const baseUrl = cfg.base_url?.trim();
    const apiKey = cfg.api_key?.trim();
    if (model) out.push([`${prefix}_MODEL`, model]);
    if (provider) out.push([`${prefix}_PROVIDER`, provider]);
    if (baseUrl) out.push([`${prefix}_BASE_URL`, baseUrl]);
    if (apiKey) out.push([`${prefix}_API_KEY`, apiKey]);
  }
  return out;
}

/**
 * Resolve the GLOBAL LLM passthrough env vars (`HINDSIGHT_API_LLM_BASE_URL` /
 * `HINDSIGHT_API_LLM_API_KEY`) from an optional operator override. Returns ONLY
 * the vars actually set — an unset field emits nothing and the engine uses its
 * provider default (#3687). Symmetric with {@link resolveHindsightPerOpLlm} and
 * shared by both launch paths so docker-run and compose never drift. Never
 * emits empty values.
 */
export function resolveHindsightGlobalLlmExtras(
  llm?: HindsightLlmConfig,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!llm) return out;
  const baseUrl = llm.base_url?.trim();
  const apiKey = llm.api_key?.trim();
  if (baseUrl) out.push(["HINDSIGHT_API_LLM_BASE_URL", baseUrl]);
  if (apiKey) out.push(["HINDSIGHT_API_LLM_API_KEY", apiKey]);
  return out;
}

/**
 * Resolve the effective hindsight LLM provider + model from an optional
 * operator override, applying the hard-coded fallbacks. Shared by the
 * `docker run` path ({@link startHindsight}) and the compose-gen path
 * ({@link generateHindsightComposeSnippet}) so they never drift.
 */
export function resolveHindsightLlm(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
): { provider: string; model: string } {
  const provider = llm?.provider?.trim() || "claude-code";
  // Model precedence: an explicit `hindsight.llm.model` always wins. Absent
  // that, with LiteLLM routing enabled the default shifts to a cheap
  // OpenRouter model (litellm.model ?? HINDSIGHT_DEFAULT_LITELLM_MODEL)
  // instead of Claude — the proxy can translate a non-Claude model name.
  // Direct-OAuth mode (no litellm, or fail-open) stays on
  // HINDSIGHT_DEFAULT_MODEL, since no proxy exists to translate it.
  const model =
    llm?.model?.trim() ||
    (litellm ? (litellm.model ?? HINDSIGHT_DEFAULT_LITELLM_MODEL) : HINDSIGHT_DEFAULT_MODEL);
  return { provider, model };
}

/**
 * Start the Hindsight Docker container in **broker-fed** mode (RFC H §4.8).
 *
 * Hindsight uses the upstream `claude-code` LLM provider, which routes
 * consolidation/recall through the user's Claude Pro/Max subscription
 * via `claude_agent_sdk.query()`. No OpenAI / Anthropic API key is
 * required — credentials are fetched at boot from the auth-broker over
 * the per-consumer UDS bind-mounted as the named volume
 * `auth-broker-hindsight-sock` (chowned by the broker to the consumer
 * UID, see `auth.consumers[]` in switchroom.yaml).
 *
 * @param ports - Optional host port mapping. If omitted, falls back to the
 *   switchroom defaults (`HINDSIGHT_DEFAULT_API_PORT` 18888 /
 *   `HINDSIGHT_DEFAULT_UI_PORT` 9999).
 * @param litellm - Optional LiteLLM routing config. When provided, the
 *   container uses `--network host` so 127.0.0.1:4010 is reachable, and
 *   the claude subprocess inherits LiteLLM proxy env vars. The API port is
 *   preserved via `HINDSIGHT_API_PORT` (the only port knob the upstream
 *   config.py recognizes; the CP service has no env var override).
 */

/**
 * `isLoopbackHttpUrl` / `isSelfHostedHttpUrl` now live in `self-hosted-url.ts`
 * and are re-exported here so every existing importer is unchanged. They moved
 * (#3723) because `hindsight-context-budget.ts` must read the SAME self-hosted
 * signal when defaulting a lane's context window, and it cannot import this
 * module (this module imports it — cycle).
 */
export { isLoopbackHttpUrl, isSelfHostedHttpUrl } from "./self-hosted-url.js";

/**
 * Collect every configured LiteLLM / per-op LLM base URL from the same inputs
 * `startHindsight` / `generateHindsightComposeSnippet` take. Order is
 * stable: explicit `litellm.baseUrl` first, then retain/reflect/consolidation
 * per-op base URLs in that op order.
 */
export function collectHindsightLlmBaseUrls(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    const v = raw?.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  push(litellm?.baseUrl);
  // Global base URL (#3687) forces host networking on a loopback value exactly
  // like a per-op one — otherwise compose stays on bridge and the emitted
  // http://127.0.0.1:… is unreachable (the same silent outage the per-op path
  // fixed). Ordered before per-op so the global endpoint reports first.
  push(llm?.base_url);
  for (const [k, v] of resolveHindsightPerOpLlm(llm)) {
    if (k.endsWith("_BASE_URL")) push(v);
  }
  return out;
}

/**
 * Whether the hindsight container must use host networking so LLM base URLs
 * remain reachable. Mirrors `startHindsight`: an explicit LiteLLM routing
 * config always forces host network; otherwise any configured per-op base
 * URL that points at host loopback does the same (compose used to stay on
 * bridge forever while still emitting `http://127.0.0.1:4010` — silent retain
 * outage that doctor now flags).
 */
export function hindsightNeedsHostNetwork(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
): boolean {
  if (litellm?.baseUrl?.trim()) return true;
  return collectHindsightLlmBaseUrls(llm).some(isLoopbackHttpUrl);
}

/**
 * Address the hindsight API binds under `--network host`.
 *
 * The hindsight API is **TOKENLESS** — no auth, no securitySchemes, every
 * bank readable and writable by anyone who can open the socket. On the bridge
 * path that is contained by publishing `127.0.0.1:<port>:8888`, but
 * `--network host` makes docker ignore `-p` entirely, so the `-p` flags are
 * not a control there: the only thing standing between the fleet's memory and
 * the LAN/tailnet is the address the application itself binds. The image
 * defaults to `0.0.0.0`.
 */
export const HINDSIGHT_HOST_NETWORK_BIND_ADDR = "127.0.0.1";

/**
 * THE bind pins every `--network host` hindsight launch must carry.
 *
 * Under host networking the container has no netns of its own, so the
 * listener's address and port are host-visible facts rather than
 * container-internal ones, and `-p` publishing (the bridge path's loopback
 * containment) is silently ignored by docker. Every host-network path —
 * `startHindsight`'s docker-run argv and the compose snippet alike — takes
 * its bind from here so the containment cannot be present on one and
 * forgotten on the other. Emitting it from the branches themselves is exactly
 * how the API ended up answering unauthenticated on `0.0.0.0:18888`.
 */
export function hindsightHostNetworkBindEnvPairs(
  apiPort: number,
): Array<[string, string]> {
  return [
    // Bind loopback only. See HINDSIGHT_HOST_NETWORK_BIND_ADDR: the API has no
    // auth, so a 0.0.0.0 bind on the host stack publishes every agent's memory
    // bank to the LAN and the tailnet.
    ["HINDSIGHT_API_HOST", HINDSIGHT_HOST_NETWORK_BIND_ADDR],
    // HINDSIGHT_API_PORT is the only port knob the upstream config.py
    // recognizes; the CP service has no equivalent env var override. Without
    // it the image default 8888 binds on the shared host stack.
    ["HINDSIGHT_API_PORT", String(apiPort)],
    // The CP dashboard's dataplane calls resolve `localhost:<port>` against
    // host-bound listeners. The image default is `http://localhost:8888`, but
    // 8888 is where we MOVED OFF (squatted by an unrelated container → the
    // dashboard's data calls 502 while the API is healthy on the API port).
    // Pin it to the SAME port the API actually binds so it tracks any
    // auto-bump instead of the stale 8888 default.
    ["HINDSIGHT_CP_DATAPLANE_API_URL", `http://localhost:${apiPort}`],
  ];
}

/**
 * Address the CP dashboard (Next.js, port 9999) binds under `--network host`
 * when NO access key is configured.
 *
 * Upstream `start-all.sh` exports `HOSTNAME="${HINDSIGHT_CP_HOSTNAME:-0.0.0.0}"`
 * before `node server.js`, so absent this pin the dashboard listens on every
 * host address. That is only safe when the access-key middleware is armed —
 * and the middleware is a NO-OP when `HINDSIGHT_CP_ACCESS_KEY` is unset
 * (verified in the shipped edge bundle: the handler reads the var and
 * short-circuits to `next()` when it is falsy, so no protected route is
 * enforced at all). "Unauthenticated service on 0.0.0.0 under host
 * networking" is the same exposure shape the API had before
 * {@link HINDSIGHT_HOST_NETWORK_BIND_ADDR}, so it gets the same containment:
 * no key ⇒ loopback only.
 */
export const HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR = "127.0.0.1";

/** Bind the CP dashboard on every host address (upstream's own default). */
export const HINDSIGHT_CP_AUTHENTICATED_BIND_ADDR = "0.0.0.0";

/**
 * Operator-facing warning every launch path emits when the CP dashboard is
 * started without an access key. Exported so the docker-run CLI and the
 * compose emitter cannot word it differently — or forget it.
 */
export const HINDSIGHT_CP_NO_ACCESS_KEY_WARNING =
  "hindsight: no `hindsight.cp_access_key` configured — the control-plane " +
  "dashboard has NO login (the access-key middleware is inert when " +
  "HINDSIGHT_CP_ACCESS_KEY is unset), so it is pinned to " +
  `${HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR} and will NOT be reachable from ` +
  "the LAN or tailnet. Set `hindsight.cp_access_key: vault:<key>` in " +
  "switchroom.yaml to arm the login and open it up.";

/**
 * THE control-plane auth env every hindsight launch path must carry.
 *
 * Two coupled facts, which is why they are derived together and in ONE place:
 *
 *  1. `HINDSIGHT_CP_ACCESS_KEY` is what arms the CP login middleware. Absent,
 *     the middleware passes every request through — the dashboard is not
 *     "weakly protected", it is unprotected.
 *  2. `HINDSIGHT_CP_HOSTNAME` is what decides who can reach it. Under
 *     `--network host` docker ignores `-p`, so this env var is the only
 *     containment (exactly like the API's `HINDSIGHT_API_HOST`). On bridge the
 *     `-p 127.0.0.1:<uiPort>:9999` publish already confines it, and pinning
 *     the in-netns bind to loopback there would break the publish outright —
 *     so the bind is emitted on the host-network path only.
 *
 * The verdict: a dashboard reachable off-host REQUIRES a key. With a key we
 * bind `0.0.0.0` (the operator asked for LAN/tailnet, and the middleware is
 * now armed); without one we fail CLOSED to loopback rather than silently
 * serving an open dashboard to the LAN. Emitted from here by
 * {@link startHindsight}'s docker-run argv AND
 * {@link generateHindsightComposeSnippet} so the two can never disagree.
 */
export function hindsightCpAuthEnvPairs(opts: {
  /** Resolved access key (post-`vault:` lookup). Blank/absent ⇒ no login. */
  accessKey?: string;
  /** Whether this launch takes `--network host` / `network_mode: host`. */
  hostNetwork: boolean;
}): Array<[string, string]> {
  const key = opts.accessKey?.trim();
  const pairs: Array<[string, string]> = [];
  if (key) pairs.push(["HINDSIGHT_CP_ACCESS_KEY", key]);
  if (opts.hostNetwork) {
    pairs.push([
      "HINDSIGHT_CP_HOSTNAME",
      key ? HINDSIGHT_CP_AUTHENTICATED_BIND_ADDR : HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR,
    ]);
  }
  return pairs;
}

/**
 * Resolve the operator's `hindsight.cp_access_key` to the actual secret.
 *
 * A literal is returned as-is; a `vault:<key>` reference is read through the
 * broker — the same shape `hindsight.llm.<op>.api_key` and `litellm.admin_key`
 * take (`resolveConfigSecret` in src/cli/apply.ts). NEVER read the vault file
 * directly: from inside a container it isn't mounted, and on the host the
 * broker is the audited path.
 *
 * Returns `undefined` when there is no config value OR when the reference
 * cannot be resolved. Both collapse to "no key", which is deliberately the
 * fail-CLOSED input to {@link hindsightCpAuthEnvPairs}: an unresolvable vault
 * ref must not silently produce an open dashboard. Callers warn with
 * {@link HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}.
 */
export async function resolveHindsightCpAccessKey(
  config: { hindsight?: { cp_access_key?: string } } | undefined,
  deps: HindsightVaultResolveDeps = {},
): Promise<string | undefined> {
  return resolveHindsightVaultString(config?.hindsight?.cp_access_key, deps);
}

/** Injection seam shared by the module's `vault:`-ref resolvers. */
type HindsightVaultResolveDeps = {
  getViaBrokerStructured?: typeof import("../vault/broker/client.js").getViaBrokerStructured;
};

/**
 * Resolve a single config value that may be a `vault:<key>` reference to its
 * string secret, through the auto-unlocked broker. THE non-interactive vault
 * path this module depends on — no operator passphrase, so it works from the
 * `memory setup --recreate` launch and hostd's `refresh-hindsight` rollout step
 * where `switchroom apply`'s passphrase resolver (`resolveConfigSecret`,
 * src/cli/apply.ts) is unavailable.
 *
 * A non-`vault:` literal is returned trimmed as-is (the broker is never
 * touched). A `vault:` reference that cannot be resolved — denied, missing,
 * non-string, blank, or broker down — returns `undefined`. That is the
 * fail-safe every caller here wants: NEVER return the literal `vault:…` string,
 * which the container would otherwise bake into its env verbatim (LiteLLM then
 * rejects it: "Virtual Key expected … start with 'sk-'", the 2026-08-06
 * fleet-wide retain outage).
 */
async function resolveHindsightVaultString(
  ref: string | undefined,
  deps: HindsightVaultResolveDeps = {},
): Promise<string | undefined> {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  const { isVaultReference, parseVaultReference } = await import("../vault/resolver.js");
  if (!isVaultReference(trimmed)) return trimmed;
  const brokerClient = await import("../vault/broker/client.js");
  const get = deps.getViaBrokerStructured ?? brokerClient.getViaBrokerStructured;
  // Issue #1053: forward the agent's capability token so the broker's grant
  // path bypasses the peercred ACL. Without it a freshly-minted grant is
  // ignored and the `.catch(() => null)` silently swallows the DENIED, leaving
  // the secret underived under `memory setup --recreate`. Mirrors the working
  // `vault get` path in src/cli/vault.ts. Token stays undefined when
  // SWITCHROOM_AGENT_NAME is unset — identical to prior host-operator peercred
  // behavior.
  const agentSlug = process.env.SWITCHROOM_AGENT_NAME;
  const token = agentSlug ? brokerClient.readVaultTokenFile(agentSlug) ?? undefined : undefined;
  const resolved = await get(parseVaultReference(trimmed), {
    ...(token ? { token } : {}),
  }).catch(() => null);
  if (!resolved || resolved.kind !== "ok" || resolved.entry.kind !== "string") {
    return undefined;
  }
  const value = resolved.entry.value.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The vault key that authenticates hindsight's LiteLLM passthrough.
 *
 * Deliberately NOT the top-level `litellm.admin_key` (`vault:litellm/master-key`):
 * that is the proxy's master credential and has no business inside a service
 * container. This is the per-service virtual key `switchroom apply` provisions,
 * and it is the ONLY key that should ever appear as the
 * `ANTHROPIC_CUSTOM_HEADERS` bearer — see `src/litellm/key-allowlist.ts`.
 * Byte-pinned against `HINDSIGHT_KEY_VAULT_REF` (the doctor check's copy) by
 * `hindsight-litellm-env.test.ts`; the constant is duplicated rather than
 * imported only to keep `src/litellm/`'s doctor/provision import graph out of
 * this module.
 */
export const HINDSIGHT_LITELLM_KEY_VAULT_REF = "litellm/hindsight/api-key";

/** Outcome of {@link resolveHindsightLiteLlm}. */
export interface HindsightLiteLlmResolution {
  /**
   * The routing config to hand `startHindsight` /
   * {@link hindsightContainerEnvPairs}. Absent when LiteLLM is not enabled for
   * this fleet, or when its key could not be resolved (see {@link droppedRef}).
   */
  litellm?: LiteLLMHindsightConfig;
  /**
   * Set ONLY when LiteLLM *is* enabled and configured but its key did not
   * resolve — i.e. the launch is about to silently drop proxy routing. Carries
   * the `vault:<key>` REFERENCE, never the secret. Callers must surface it;
   * {@link hindsightLiteLlmDroppedKeyWarning} is the sanctioned wording.
   */
  droppedRef?: string;
}

/**
 * Resolve the hindsight container's LiteLLM routing config, reporting a
 * dropped key instead of swallowing it.
 *
 * ## The failure this exists to make visible
 *
 * The predecessor of this function returned a bare `undefined` for every
 * outcome — LiteLLM off, LiteLLM on but the broker denied, LiteLLM on but the
 * broker was down. So a denied grant made `memory setup --recreate` launch
 * hindsight with NO `ANTHROPIC_BASE_URL` / `ANTHROPIC_CUSTOM_HEADERS` and say
 * nothing about it. The container comes up healthy, reflect/consolidation go
 * straight to the provider, and the spend simply stops appearing in
 * `LiteLLM_SpendLogs` under `end_user=hindsight`. The only trace is the
 * env-drift report listing the two vars as dropped — which reads as operator
 * drift ("were set imperatively") and has been misdiagnosed as exactly that.
 * Observed live 2026-08-07: `litellm/hindsight/api-key` denied to a caller
 * without a standing grant, routing silently gone.
 *
 * The two sibling resolvers on this same launch path already fail loudly — a
 * missing `cp_access_key` prints {@link HINDSIGHT_CP_NO_ACCESS_KEY_WARNING},
 * a dropped LLM api_key prints {@link hindsightLlmDroppedKeyWarning}. This is
 * the third secret on the path and it is now held to the same standard.
 *
 * Never returns the literal `vault:…` string as a key (see
 * {@link resolveHindsightVaultString}) — a `vault:` bearer would be rejected
 * by LiteLLM at auth, which is the 2026-08-06 outage shape.
 */
export async function resolveHindsightLiteLlm(
  config:
    | {
        litellm?: { enabled?: boolean; base_url?: string };
        memory?: { config?: { llm_model?: string } };
      }
    | undefined,
  deps: HindsightVaultResolveDeps = {},
): Promise<HindsightLiteLlmResolution> {
  const top = config?.litellm;
  // Not enabled (or no proxy URL) ⇒ routing is *meant* to be absent. Not a drop
  // and not a warning: the operator has not asked for a metered lane.
  if (!top?.enabled || !top.base_url?.trim()) return {};
  const ref = `vault:${HINDSIGHT_LITELLM_KEY_VAULT_REF}`;
  const apiKey = await resolveHindsightVaultString(ref, deps);
  if (!apiKey) return { droppedRef: ref };
  return {
    litellm: {
      baseUrl: top.base_url,
      apiKey,
      model: config?.memory?.config?.llm_model,
    },
  };
}

/**
 * Operator-facing wording for a dropped LiteLLM routing key. Takes the
 * `vault:<key>` reference and NEVER the resolved secret — same contract as
 * {@link hindsightLlmDroppedKeyWarning}.
 */
export function hindsightLiteLlmDroppedKeyWarning(ref: string): string {
  return (
    `hindsight: LiteLLM routing key \`${ref}\` did not resolve through the ` +
    "vault broker (denied, missing, or broker down) — ANTHROPIC_BASE_URL and " +
    "ANTHROPIC_CUSTOM_HEADERS were DROPPED, so hindsight's LLM traffic will " +
    "bypass the proxy entirely and its spend will NOT be metered under " +
    "`end_user=hindsight`. Check the broker grant for the reference above, " +
    "then re-run. If an ENV DRIFT report above named those two vars, THIS is " +
    "why — it is NOT operator env drift."
  );
}

/**
 * Resolve every `vault:<key>` reference in a hindsight LLM config's API-key
 * fields to its real secret, through the auto-unlocked broker — the SAME
 * non-interactive path {@link resolveHindsightCpAccessKey} uses.
 *
 * WHY this exists (fleet outage 2026-08-06): vault-ref resolution for the
 * global `hindsight.llm.api_key` and the per-op `hindsight.llm.<op>.api_key`
 * used to happen ONLY inside `switchroom apply` (`resolveConfigSecret`,
 * src/cli/apply.ts), behind the operator passphrase. The
 * `memory setup --recreate` launch path ({@link startHindsight}) and hostd's
 * `refresh-hindsight` rollout step run WITHOUT that resolver, so they passed the
 * literal `vault:…` string straight into the container env via the emit paths
 * ({@link resolveHindsightGlobalLlmExtras} / {@link resolveHindsightPerOpLlm}).
 * LiteLLM rejected it and ALL fact extraction failed fleet-wide. Resolving here
 * — before either emit path sees the value — bakes the real `sk-` key instead.
 *
 * Returns a shallow clone with only the api_key fields rewritten; every other
 * field (model / provider / base_url / context_window, and the rest of each
 * per-op block) is preserved untouched. A non-`vault:` literal passes through.
 * An unresolvable ref DROPS that api_key (the field is omitted, so the emit path
 * skips it) — the op then inherits the global / provider default rather than
 * baking a guaranteed-invalid literal, the same fail-safe shape the CP key
 * takes. `undefined` in ⇒ `undefined` out (no config, nothing to do).
 */
export async function resolveHindsightLlmSecrets(
  llm: HindsightLlmConfig | undefined,
  deps: HindsightVaultResolveDeps = {},
): Promise<HindsightLlmConfig | undefined> {
  if (!llm) return llm;
  const out: HindsightLlmConfig = { ...llm };
  // Global api_key. `api_key` set-but-unresolvable collapses to undefined, which
  // the emit path treats identically to "absent" (it skips empty values).
  if (llm.api_key !== undefined) {
    out.api_key = await resolveHindsightVaultString(llm.api_key, deps);
  }
  // Per-op api_keys (retain / reflect / consolidation). Clone each present block
  // so we never mutate the caller's config object in place.
  for (const op of HINDSIGHT_LLM_OPS) {
    const cfg = llm[op as HindsightLlmOp];
    if (cfg?.api_key !== undefined) {
      out[op as HindsightLlmOp] = {
        ...cfg,
        api_key: await resolveHindsightVaultString(cfg.api_key, deps),
      };
    }
  }
  return out;
}

/**
 * A hindsight LLM api_key `vault:` reference that FAILED to resolve and was
 * dropped by {@link resolveHindsightLlmSecrets}. Carries the lane it belonged
 * to and the reference string ONLY — never the resolved `sk-` secret.
 */
export interface DroppedHindsightLlmVaultKey {
  /** `"global"`, or a per-op name: `retain` / `reflect` / `consolidation`. */
  lane: string;
  /** The `vault:<key>` reference that could not be resolved. NEVER a secret. */
  ref: string;
}

/**
 * Diff an LLM config against its {@link resolveHindsightLlmSecrets} output to
 * find every api_key `vault:` reference that failed to resolve and was dropped.
 *
 * A drop means that lane silently falls back to the inherited / provider-default
 * credential instead of the operator's configured key — invisible otherwise.
 * The launch paths warn on it exactly as {@link HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}
 * warns on a dropped CP key (see {@link hindsightLlmDroppedKeyWarning}).
 *
 * Only `vault:` references are reported: a literal that resolves to itself is
 * never "dropped", and an absent field was never configured. The returned `ref`
 * is the `vault:<key>` reference string only — the whole point of resolving
 * before launch is that the `sk-` value NEVER reaches an operator-facing surface.
 */
export async function diffDroppedHindsightLlmVaultKeys(
  original: HindsightLlmConfig | undefined,
  resolved: HindsightLlmConfig | undefined,
): Promise<DroppedHindsightLlmVaultKey[]> {
  if (!original) return [];
  const { isVaultReference } = await import("../vault/resolver.js");
  const drops: DroppedHindsightLlmVaultKey[] = [];
  const check = (lane: string, origKey: string | undefined, resolvedKey: string | undefined) => {
    const ref = origKey?.trim();
    // A vault ref present in the input but absent from the output is a drop; a
    // literal (resolves to itself) or an unset field is not.
    if (ref && isVaultReference(ref) && !resolvedKey) drops.push({ lane, ref });
  };
  check("global", original.api_key, resolved?.api_key);
  for (const op of HINDSIGHT_LLM_OPS) {
    check(
      op,
      original[op as HindsightLlmOp]?.api_key,
      resolved?.[op as HindsightLlmOp]?.api_key,
    );
  }
  return drops;
}

/**
 * Operator-facing warning the launch paths emit when a hindsight LLM api_key
 * `vault:` reference could not be resolved and was dropped. The symmetric
 * counterpart to {@link HINDSIGHT_CP_NO_ACCESS_KEY_WARNING}: a dropped LLM key
 * is otherwise silent, and the lane quietly runs on the inherited / provider
 * default credential — so fact extraction on that lane can fail with no trace.
 * Names the lane and the `vault:` reference; NEVER the resolved secret.
 */
export function hindsightLlmDroppedKeyWarning(drop: DroppedHindsightLlmVaultKey): string {
  const where =
    drop.lane === "global" ? "the global LLM lane" : `the \`${drop.lane}\` LLM op`;
  const fallback =
    drop.lane === "global" ? "every op inherits" : "the op inherits";
  return (
    `hindsight: ${where} api_key \`${drop.ref}\` did not resolve through the ` +
    "vault broker (denied, missing, or broker down) — the key was DROPPED, so " +
    `${fallback} the provider-default credential and fact extraction on that ` +
    "lane may fail. Check the broker grant for the reference above, then re-run."
  );
}

/**
 * Whether hindsight's LLM traffic terminates on a self-hosted endpoint.
 *
 * The capability gate for the LLM concurrency caps (see
 * `hindsight-perf-defaults.ts`): upstream's default of 32 concurrent requests
 * assumes a cloud provider, and on a local endpoint it starves every other
 * client sharing the box. Reads the SAME inputs the launch paths already take,
 * via {@link collectHindsightLlmBaseUrls}, so it can never disagree with the
 * host-network / health-probe decisions made from those URLs.
 *
 * No configured base URL at all ⇒ `false` ⇒ upstream's default stands. That is
 * the fail-safe reading: a hosted provider throttled to 4 would be a
 * throughput regression for no reason.
 *
 * @param override Test/caller seam, mirroring `hindsightGpuEnabled(override?)`.
 */
export function hindsightLocalLlmEnabled(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  return collectHindsightLlmBaseUrls(llm, litellm).some(isSelfHostedHttpUrl);
}

/**
 * Prefered LiteLLM base URL for health/TCP probes: explicit litellm config,
 * else the first per-op `*_LLM_BASE_URL`. Undefined when nothing is configured.
 */
export function pickHindsightLiteLlmProbeUrl(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
): string | undefined {
  return collectHindsightLlmBaseUrls(llm, litellm)[0];
}

/**
 * Bare python body (compose exec-form `["CMD","python3","-c",PY]`) that requires
 * BOTH the hindsight /health endpoint and TCP reachability of the LiteLLM base
 * URL. /health alone is DB-backed — a container mis-created on the bridge
 * network still answers 200 while every retain dies with "Connection error"
 * to 127.0.0.1:4010 (2026-07-19 recovery regression). Pairing catches that
 * class of silent outage in `docker ps` health.
 */
export function buildLiteLlmAwareHealthPy(apiPort: number, litellmBaseUrl: string): string {
  let host = "127.0.0.1";
  let port = "80";
  try {
    const u = new URL(litellmBaseUrl.includes("://") ? litellmBaseUrl : `http://${litellmBaseUrl}`);
    host = u.hostname || host;
    port = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    // fall through with defaults; better a weak probe than a throw in start
  }
  // One-liner python (docker health-cmd / compose CMD is single-arg). Exit 0
  // only when BOTH /health is 200 AND the LiteLLM host:port accepts TCP.
  return (
    `import socket,urllib.request,sys;` +
    `r=urllib.request.urlopen('http://localhost:${apiPort}/health',timeout=4);` +
    `(r.getcode()==200) or sys.exit(1);` +
    `s=socket.create_connection(('${host}',${Number(port)}),2);s.close()`
  );
}

/**
 * Build a docker `--health-cmd` string wrapping {@link buildLiteLlmAwareHealthPy}.
 * Shared by the `docker run` path ({@link startHindsight}); compose uses the
 * bare PY body via exec-form CMD so the generators never drift.
 */
export function buildLiteLlmAwareHealthCmd(apiPort: number, litellmBaseUrl: string): string {
  return `python3 -c "${buildLiteLlmAwareHealthPy(apiPort, litellmBaseUrl)}"`;
}

/**
 * Should hindsight be launched with GPU passthrough?
 *
 * The recall reranker is sentence-transformers + PyTorch, and
 * `hindsight_api/engine/reranker/cross_encoder.py` already selects `cuda`
 * whenever `torch.cuda.is_available()`. docker/Dockerfile.hindsight installs a
 * CUDA-flavoured torch on amd64 (see the `torch-cuda ok` build assert), so the
 * only remaining requirement is that the container actually SEES the device —
 * `--gpus all` on the run path, the `deploy.resources.reservations.devices`
 * stanza on the compose path.
 *
 * This is GATED, not unconditional. `docker run --gpus all` FAILS outright on
 * a host without the nvidia-container-toolkit ("could not select device
 * driver"), which would turn a GPU-less install's `switchroom memory setup`
 * into a hard error. So we reuse exactly the fail-safe rule the voice sidecar
 * uses (`src/agents/compose.ts`, PR-B2): pass the GPU through only when the
 * persisted host-capabilities verdict says a GPU is present AND Docker can
 * reach it. No verdict file (fresh install, never ran `switchroom setup`) ⇒
 * false ⇒ today's CPU behaviour.
 *
 * The booleans live under the `voice` key purely because that feature wrote
 * the schema first (`src/setup/host-capabilities.ts` v1) — they are host
 * hardware facts, not voice settings.
 *
 * Degrading to `false` on a GPU host is NOT free, which is the 2026-07-28
 * correction to this comment's original claim. It costs the local reranker its
 * device AND — because they live in `HINDSIGHT_PERF_DEFAULTS_GPU` — the
 * `RERANKER_LOCAL_FP16` / `RERANKER_LOCAL_BATCH_SIZE` defaults, on the
 * interactive recall path. Safe to LAUNCH, expensive to run. So the gate's
 * fail-safe direction is kept, and the silence around it is what changed:
 * a blind `false` is now reported (see {@link hindsightGpuDecision}) and a
 * recreate that would drop live GPU is refused (see `assessHindsightGpuDrop`).
 *
 * Both probes are compared with `=== true`, NOT coerced. `readHostCapabilities`
 * does a shape check but no per-field type check, so a hand-edited or corrupt
 * verdict holding the STRING `"false"` would satisfy a truthiness test and emit
 * `--gpus all` on a host that cannot honour it — the precise failure this gate
 * exists to prevent, arrived at through the gate. Anything that is not
 * literally `true` is treated as "not proven", which is the fail-safe reading.
 *
 * Autodetect is NOT the only lever. An explicit operator answer — the
 * `hindsight.gpu` key in switchroom.yaml, or `--gpu`/`--no-gpu` on
 * `switchroom memory setup` — wins in BOTH directions, so a host whose verdict
 * file is unreadable (or plain wrong) is never stuck. See
 * {@link resolveHindsightGpuOverride} / {@link hindsightGpuDecision}.
 *
 * @param override Explicit operator answer (flag/yaml), or a test seam. When
 *   omitted the persisted verdict is read.
 */
export function hindsightGpuEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  return hindsightGpuDecision().enabled;
}

/** Where the effective GPU answer came from. Explicit sources outrank autodetect. */
export type HindsightGpuSource = "flag" | "config" | "autodetect";

/** An explicit operator answer plus which lever supplied it. */
export interface HindsightGpuOverride {
  value: boolean;
  source: "flag" | "config";
}

/**
 * The full GPU answer: the boolean, where it came from, and — crucially —
 * whether the autodetect that produced it was itself blind.
 */
export interface HindsightGpuDecision {
  /** The effective answer: does this launch get `--gpus all`? */
  enabled: boolean;
  source: HindsightGpuSource;
  /**
   * True when the answer is `false` from autodetect and the verdict file was
   * present-but-unusable. The distinguishing fact the old boolean-only gate
   * threw away: "this host has no GPU" vs "switchroom could not tell".
   */
  degraded: boolean;
  /** The raw verdict read, for messages that must name the actual file. */
  capabilities: HostCapabilitiesRead;
  /** One line, operator-facing, explaining WHY the answer is what it is. */
  reason: string;
}

/**
 * Resolve the explicit operator override, if any. Flag beats yaml; both beat
 * autodetect. `null` means "nobody said", i.e. fall through to the verdict.
 *
 * Deliberately total in both directions — an operator who has to force GPU ON
 * past a bad verdict also has to be able to force it OFF past a good one,
 * otherwise the "explicit wins" rule is only half true and the drop guard
 * below would have no legitimate opt-out.
 */
export function resolveHindsightGpuOverride(opts: {
  /** `--gpu` / `--no-gpu` on the CLI. */
  flag?: boolean;
  /** `hindsight.gpu` in switchroom.yaml. */
  config?: boolean;
}): HindsightGpuOverride | null {
  if (typeof opts.flag === "boolean") return { value: opts.flag, source: "flag" };
  if (typeof opts.config === "boolean") return { value: opts.config, source: "config" };
  return null;
}

/**
 * Decide GPU passthrough and explain the decision.
 *
 * This is the function that must be used anywhere the answer changes what gets
 * launched — {@link hindsightGpuEnabled} is the thin boolean view for call
 * sites that only need the bit.
 */
export function hindsightGpuDecision(
  override?: HindsightGpuOverride | null,
): HindsightGpuDecision {
  const capabilities = readHostCapabilities();

  if (override) {
    const lever = override.source === "flag"
      ? (override.value ? "--gpu" : "--no-gpu")
      : `hindsight.gpu: ${override.value}`;
    return {
      enabled: override.value,
      source: override.source,
      // An explicit answer is not degraded whatever the file says — the
      // operator overrode the autodetect, which is the whole point.
      degraded: false,
      capabilities,
      reason: `explicit operator override (${lever})`,
    };
  }

  // Present-but-unusable verdict: the answer is still the fail-safe `false`
  // (emitting `--gpus all` blind would hard-fail container create on a
  // toolkit-less host) but it is now flagged as a BLIND false, not a
  // negative one.
  if (isDegradedHostCapabilitiesRead(capabilities)) {
    warnDegradedHostCapabilities(capabilities);
    return {
      enabled: false,
      source: "autodetect",
      degraded: true,
      capabilities,
      reason:
        `host-capabilities verdict is ${capabilities.status} ` +
        `(${capabilities.path}): ${capabilities.detail} — GPU treated as unproven`,
    };
  }

  if (capabilities.status === "absent") {
    return {
      enabled: false,
      source: "autodetect",
      degraded: false,
      capabilities,
      reason:
        `no host-capabilities verdict at ${capabilities.path} ` +
        "(host never probed — run `switchroom setup`)",
    };
  }

  const voice = capabilities.caps?.voice;
  const enabled = voice?.gpuPresent === true && voice?.containerToolkit === true;
  return {
    enabled,
    source: "autodetect",
    degraded: false,
    capabilities,
    reason: enabled
      ? "host-capabilities verdict proves a GPU and the nvidia container toolkit"
      : `host-capabilities verdict does not prove GPU passthrough ` +
        `(gpuPresent=${JSON.stringify(voice?.gpuPresent)}, ` +
        `containerToolkit=${JSON.stringify(voice?.containerToolkit)})`,
  };
}

/**
 * One entry of `docker inspect`'s `HostConfig.DeviceRequests` — what
 * `docker run --gpus all` actually materialises on the container.
 */
export interface HindsightDeviceRequest {
  Driver?: string;
  Count?: number;
  DeviceIDs?: string[] | null;
  Capabilities?: string[][] | null;
}

/**
 * Read the live hindsight container's device requests.
 *
 * `null` means "could not tell" — no container, docker unavailable, or an
 * unparseable inspect. Distinct from `[]`, which means the container exists
 * and requests no devices. The drop guard treats only a NON-EMPTY GPU-shaped
 * list as "this container currently has GPU", so a `null` never manufactures a
 * false refusal.
 */
export function getHindsightDeviceRequests(
  container = "switchroom-hindsight",
): HindsightDeviceRequest[] | null {
  let out: string;
  try {
    out = execFileSync(
      "docker",
      ["inspect", "--format", "{{json .HostConfig.DeviceRequests}}", container],
      { stdio: "pipe", encoding: "utf-8" },
    );
  } catch {
    return null;
  }
  const trimmed = out.trim();
  // Docker renders an unset DeviceRequests as the JSON literal `null`.
  if (trimmed === "" || trimmed === "null" || trimmed === "<no value>") return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null) return [];
    return Array.isArray(parsed) ? (parsed as HindsightDeviceRequest[]) : null;
  } catch {
    return null;
  }
}

/**
 * Does this device-request list represent live GPU passthrough?
 *
 * `--gpus all` materialises as a single entry with `Count: -1` and
 * `Capabilities: [["gpu"]]`; `--gpus device=0` uses `DeviceIDs` instead. Match
 * on any of the three shapes rather than on one, so a container launched by an
 * operator's own `docker run` variant still counts.
 */
export function deviceRequestsHaveGpu(reqs: HindsightDeviceRequest[] | null): boolean {
  if (!reqs || reqs.length === 0) return false;
  return reqs.some((r) => {
    const caps = (r.Capabilities ?? []).flat().map((c) => String(c).toLowerCase());
    if (caps.includes("gpu")) return true;
    if ((r.Driver ?? "").toLowerCase() === "nvidia") return true;
    if ((r.DeviceIDs?.length ?? 0) > 0) return true;
    return (r.Count ?? 0) !== 0;
  });
}

/**
 * Inputs for the capability-gated performance defaults, threaded through both
 * launch paths as ONE trailing options object so the two generators keep
 * identical shapes (the positional-parameter list is already long enough to
 * make a silent argument-order mismatch between them plausible).
 */
export interface HindsightPerfOptions {
  /**
   * The operator's `hindsight.env` block from switchroom.yaml. Any key in
   * `HINDSIGHT_PERF_ENV_KEYS` set here REPLACES switchroom's default for that
   * key; other keys are ignored (see hindsight-perf-defaults.ts).
   */
  env?: Record<string, string | number | boolean>;
  /**
   * Local-LLM verdict override. Omit in production —
   * {@link hindsightLocalLlmEnabled} derives it from the configured LLM base
   * URLs. Tests pass an explicit boolean.
   */
  localLlm?: boolean;
  /**
   * The operator's `hindsight.mem_limit` — the container's docker memory cap.
   * Absent / blank ⇒ {@link HINDSIGHT_DEFAULT_MEM_LIMIT}.
   *
   * This rides the options object rather than `env` on purpose. `env` is a map
   * of vars switchroom EMITS INTO the container (`-e K=V` /
   * `environment: - K=V`); the memory cap is a docker `HostConfig.Memory`
   * flag, consumed by the daemon and never seen by any process inside the
   * container. Putting it in `env` would either emit a var nothing reads or
   * break that map's one invariant. It rides the options object rather than a
   * new positional for the reason this object exists at all (see the interface
   * doc): a 9th positional is a silent argument-order mismatch waiting to
   * happen between the two launch paths.
   *
   * @see resolveHindsightMemLimit
   */
  memLimit?: string;
  /** Process-environment seam for tests; defaults to `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * The docker memory cap the hindsight container is actually created with.
 *
 * ONE derivation, called by both {@link startHindsight} and
 * {@link generateHindsightComposeSnippet}, for the same anti-drift reason as
 * {@link hindsightPerfEnvPairs}: a cap that differs between the docker-run and
 * compose paths is exactly the class of divergence that produced the bug this
 * knob exists to fix.
 *
 * A blank / whitespace-only value is an accident rather than an override
 * (same discipline as `resolveHindsightPgOverrides`) and falls back to the
 * default. A non-blank value that docker could not parse THROWS: the schema
 * regex is the first line of defence, and silently substituting the default
 * for a typo'd cap would reproduce the very "silently reverted to 16g"
 * behaviour this change removes.
 *
 * It also throws below {@link HINDSIGHT_DEFAULT_MEM_RESERVATION}. The soft
 * reservation is emitted unconditionally on both launch paths, and docker
 * refuses to create a container whose memory limit is under its reservation —
 * a previously unreachable state (the cap was a constant `16g`) that this knob
 * makes reachable. Docker's own rejection is late and opaque; this one names
 * both numbers.
 */
export function resolveHindsightMemLimit(perf?: HindsightPerfOptions): string {
  const raw = perf?.memLimit?.trim();
  if (!raw) return HINDSIGHT_DEFAULT_MEM_LIMIT;
  const capMib = parseDockerSizeToMib(raw);
  if (capMib === null) {
    throw new Error(
      `hindsight.mem_limit: \`${raw}\` is not a docker memory size. Use a ` +
        "number with an optional b/k/m/g suffix, e.g. `24g` or `16384m`.",
    );
  }
  const reservationMib = parseDockerSizeToMib(HINDSIGHT_DEFAULT_MEM_RESERVATION);
  if (reservationMib !== null && capMib < reservationMib) {
    throw new Error(
      `hindsight.mem_limit: \`${raw}\` is below the container's memory ` +
        `reservation (${HINDSIGHT_DEFAULT_MEM_RESERVATION}) — docker refuses ` +
        "to create a container whose memory limit is under its reservation.",
    );
  }
  return raw;
}

/**
 * The memory-budget warning for the config this container will launch with, or
 * `null` when the cap comfortably clears the configured `shared_buffers`.
 *
 * Resolves BOTH sides from the same helpers the launch paths use — the cap
 * from {@link resolveHindsightMemLimit}, `shared_buffers` from
 * {@link hindsightPgEnvPairs} — so the check can never be evaluated against a
 * different pair of numbers than the container gets.
 */
export function hindsightMemBudgetWarningFor(
  perf?: HindsightPerfOptions,
): string | null {
  const sharedBuffers = hindsightPgEnvPairs(perf).find(
    ([k]) => k === HINDSIGHT_PG_SHARED_BUFFERS_ENV,
  )?.[1];
  if (!sharedBuffers) return null;
  return hindsightMemBudgetWarning({
    memLimit: resolveHindsightMemLimit(perf),
    sharedBuffers,
  });
}

/**
 * The single derivation of the performance env pairs, shared by
 * {@link startHindsight} and {@link generateHindsightComposeSnippet}.
 *
 * Exists so the two launch paths cannot drift: exactly like
 * {@link hindsightGpuEnabled}, there is ONE place that decides, and both
 * consumers route through it. The run ⇄ compose parity test asserts the
 * outcome of both generators for the same inputs, not just that both call it.
 */
export function hindsightPerfEnvPairs(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
  gpu?: boolean,
  perf?: HindsightPerfOptions,
): Array<[string, string]> {
  return hindsightPerfEnv(
    {
      gpu: hindsightGpuEnabled(gpu),
      localLlm: hindsightLocalLlmEnabled(llm, litellm, perf?.localLlm),
    },
    resolveHindsightPerfOverrides(perf?.env, perf?.processEnv),
  );
}

/**
 * The single derivation of the embedded-PostgreSQL (pg0) sizing env pairs,
 * shared by {@link startHindsight} and {@link generateHindsightComposeSnippet}
 * for the same anti-drift reason as {@link hindsightPerfEnvPairs}.
 *
 * These are consumed by `docker/hindsight-entrypoint.sh`, which pre-starts pg0
 * with the corresponding `-c` flags — the ONLY route that works, because
 * postgres ranks `command line` above `ALTER SYSTEM`. See
 * src/setup/hindsight-pg-defaults.ts.
 */
export function hindsightPgEnvPairs(
  perf?: HindsightPerfOptions,
): Array<[string, string]> {
  return hindsightPgEnv(resolveHindsightPgOverrides(perf?.env, perf?.processEnv));
}

/**
 * LiteLLM customer id / spend tag hindsight's proxy traffic is attributed to.
 *
 * This literal is what produces the `end_user=hindsight` rows in LiteLLM's
 * `LiteLLM_SpendLogs`. Changing it silently orphans every historical row from
 * the lane that produced it, so it lives here once rather than inline.
 */
export const HINDSIGHT_LITELLM_CUSTOMER_ID = "hindsight";

/**
 * THE single construction of hindsight's LiteLLM routing env — the
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_CUSTOM_HEADERS` pair that makes the
 * container's `claude-code` provider transit the proxy and be METERED there.
 *
 * ## Why it is a helper and not two inline literals
 *
 * It used to be two: one in {@link hindsightContainerEnvPairs} (the
 * docker-run / `memory setup --recreate` launch path) and one in
 * {@link generateHindsightComposeSnippet}. Two copies of a credential-bearing
 * literal is exactly the shape that drifts: the compose copy is the only one
 * an operator ever *reads*, and the docker-run copy is the only one the fleet
 * actually *runs*. Emitting both from one function makes a divergence
 * unrepresentable rather than merely unlikely — the same twin-path discipline
 * {@link hindsightCpAuthEnvPairs} and {@link hindsightHostNetworkBindEnvPairs}
 * already enforce for the CP dashboard and the host-network bind.
 *
 * ## Fail-closed on a missing key
 *
 * Returns `[]` unless BOTH a base URL and a non-blank API key are present. A
 * blank key would otherwise bake `x-litellm-api-key: Bearer ` into the
 * container, which LiteLLM rejects at auth — an unmetered lane that *looks*
 * configured is strictly worse than an obviously-unconfigured one. Callers
 * that need to tell the operator WHY the key is missing use
 * {@link resolveHindsightLiteLlm}'s `droppedRef`.
 *
 * The returned value is newline-separated, which is what the `-e` docker-run
 * form wants. The compose emitter escapes the newlines for its YAML scalar.
 *
 * @param llmModel The resolved hindsight LLM model. Claude models ride the
 *   Anthropic pass-through (`<root>/anthropic`, raw byte-forward, OAuth) — the
 *   model-mapped route re-chunks the SSE stream and stalls long Claude
 *   responses mid-flight (the 2026-07-05 stall). Any other model (e.g.
 *   OpenRouter) MUST use the model-mapped root instead: the pass-through only
 *   forwards to the real Anthropic API, so a non-Claude `model_name` there
 *   404s / always fails open.
 */
export function hindsightLiteLlmEnvPairs(
  litellm: LiteLLMHindsightConfig | undefined,
  llmModel: string,
): Array<[string, string]> {
  const baseUrl = litellm?.baseUrl?.trim();
  const apiKey = litellm?.apiKey?.trim();
  if (!baseUrl || !apiKey) return [];
  const litellmRoot = baseUrl.replace(/\/+$/, "");
  const anthropicBaseUrl = isClaudeModel(llmModel) ? `${litellmRoot}/anthropic` : litellmRoot;
  return [
    ["ANTHROPIC_BASE_URL", anthropicBaseUrl],
    [
      "ANTHROPIC_CUSTOM_HEADERS",
      `x-litellm-api-key: Bearer ${apiKey}\n` +
        `x-litellm-customer-id: ${HINDSIGHT_LITELLM_CUSTOMER_ID}\n` +
        `x-litellm-tags: service:${HINDSIGHT_LITELLM_CUSTOMER_ID}`,
    ],
  ];
}

/**
 * THE complete container environment `startHindsight` launches with — every
 * `-e` pair, in argv order, derived from the same inputs.
 *
 * Extracted from `startHindsight`'s body (2026-07-28) so the env is a VALUE
 * that can be computed without launching anything. The recreate path has to
 * answer "what will this container's env be?" *before* it removes the running
 * container, and the only honest answer is the one the launcher itself will
 * use — a second, parallel derivation would drift and quietly report the wrong
 * diff. See {@link diffDroppedHindsightEnv} for what consumes it.
 *
 * Pure: no docker calls, no filesystem writes. It does read the persisted
 * host-capabilities verdict (through `hindsightPerfEnvPairs` →
 * `hindsightGpuEnabled`) unless `gpu` is passed explicitly.
 */
export function hindsightContainerEnvPairs(opts: {
  /** Host API port; also the in-container API port under `--network host`. */
  apiPort: number;
  litellm?: LiteLLMHindsightConfig;
  llm?: HindsightLlmConfig;
  /** GPU verdict override; omit in production. See {@link hindsightGpuEnabled}. */
  gpu?: boolean;
  perf?: HindsightPerfOptions;
  /**
   * Resolved control-plane access key (operator's `hindsight.cp_access_key`,
   * post-`vault:` lookup). Absent ⇒ the dashboard has no login and is pinned
   * to loopback. See {@link hindsightCpAuthEnvPairs}.
   */
  cpAccessKey?: string;
}): Array<[string, string]> {
  const { apiPort, litellm, llm, gpu, perf, cpAccessKey } = opts;

  // Effective LLM provider + model, applying the operator override
  // (top-level `hindsight.llm` in switchroom.yaml) over the hard-coded
  // subscription-honest fallbacks. With LiteLLM routing enabled and no
  // explicit `hindsight.llm.model`, the model default shifts to a cheap
  // OpenRouter model (HINDSIGHT_DEFAULT_LITELLM_MODEL) — see
  // resolveHindsightLlm — since the proxy can translate a non-Claude name.
  const { provider: llmProvider, model: llmModel } = resolveHindsightLlm(llm, litellm);

  // Per-op LLM overrides (retain / reflect / consolidation). Only the vars an
  // operator actually configured are emitted; an unset op inherits the global
  // HINDSIGHT_API_LLM_* in the engine, so we emit nothing for it.
  const perOpLlm = resolveHindsightPerOpLlm(llm);

  // Non-secret env stays on `-e` — provider name is configuration, not a
  // secret. `HINDSIGHT_API_LLM_PROVIDER=claude-code` selects the
  // subscription-honest path; `HINDSIGHT_API_LLM_MODEL` pins the memory-ops
  // model (default HINDSIGHT_DEFAULT_MODEL, or the cheap LiteLLM default,
  // operator-overridable via `hindsight.llm`). The per-scope observation cap
  // is emitted by the managed perf-defaults block below, not pinned here, so
  // an operator can raise it through `hindsight.env`.
  const pairs: Array<[string, string]> = [
    ["HINDSIGHT_API_LLM_PROVIDER", llmProvider],
    ["HINDSIGHT_API_LLM_MODEL", llmModel],
    // Global LLM passthrough (base_url / api_key) — only the configured vars
    // (#3687, see resolveHindsightGlobalLlmExtras).
    ...resolveHindsightGlobalLlmExtras(llm),
    // Per-op LLM overrides (only the configured vars — see resolveHindsightPerOpLlm).
    ...perOpLlm,
    ["HINDSIGHT_API_MCP_STATELESS", String(HINDSIGHT_DEFAULT_MCP_STATELESS)],
    // Reranker smart-defaults, the reflect wall timeout and the consolidation
    // scheduling knobs are NOT pinned here any more — they are emitted by the
    // managed perf-defaults block below, so `hindsight.env` can reach them.
    // Their rationale moved with them to hindsight-perf-defaults.ts.
    // Retain output cap + the DERIVED per-call deadline for every lane
    // (interactive / reflect / retain / consolidation). Asserted consistent by
    // hindsightLlmBudgetEnv() before it returns — against the token budget
    // (the 767.6s runaway, see the constants above) AND against each lane's
    // litellm routing chain (src/litellm/timeout-budget.ts).
    // …and the CONTEXT budget: consolidation batch size + the two completion
    // caps, derived from the declared window so a prompt cannot overflow the
    // backend's slot (an overflow returns HTTP 200 + garbage, never an error).
    ...hindsightLlmBudgetEnv(llm),
    // Stable worker identity (see HINDSIGHT_DEFAULT_WORKER_ID). Must be on
    // the docker-run path — the entrypoint only fills the var with `:=` when
    // unset, which is fine, but an explicit pin makes the intent legible in
    // `docker inspect` and survives operators who wrap start without the
    // entrypoint default.
    ["HINDSIGHT_API_WORKER_ID", HINDSIGHT_DEFAULT_WORKER_ID],
    // Capability-gated performance defaults (recall p90 5.83s / reflect p90
    // 122s vs upstream's published 100-600ms / 800-3000ms). Emitted through
    // ONE resolver shared with the compose path; every gated group is omitted
    // on a host that cannot prove the capability, and an operator value in
    // `hindsight.env` replaces the default rather than being appended after
    // it. See src/setup/hindsight-perf-defaults.ts.
    ...hindsightPerfEnvPairs(llm, litellm, gpu, perf),
    // Embedded-PostgreSQL (pg0) sizing, read by hindsight-entrypoint.sh's
    // pre-start. pg0 bakes its tuning into the postgres child's ARGV, which
    // outranks `ALTER SYSTEM`, so pre-starting the instance is the only route
    // that can change it. Best-effort in the entrypoint: a pre-start that
    // fails leaves pg0's own defaults in place rather than blocking boot.
    // See src/setup/hindsight-pg-defaults.ts.
    ...hindsightPgEnvPairs(perf),
    // Dead-letter auto-requeue safety net, read by the maintenance sidecar
    // (docker/hindsight-maintenance.sh Section 7). OFF in the script's own
    // defaults; pinning it ON here is what durably enables the recovery sweep
    // on the fleet, bounded at 25 requeues/tick to cap LLM re-extraction spend.
    // See HINDSIGHT_DEFAULT_REQUEUE_DEAD_LETTERS / _MAX (#3795 / #3797).
    ["SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS", HINDSIGHT_DEFAULT_REQUEUE_DEAD_LETTERS],
    ["SWITCHROOM_HINDSIGHT_REQUEUE_MAX", HINDSIGHT_DEFAULT_REQUEUE_MAX],
  ];

  // The `claude-code` provider drives an underlying claude subprocess; pin
  // `ANTHROPIC_MODEL` to the same model so the subprocess (and any LiteLLM
  // proxy it routes through, below) targets it. Only meaningful for the
  // claude-code path — other providers ignore it.
  if (llmProvider === "claude-code") {
    pairs.push(["ANTHROPIC_MODEL", llmModel]);
  }

  // Host-network mode: the container shares the host network stack so
  // 127.0.0.1:4010 (LiteLLM) is directly reachable, identical to how agent
  // containers work — and, because `--network host` makes docker IGNORE `-p`,
  // the listener's address and port become the container's own business. Both
  // come from ONE helper, emitted from the single `hindsightNeedsHostNetwork`
  // test, so no launch path can pick up host networking without also picking
  // up the loopback bind. See {@link hindsightHostNetworkBindEnvPairs}.
  if (hindsightNeedsHostNetwork(llm, litellm)) {
    pairs.push(...hindsightHostNetworkBindEnvPairs(apiPort));
  }

  // Control-plane dashboard auth. Emitted on EVERY path (not just host
  // network): the access key arms the CP login middleware regardless of
  // networking, and the loopback fallback for a keyless launch is decided
  // inside the helper off the same `hindsightNeedsHostNetwork` verdict.
  // See {@link hindsightCpAuthEnvPairs}.
  pairs.push(
    ...hindsightCpAuthEnvPairs({
      accessKey: cpAccessKey,
      hostNetwork: hindsightNeedsHostNetwork(llm, litellm),
    }),
  );

  // LiteLLM routing: inherited by the claude_agent_sdk subprocess so
  // consolidation/reflect calls hit the proxy for spend tracking. Built by the
  // SAME helper the compose emitter uses — see {@link hindsightLiteLlmEnvPairs}.
  pairs.push(...hindsightLiteLlmEnvPairs(litellm, llmModel));

  return pairs;
}

export function startHindsight(
  ports?: { apiPort: number; uiPort: number },
  litellm?: LiteLLMHindsightConfig,
  imageTag?: string,
  llm?: HindsightLlmConfig,
  /**
   * When set (the hindsight consumer's `mirror_dir`, #2578), hindsight's
   * creds dir `/run/claude-creds` is backed by the shared named volume
   * `consumer-creds-hindsight` instead of a private tmpfs, so the broker's
   * push-failover writes reach it immediately. Absent ⇒ tmpfs, pull-only
   * (unchanged pre-#2578 behavior). The value itself is the broker-side
   * path; the consumer-side mount path is always HINDSIGHT_CRED_DIR.
   */
  mirrorDir?: string,
  /**
   * GPU-passthrough override. Omit in production — {@link hindsightGpuEnabled}
   * reads the persisted host-capabilities verdict. Tests pass an explicit
   * boolean so the suite never depends on the runner having (or lacking) a GPU.
   */
  gpu?: boolean,
  /**
   * Capability-gated performance defaults + the operator's `hindsight.env`
   * overrides. See {@link HindsightPerfOptions}.
   */
  perf?: HindsightPerfOptions,
  /**
   * Resolved control-plane access key — the operator's
   * `hindsight.cp_access_key` after any `vault:` reference is read through the
   * broker. Absent ⇒ the dashboard comes up with no login and is confined to
   * loopback rather than served open. See {@link hindsightCpAuthEnvPairs}.
   */
  cpAccessKey?: string,
): void {
  const apiPort = ports?.apiPort ?? HINDSIGHT_DEFAULT_API_PORT;
  const uiPort = ports?.uiPort ?? HINDSIGHT_DEFAULT_UI_PORT;

  const envArgs: string[] = hindsightContainerEnvPairs({
    apiPort,
    litellm,
    llm,
    cpAccessKey,
    gpu,
    perf,
  }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  // Loud on the launch path itself, not only in the CLI wrappers: `switchroom
  // memory setup --recreate` is what silently reverted the cap, so the warning
  // has to be attached to the thing that does the reverting.
  const memBudgetWarning = hindsightMemBudgetWarningFor(perf);
  if (memBudgetWarning) console.warn(`  ! ${memBudgetWarning}`);

  const args = [
    "run", "-d",
    "--name", "switchroom-hindsight",
    "--restart", "always",
    // Container resource caps (memory + pids only; CPU uncapped —
    // see HINDSIGHT_DEFAULT_MEM_LIMIT constant for the v0.13.22 → v0.13.23
    // unwind rationale). The cap itself is `hindsight.mem_limit` (default
    // HINDSIGHT_DEFAULT_MEM_LIMIT), resolved through the SAME helper the
    // compose path uses.
    `--memory=${resolveHindsightMemLimit(perf)}`,
    `--memory-reservation=${HINDSIGHT_DEFAULT_MEM_RESERVATION}`,
    `--pids-limit=${HINDSIGHT_DEFAULT_PIDS_LIMIT}`,
    // PostgreSQL needs far more than Docker's 64MB default shm (see
    // HINDSIGHT_DEFAULT_SHM_SIZE) or all writes/queries fail with
    // "No space left on device". Keep in sync with the compose snippet.
    `--shm-size=${HINDSIGHT_DEFAULT_SHM_SIZE}`,
    // GPU passthrough for the local cross-encoder reranker. Gated on the
    // persisted host-capabilities verdict — see hindsightGpuEnabled() for why
    // this must never be unconditional. Kept in sync with the compose snippet
    // (generateHindsightComposeSnippet emits the equivalent
    // deploy.resources.reservations.devices stanza); the run/compose parity
    // test pins that both paths move together.
    ...(hindsightGpuEnabled(gpu) ? ["--gpus", "all"] : []),
    // Liveness signal for a wedged API: docker had no health probe for
    // hindsight, so an unresponsive server (or a never-booting one) stayed
    // "up" forever. This marks the container "unhealthy" in `docker inspect`
    // / `docker ps` so operators and the doctor probe can SEE the wedge.
    // NOTE: vanilla Docker does NOT auto-restart an unhealthy container —
    // `--restart always` acts on process EXIT only, never on health status.
    // So this flag itself is VISIBILITY, not a self-heal: it marks the
    // container `unhealthy` so operators, `switchroom doctor`, AND the
    // host-side autoheal loop can SEE the wedge. The actual restart-on-
    // unhealthy mechanism is the `switchroom-hindsight-autoheal` sidecar in
    // the hostd compose (#2910, docker/hindsight-autoheal.sh): it polls this
    // status through the docker-socket-proxy and issues `docker restart` with
    // a sliding-window cap + backoff. python3 is always present in the image;
    // curl/wget are not.
    // Liveness: API /health alone is necessary but NOT sufficient when LLM
    // routing depends on a side-car base URL — a bridge mis-create still
    // answers /health (DB-backed) while every retain/LLM op dies with
    // Connection error. Pair the health endpoint with a TCP probe so docker
    // health reflects LLM reachability too. Host network is required for
    // loopback bases (see hindsightNeedsHostNetwork); probe TCP still applies
    // on bridge when the LLM is a non-loopback address.
    ...(() => {
      const hostNet = hindsightNeedsHostNetwork(llm, litellm);
      // Inside the container: host-net API binds HINDSIGHT_API_PORT; bridge
      // maps host:apiPort → container:8888 (image default).
      const healthApiPort = hostNet ? apiPort : 8888;
      const probe = pickHindsightLiteLlmProbeUrl(llm, litellm);
      return [
        "--health-cmd",
        probe
          ? buildLiteLlmAwareHealthCmd(healthApiPort, probe)
          : HINDSIGHT_HEALTHCHECK_CMD,
      ] as string[];
    })(),
    "--health-interval", "30s",
    "--health-timeout", "5s",
    "--health-retries", "3",
    "--health-start-period", "60s",
  ];

  if (hindsightNeedsHostNetwork(llm, litellm)) {
    // Host network: ports are published directly (no -p flags — docker ignores
    // them under `--network host`). Required so loopback LiteLLM
    // (127.0.0.1:4010) is reachable from the container.
    args.push("--network", "host");
    // Because `-p` is inert here, the loopback containment the bridge branch
    // below gets from `-p 127.0.0.1:...` has to come from the application's
    // own bind address instead: HINDSIGHT_API_HOST=127.0.0.1, emitted with the
    // API/CP port pins by hindsightContainerEnvPairs →
    // hindsightHostNetworkBindEnvPairs. Without it the TOKENLESS API answers
    // on 0.0.0.0 across the LAN and tailnet.
  } else {
    // Bridge: bind to 127.0.0.1 on the host side only — the hindsight API is
    // TOKENLESS, so publishing on 0.0.0.0 would expose the unauthenticated
    // MCP/REST surface to the network.
    args.push(
      "-p", `127.0.0.1:${apiPort}:8888`,
      "-p", `127.0.0.1:${uiPort}:9999`,
    );
  }

  args.push(
    "-v", "switchroom-hindsight-data:/home/hindsight/.pg0",
    // Backups land on a SEPARATE volume from the data, so a data-volume
    // loss/corruption is recoverable. The entrypoint's maintenance loop
    // writes rotated pg_dumps here; operators can snapshot/copy it off-host.
    "-v", "switchroom-hindsight-backups:/backups",
    // Broker UDS — same shape the agent fleet uses. The named volume is
    // populated by the auth-broker singleton (which chowns the socket to
    // the declared consumer UID); inside this container the socket is
    // visible at /run/switchroom/auth-broker/sock.
    "-v", `${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`,
    // Creds dir. Two modes:
    //  - mirror OFF (default): a private tmpfs, RAM-only, pull-only. `uid=`
    //    + `gid=` are required because the image's `USER hindsight` (UID
    //    11000, pinned in Dockerfile.hindsight) runs the entrypoint;
    //    without explicit ownership tmpfs mounts root-owned and the
    //    entrypoint's `chmod 0700` fails EACCES → restart-loop.
    //  - mirror ON (#2578): the shared named volume the broker also mounts
    //    at `mirror_dir`, so push-failover creds land here immediately.
    //    Emitted below with the rest of args (needs the -v flag form).
    ...(mirrorDir
      ? ["-v", `${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`]
      : ["--tmpfs", `${HINDSIGHT_CRED_DIR}:rw,mode=0700,uid=${HINDSIGHT_DEFAULT_UID},gid=${HINDSIGHT_DEFAULT_UID}`]),
    ...envArgs,
    // Pinned tag when a rollout target is threaded through; floating
    // `:latest` for the standalone `memory setup` path (imageTag undefined).
    hindsightImageRef(imageTag),
  );

  // Mirror mode (#2578): a fresh named volume mounts root:root, but the
  // entrypoint runs as UID 11000 and does `mkdir -p CRED_DIR; chmod 0700`
  // → EACCES on a root-owned dir → crash-loop. Pre-chown the volume to the
  // consumer UID with a throwaway root container (the hindsight image is
  // already present locally). Idempotent + deterministic: safe to re-run
  // on every start. No-op when mirror is off (tmpfs handles its own
  // ownership via uid=/gid=).
  if (mirrorDir) {
    execFileSync(
      "docker",
      [
        "run", "--rm", "--user", "0",
        "-v", `${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`,
        "--entrypoint", "sh",
        hindsightImageRef(imageTag),
        "-c",
        `chown ${HINDSIGHT_DEFAULT_UID}:${HINDSIGHT_DEFAULT_UID} ${HINDSIGHT_CRED_DIR} && chmod 0700 ${HINDSIGHT_CRED_DIR}`,
      ],
      { stdio: "pipe" },
    );
  }

  execFileSync("docker", args, { stdio: "pipe" });
}

/**
 * List container names that currently mount the live hindsight data volume.
 * Dual mounts with restart=always corrupt the embedded PG checkpoint
 * (2026-07-19 dual-writer outage: `switchroom-hindsight` +
 * `switchroom-hindsight-old-v01833`). Used by {@link stopHindsight} and doctor.
 *
 * Returns [] when docker is unavailable. Names only — no IDs.
 */
export function listHindsightDataVolumeMounts(
  exec: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" }),
): string[] {
  try {
    // docker ps -a --filter volume=… is the garbage-collector gate. Format
    // since docker 1.13; fall back to empty on older hosts/agents without docker.
    const out = exec("docker", [
      "ps", "-a",
      "--filter", `volume=${HINDSIGHT_DATA_VOLUME}`,
      "--format", "{{.Names}}",
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((n) => n.length > 0);
  } catch {
    return [];
  }
}

/**
 * Stop and remove the Hindsight Docker container — and any stale twin
 * (canary holdback/`-old-*` rename) that still mounts the live data volume
 * with restart=always. Leaving a second postmaster on the same volume is
 * how the 2026-07-19 checkpoint corruption happened.
 *
 * Order: disable restart on twins → stop → rm. The live name is always
 * removed too so `startHindsight` can recreate cleanly.
 */
export function stopHindsight(
  exec: (cmd: string, args: string[]) => void = (cmd, args) => {
    execFileSync(cmd, args, { stdio: "pipe" });
  },
  listMounts: () => string[] = () => listHindsightDataVolumeMounts(),
): void {
  const names = new Set<string>([HINDSIGHT_DEFAULT_WORKER_ID, ...listMounts()]);
  for (const name of names) {
    // Surface non-canonical twins (canary holdback / `-old-*` rename) so the
    // dual-writer cleanup is operator-visible in the memory/setup CLI stream.
    // Match the console.* style used by src/cli/memory.ts around start/stop —
    // this helper has no logger dependency today.
    if (name !== HINDSIGHT_DEFAULT_WORKER_ID) {
      console.error(
        `stopHindsight: removing hindsight data-volume twin ${name} (not the canonical ${HINDSIGHT_DEFAULT_WORKER_ID})`,
      );
    }
    try { exec("docker", ["update", "--restart=no", name]); } catch { /* gone */ }
    try { exec("docker", ["stop", name]); } catch { /* gone */ }
    try { exec("docker", ["rm", "-f", name]); } catch { /* gone */ }
  }
}

/**
 * Pull the Hindsight image. `startHindsight` runs `docker run` against
 * whatever image is locally present — it never pulls — so a recreate that
 * wants the newest bits must pull first. Pulls `:latest` when `imageTag`
 * is omitted (standalone `memory setup`); pulls the pinned `:vX.Y.Z` when
 * a rollout threads its target through. Inherits stdio so the operator
 * sees pull progress during `switchroom update` / `rollout`.
 */
export function pullHindsightImage(imageTag?: string): void {
  execFileSync("docker", ["pull", hindsightImageRef(imageTag)], { stdio: "inherit" });
}

/**
 * Read the host ports the RUNNING hindsight container currently
 * publishes, so a recreate can rebind the SAME ports and never change
 * `memory.config.url` under the fleet (a silent port change would point
 * every agent's MCP client at a dead URL). Returns null if the container
 * isn't running / can't be read — callers then fall back to
 * `pickHindsightPorts()`.
 */
export function getRunningHindsightPorts(): { apiPort: number; uiPort: number } | null {
  // The container's INTERNAL ports are fixed by the image (8888 API, 9999 UI)
  // regardless of what host port they're published on. `docker port` is keyed
  // by the container port, so these are constants — NOT the host defaults.
  // (Before the 18888 default this coincidentally equaled the host default;
  // decoupling them here keeps recreate working after the default moved.)
  const CONTAINER_API_PORT = 8888;
  const CONTAINER_UI_PORT = 9999;
  const readPort = (containerPort: number): number | null => {
    try {
      const out = execFileSync(
        "docker",
        ["port", "switchroom-hindsight", `${containerPort}/tcp`],
        { stdio: "pipe", encoding: "utf-8" },
      );
      // Output is one or more lines like "127.0.0.1:18888" / "[::]:18888".
      const m = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      if (!m) return null;
      const port = Number(m.slice(m.lastIndexOf(":") + 1));
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  };
  const apiPort = readPort(CONTAINER_API_PORT);
  if (apiPort !== null) {
    // The UI port is informational (unused by switchroom); reuse it if
    // readable, else derive the standard pair (18888→19999, 8888→9999).
    const uiPort =
      readPort(CONTAINER_UI_PORT) ??
      (apiPort === HINDSIGHT_DEFAULT_API_PORT ? HINDSIGHT_DEFAULT_UI_PORT : 19999);
    return { apiPort, uiPort };
  }
  // `docker port` returns NOTHING for a `--network host` container (the
  // deployed litellm shape runs `--network host`, no -p publishing), so a
  // port-reassigned host-network deployment would otherwise fall back to the
  // 18888 default and strand `memory.config.url`. Recover the real ports from
  // the container's env, where `startHindsight` writes `HINDSIGHT_API_PORT`
  // for exactly this mode.
  return getHindsightPortsFromEnv();
}

/**
 * Fallback for {@link getRunningHindsightPorts}: read the host ports from the
 * running container's environment (`docker inspect --format '{{.Config.Env}}'`).
 * Used for `--network host` deployments where `docker port` yields nothing.
 * Reads `HINDSIGHT_API_PORT`; the UI port is informational, so it's derived
 * from the API port (18888→19999, else 9999) unless a `HINDSIGHT_UI_PORT`-like
 * var is present. Returns null when the container isn't inspectable or the API
 * port env var is absent.
 */
function getHindsightPortsFromEnv(): { apiPort: number; uiPort: number } | null {
  let env: string;
  try {
    env = execFileSync(
      "docker",
      ["inspect", "--format", "{{.Config.Env}}", "switchroom-hindsight"],
      { stdio: "pipe", encoding: "utf-8" },
    );
  } catch {
    return null;
  }
  // `{{.Config.Env}}` renders the env slice as a space-separated, bracketed
  // Go list: `[FOO=1 HINDSIGHT_API_PORT=18888 BAR=baz]`. Values never contain
  // spaces here (they're ports/URLs/keys), so a token split is sufficient.
  const readVar = (name: string): number | null => {
    const re = new RegExp(`(?:^|[\\s\\[])${name}=([^\\s\\]]+)`);
    const m = env.match(re);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const apiPort = readVar("HINDSIGHT_API_PORT");
  if (apiPort === null) return null;
  const uiPort =
    readVar("HINDSIGHT_UI_PORT") ??
    (apiPort === HINDSIGHT_DEFAULT_API_PORT ? HINDSIGHT_DEFAULT_UI_PORT : 19999);
  return { apiPort, uiPort };
}

/**
 * `Config.Env` of the RUNNING hindsight container, as a `["K=V", …]` array.
 *
 * Read before a `--recreate` removes the container, so the drift check can see
 * what is about to be thrown away (see src/setup/hindsight-env-drift.ts).
 * `{{json .Config.Env}}` rather than the bare `{{.Config.Env}}` used by
 * {@link getHindsightPortsFromEnv}: the bracketed Go-list rendering is
 * whitespace-delimited and this env DOES contain values with spaces and
 * newlines (`ANTHROPIC_CUSTOM_HEADERS`), so a token split would corrupt them.
 *
 * Returns null when the container does not exist or is not inspectable — a
 * first install has nothing to compare against, which is a no-op, not an error.
 */
export function getHindsightContainerEnv(): string[] | null {
  return inspectEnv("switchroom-hindsight");
}

/**
 * `Config.Env` of the IMAGE the running hindsight container was created from.
 *
 * The baseline the drift check subtracts, so image-inherited vars (`PATH`,
 * `LANG`, `PYTHON_VERSION`, …) are not reported as drops. Resolved from the
 * container's own `.Image` digest rather than from `hindsightImageRef()`: the
 * live container may predate the tag this recreate is pulling, and the baseline
 * has to describe the container we are actually replacing.
 *
 * Returns null when it can't be resolved; callers then use an empty baseline,
 * which is noisier but never wrong in the unsafe direction.
 */
export function getHindsightImageEnv(): string[] | null {
  let imageId: string;
  try {
    imageId = execFileSync(
      "docker",
      ["inspect", "--format", "{{.Image}}", "switchroom-hindsight"],
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
  } catch {
    return null;
  }
  if (!imageId) return null;
  return inspectEnv(imageId);
}

/** Shared `docker inspect --format '{{json .Config.Env}}'` read. */
function inspectEnv(ref: string): string[] | null {
  try {
    const out = execFileSync(
      "docker",
      ["inspect", "--format", "{{json .Config.Env}}", ref],
      { stdio: "pipe", encoding: "utf-8" },
    );
    const parsed = JSON.parse(out.trim()) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    return null;
  }
}

/**
 * The capability verdicts the next launch will actually use, exposed so the
 * recreate path can EXPLAIN a dropped managed default rather than merely list
 * it. Same single derivation `hindsightPerfEnvPairs` runs — not a second copy.
 */
export function hindsightResolvedCapabilities(
  llm?: HindsightLlmConfig,
  litellm?: LiteLLMHindsightConfig,
  gpu?: boolean,
  perf?: HindsightPerfOptions,
): { gpu: boolean; localLlm: boolean } {
  return {
    gpu: hindsightGpuEnabled(gpu),
    localLlm: hindsightLocalLlmEnabled(llm, litellm, perf?.localLlm),
  };
}

/**
 * Get the status of the Hindsight Docker container.
 */
export function getHindsightStatus(): string | null {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=switchroom-hindsight", "--format", "{{.Status}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    const status = output.trim();
    return status.length > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Get the MCP server config for Hindsight via HTTP endpoint.
 * Hindsight exposes MCP via Streamable HTTP; switchroom publishes it on the
 * host at HINDSIGHT_DEFAULT_MCP_URL (127.0.0.1:18888/mcp/ by default).
 */
export function getHindsightMcpUrl(): {
  url: string;
} {
  return {
    url: HINDSIGHT_DEFAULT_MCP_URL,
  };
}

/**
 * Generate a docker-compose snippet for Hindsight in broker-fed mode.
 * Bind-mounts the auth-broker consumer socket volume and tmpfs for
 * the credential dotfile; no LLM API key is needed.
 *
 * The named volume `auth-broker-hindsight-sock` must be `external: true`
 * because it's owned by the switchroom compose project (the auth-broker
 * container chowns and binds the per-consumer socket inside it). The
 * hindsight compose project is separate; it consumes the volume.
 *
 * Networking, healthcheck and GPU passthrough track {@link startHindsight}:
 * the `deploy.resources.reservations.devices` stanza here is the compose twin
 * of that path's `--gpus all`, gated on the same {@link hindsightGpuEnabled}
 * verdict so the two generators can never disagree about GPU. When an explicit
 * LiteLLM config is passed, OR any configured per-op `*_LLM_BASE_URL`
 * points at host loopback, the snippet emits `network_mode: host` (ports
 * are published on the host stack directly — no `ports:` mapping) and pairs
 * /health with a TCP probe of the LiteLLM base. The live fleet deploys
 * hindsight this way for loopback LiteLLM (`http://127.0.0.1:4010`); leaving
 * compose on bridge with a loopback BASE_URL is the silent-retain class
 * of outage doctor already fails closed on.
 */
export function generateHindsightComposeSnippet(
  llm?: HindsightLlmConfig,
  /**
   * The hindsight consumer's `mirror_dir` (#2578). When set, the creds dir
   * is backed by the shared `consumer-creds-hindsight` volume (broker
   * push-failover reaches hindsight immediately) instead of a private
   * tmpfs, with a one-shot init service that chowns the fresh volume to the
   * consumer UID before hindsight starts. Absent ⇒ tmpfs, pull-only —
   * output identical to pre-#2578.
   */
  mirrorDir?: string,
  /**
   * Optional LiteLLM routing config (same shape as {@link startHindsight}).
   * When set — or when `llm` carries a loopback per-op base URL — the
   * snippet switches to `network_mode: host` and a LiteLLM-aware healthcheck
   * so compose never silently diverges from the docker-run path.
   */
  litellm?: LiteLLMHindsightConfig,
  /**
   * GPU-passthrough override, mirroring {@link startHindsight}'s `gpu` param.
   * Omit in production — {@link hindsightGpuEnabled} reads the persisted
   * host-capabilities verdict.
   */
  gpu?: boolean,
  /**
   * Capability-gated performance defaults + operator `hindsight.env`
   * overrides, mirroring {@link startHindsight}'s `perf` param.
   */
  perf?: HindsightPerfOptions,
  /**
   * Resolved control-plane access key, mirroring {@link startHindsight}'s
   * `cpAccessKey` param. Emitted through the SAME
   * {@link hindsightCpAuthEnvPairs} helper so a compose deployment cannot end
   * up with an open dashboard while the docker-run path is protected.
   */
  cpAccessKey?: string,
): string {
  const { provider: llmProvider, model: llmModel } = resolveHindsightLlm(llm, litellm);
  const perOpLlm = resolveHindsightPerOpLlm(llm);
  const hostNetwork = hindsightNeedsHostNetwork(llm, litellm);
  const gpuEnabled = hindsightGpuEnabled(gpu);
  const apiPort = HINDSIGHT_DEFAULT_API_PORT;
  // Bridge compose keeps the image-default internal bind (8888) and maps the
  // host port onto it. Host-network binds HINDSIGHT_API_PORT on the host
  // stack directly (same as startHindsight) so agents' memory.config.url
  // still hits the right place.
  const internalApiPort = hostNetwork ? apiPort : 8888;
  const probeUrl = pickHindsightLiteLlmProbeUrl(llm, litellm);
  // Pair /health with LiteLLM TCP whenever any base URL is configured —
  // including bridge+non-loopback. Host network is the loopback case only.
  const healthPy = probeUrl
    ? buildLiteLlmAwareHealthPy(internalApiPort, probeUrl)
    : HINDSIGHT_HEALTHCHECK_PY;
  const environment = [
    // The per-scope observation cap moved to the managed perf-defaults block
    // below, which is emitted on BOTH launch paths from the same resolver, so
    // the docker-run/compose twin property still holds for it.
    `      - HINDSIGHT_API_LLM_PROVIDER=${llmProvider}`,
    `      - HINDSIGHT_API_LLM_MODEL=${llmModel}`,
    // Global LLM passthrough (base_url / api_key) — only the configured vars
    // (#3687), from the SAME resolver the docker-run path uses so the twin
    // property holds.
    ...resolveHindsightGlobalLlmExtras(llm).map(([k, v]) => `      - ${k}=${v}`),
    // Per-op LLM overrides (only the configured vars — see resolveHindsightPerOpLlm).
    ...perOpLlm.map(([k, v]) => `      - ${k}=${v}`),
    // Mirror of the docker-run path: with the claude-code provider, pin
    // ANTHROPIC_MODEL to the same model for the underlying claude subprocess.
    ...(llmProvider === "claude-code" ? [`      - ANTHROPIC_MODEL=${llmModel}`] : []),
    // Host-network: the API binds HINDSIGHT_API_HOST:HINDSIGHT_API_PORT on the
    // shared host stack (and CP dataplane must track the port so it doesn't hit
    // squatted 8888). Taken from the SAME helper the docker-run path uses so
    // the tokenless API cannot end up loopback-bound on one launch path and
    // 0.0.0.0-bound on the other.
    // Bridge: the API binds image-default 8888 inside the container netns, and
    // the `ports:` mapping below is what confines it to host loopback.
    ...(hostNetwork
      ? hindsightHostNetworkBindEnvPairs(apiPort).map(([k, v]) => `      - ${k}=${v}`)
      : [`      - HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888`]),
    // CP dashboard login + (host-network only) its bind address, from the
    // SAME helper the docker-run path uses. Without this the compose
    // deployment served an unauthenticated dashboard on 0.0.0.0:9999 while
    // docker-run was protected — the exact one-path-fixed shape #3976 removed
    // for the API.
    ...hindsightCpAuthEnvPairs({ accessKey: cpAccessKey, hostNetwork }).map(
      ([k, v]) => `      - ${k}=${v}`,
    ),
  ];
  // Optional LiteLLM proxy env (ANTHROPIC_BASE_URL + spend-tag headers) — not
  // "the same shape" as the docker-run path but literally the SAME derivation
  // ({@link hindsightLiteLlmEnvPairs}), so compose and `memory setup
  // --recreate` cannot drift on the credential-bearing header. Emits nothing
  // without a resolved api key; a compose generator in that state still gets
  // host network + health pairing from the loopback per-op URLs.
  //
  // The one compose-specific transform: `ANTHROPIC_CUSTOM_HEADERS` is
  // newline-separated, and a raw newline inside an unquoted compose
  // `environment:` scalar would terminate the entry, so the newlines are
  // escaped to a literal `\n` here exactly as they were before the extraction.
  environment.push(
    ...hindsightLiteLlmEnvPairs(litellm, llmModel).map(
      ([k, v]) => `      - ${k}=${v.replace(/\n/g, "\\n")}`,
    ),
  );
  // Mirror mode (#2578): a one-shot init service chowns the fresh shared
  // creds volume to the consumer UID (a named volume mounts root:root, but
  // hindsight's entrypoint runs as UID 11000 and would EACCES on its
  // `chmod 0700` → crash-loop). Hindsight then depends_on it completing.
  const initService = mirrorDir
    ? [
        "  switchroom-hindsight-creds-init:",
        `    image: ${HINDSIGHT_IMAGE}`,
        "    container_name: switchroom-hindsight-creds-init",
        "    user: \"0\"",
        "    entrypoint: [\"sh\", \"-c\"]",
        `    command: ["chown ${HINDSIGHT_DEFAULT_UID}:${HINDSIGHT_DEFAULT_UID} ${HINDSIGHT_CRED_DIR} && chmod 0700 ${HINDSIGHT_CRED_DIR}"]`,
        "    volumes:",
        `      - ${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`,
        "    restart: \"no\"",
      ]
    : [];
  const dependsOn = mirrorDir
    ? [
        "    depends_on:",
        "      switchroom-hindsight-creds-init:",
        "        condition: service_completed_successfully",
      ]
    : [];
  // network_mode: host OR bridge port publish — mutually exclusive in compose
  // (docker rejects `ports:` alongside host network).
  const networkOrPorts = hostNetwork
    ? [
        // Match startHindsight(--network host): LiteLLM on host loopback is
        // reachable, HINDSIGHT_API_PORT binds directly on the host stack.
        "    network_mode: host",
      ]
    : [
        "    ports:",
        // Host side 18888/19999 → container 8888/9999. The host port MUST match
        // HINDSIGHT_DEFAULT_API_PORT / the scaffolded memory.config.url or agents
        // point at a dead URL (see the 2026-07 outage).
        // Bind to 127.0.0.1 only: the hindsight API is TOKENLESS, so publishing on
        // 0.0.0.0 would expose the unauthenticated MCP/REST surface to the network.
        // This mirrors the startHindsight() docker-run path, which binds loopback.
        `      - "127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}:8888"`,
        "      - \"127.0.0.1:19999:9999\"",
      ];
  return [
    "services:",
    ...initService,
    "  switchroom-hindsight:",
    `    image: ${HINDSIGHT_IMAGE}`,
    "    container_name: switchroom-hindsight",
    ...dependsOn,
    ...networkOrPorts,
    "    environment:",
    ...environment,
    `      - HINDSIGHT_API_MCP_STATELESS=${HINDSIGHT_DEFAULT_MCP_STATELESS}`,
    // Retain + timeout + CONTEXT budget — same derivation + assertion as the
    // docker-run path (consolidation batch size, the completion caps and the
    // reflect context cap all come from here, so the two paths cannot
    // disagree about the token budget).
    ...hindsightLlmBudgetEnv(llm).map(([k, v]) => `      - ${k}=${v}`),
    // Consolidation scheduling (reserved floor, per-type ceiling, per-round
    // scope) and the reranker/reflect defaults all moved to the managed
    // perf-defaults block below, which is emitted on BOTH paths from the same
    // resolver — so the docker-run/compose twin property holds for them by
    // construction rather than by two hand-maintained lists.
    `      - HINDSIGHT_API_WORKER_ID=${HINDSIGHT_DEFAULT_WORKER_ID}`,
    // Capability-gated performance defaults — the compose twin of the
    // docker-run path's block, from the SAME resolver so the two can never
    // disagree about which knobs a host gets (see hindsightPerfEnvPairs).
    ...hindsightPerfEnvPairs(llm, litellm, gpu, perf).map(([k, v]) => `      - ${k}=${v}`),
    // pg0 sizing — compose twin of the docker-run block, from the SAME
    // resolver (see hindsightPgEnvPairs / hindsight-pg-defaults.ts).
    ...hindsightPgEnvPairs(perf).map(([k, v]) => `      - ${k}=${v}`),
    // Dead-letter auto-requeue safety net — compose twin of the docker-run
    // path's pins, so the recovery sweep is enabled identically on both launch
    // paths (see HINDSIGHT_DEFAULT_REQUEUE_DEAD_LETTERS / _MAX, #3795 / #3797).
    `      - SWITCHROOM_HINDSIGHT_REQUEUE_DEAD_LETTERS=${HINDSIGHT_DEFAULT_REQUEUE_DEAD_LETTERS}`,
    `      - SWITCHROOM_HINDSIGHT_REQUEUE_MAX=${HINDSIGHT_DEFAULT_REQUEUE_MAX}`,
    // Operator's `hindsight.mem_limit` (default HINDSIGHT_DEFAULT_MEM_LIMIT),
    // from the SAME resolver the docker-run path uses so an emitted compose
    // file cannot cap the container differently than `memory setup` would.
    `    mem_limit: ${resolveHindsightMemLimit(perf)}`,
    `    mem_reservation: ${HINDSIGHT_DEFAULT_MEM_RESERVATION}`,
    `    pids_limit: ${HINDSIGHT_DEFAULT_PIDS_LIMIT}`,
    // PostgreSQL shm — see HINDSIGHT_DEFAULT_SHM_SIZE. Without this the
    // container gets Docker's 64MB default and all writes/queries fail.
    `    shm_size: ${HINDSIGHT_DEFAULT_SHM_SIZE}`,
    // GPU passthrough for the local cross-encoder reranker — the compose twin
    // of the docker-run path's `--gpus all`. Same shape as the voice sidecar
    // (src/agents/compose.ts), same fail-safe gate (hindsightGpuEnabled): a
    // host with no nvidia-container-toolkit gets no stanza at all, because
    // compose would refuse to start the service ("could not select device
    // driver") exactly like `docker run --gpus` does.
    ...(gpuEnabled
      ? [
          "    deploy:",
          "      resources:",
          "        reservations:",
          "          devices:",
          "            - driver: nvidia",
          "              count: 1",
          '              capabilities: ["gpu"]',
        ]
      : []),
    // Liveness — restart a wedged/never-booted API (see the docker-run path).
    // When host-network + LiteLLM base is known, pair /health with a TCP
    // probe of the proxy so docker health reflects LLM reachability too.
    "    healthcheck:",
    `      test: ${JSON.stringify(["CMD", "python3", "-c", healthPy])}`,
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 3",
    "      start_period: 60s",
    "    volumes:",
    "      - switchroom-hindsight-data:/home/hindsight/.pg0",
    // Backups on a separate volume from the data — recoverable if the data
    // volume is lost/corrupted. Written by the entrypoint maintenance loop.
    "      - switchroom-hindsight-backups:/backups",
    `      - ${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`,
    // Creds dir: mirror ON → shared volume (broker push-failover reaches
    // hindsight immediately); mirror OFF → private tmpfs (pull-only).
    ...(mirrorDir
      ? [`      - ${HINDSIGHT_CREDS_MIRROR_VOLUME}:${HINDSIGHT_CRED_DIR}`]
      : [
          "    tmpfs:",
          `      - ${HINDSIGHT_CRED_DIR}:rw,mode=0700,uid=${HINDSIGHT_DEFAULT_UID},gid=${HINDSIGHT_DEFAULT_UID}`,
        ]),
    "    restart: always",
    "",
    "volumes:",
    "  switchroom-hindsight-data:",
    "  switchroom-hindsight-backups:",
    `  ${HINDSIGHT_BROKER_SOCK_VOLUME}:`,
    "    external: true",
    "    # Bound by the switchroom-auth-broker singleton in the main",
    "    # switchroom compose project. Declare an `auth.consumers[]`",
    `    # entry named "${HINDSIGHT_CONSUMER_NAME}" in switchroom.yaml.`,
    // Shared creds-mirror volume (#2578) — external because the broker in
    // the main switchroom compose project owns/mounts it at `mirror_dir`.
    ...(mirrorDir
      ? [
          `  ${HINDSIGHT_CREDS_MIRROR_VOLUME}:`,
          "    external: true",
          "    # Mounted by switchroom-auth-broker at the consumer's",
          `    # \`mirror_dir\`. Set \`mirror_dir\` on the "${HINDSIGHT_CONSUMER_NAME}"`,
          "    # auth.consumers[] entry in switchroom.yaml + `apply`.",
        ]
      : []),
  ].join("\n");
}

/**
 * Edit `switchroom.yaml` in place to ensure an `auth.consumers[]` entry
 * exists for the hindsight container. Idempotent: if an entry with the
 * same `name` is already present, leaves it untouched.
 *
 * @param configPath  absolute path to switchroom.yaml
 * @param account     optional account label to PIN the consumer to. Omit
 *                    (the default since the consumer-unpin change) to
 *                    register the consumer follow-active: it rides the
 *                    fleet `auth.active` with the same failover agents get.
 * @param uid         UID to chown the consumer socket to;
 *                    defaults to HINDSIGHT_DEFAULT_UID
 */
export async function ensureHindsightConsumer(
  configPath: string,
  account?: string,
  uid: number = HINDSIGHT_DEFAULT_UID,
): Promise<{ added: boolean; reason: string }> {
  const fs = await import("node:fs");
  const { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } = await import("yaml");
  const { atomicWriteFileSync } = await import("../util/atomic.js");

  const raw = fs.readFileSync(configPath, "utf-8");
  const doc = parseDocument(raw);
  const root = doc.contents;
  if (!isMap(root)) {
    return { added: false, reason: "switchroom.yaml root is not a map" };
  }

  // Ensure auth: { ... } exists as a map.
  const authRaw = root.get("auth", true);
  let authNode: InstanceType<typeof YAMLMap>;
  if (isMap(authRaw)) {
    authNode = authRaw as InstanceType<typeof YAMLMap>;
  } else {
    authNode = new YAMLMap();
    doc.setIn(["auth"], authNode);
  }

  // Ensure auth.consumers: [...] exists as a sequence.
  const consumersRaw = authNode.get("consumers", true);
  let consumersNode: InstanceType<typeof YAMLSeq>;
  if (isSeq(consumersRaw)) {
    consumersNode = consumersRaw as InstanceType<typeof YAMLSeq>;
  } else {
    consumersNode = new YAMLSeq();
    doc.setIn(["auth", "consumers"], consumersNode);
  }

  // Idempotency: leave any existing entry with the same name alone.
  for (const item of consumersNode.items) {
    if (isMap(item)) {
      const name = item.get("name");
      if (name === HINDSIGHT_CONSUMER_NAME) {
        return { added: false, reason: "already present" };
      }
    }
  }

  const entry = new YAMLMap();
  entry.set("name", HINDSIGHT_CONSUMER_NAME);
  if (account !== undefined) entry.set("account", account);
  entry.set("uid", uid);
  consumersNode.add(entry);

  const out = String(doc);
  const tail = out.endsWith("\n") ? out : out + "\n";
  let mode = 0o644;
  try { mode = fs.statSync(configPath).mode & 0o777; } catch { /* default */ }
  atomicWriteFileSync(configPath, tail, mode);
  return { added: true, reason: "added" };
}
