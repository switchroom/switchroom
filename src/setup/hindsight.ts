import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { isClaudeModel } from "../../telegram-plugin/gateway/model-command.js";

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

/**
 * Default cap on observations per *tag scope*.
 *
 * Upstream Hindsight defaults `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE`
 * to `-1` (unlimited). Once a tag scope hits the cap, consolidation
 * stops creating new observations and only updates/deletes existing
 * ones — bounding the cost of consolidating a single long-running
 * scope. Tagless observations are unaffected.
 *
 * Switchroom retains with `retainTags: ["{session_id}"]` (vendored
 * plugin default), so a "tag scope" maps roughly to "one session." A
 * very long Telegram session that runs for weeks can accumulate
 * thousands of observations under one scope — that's the case 1000
 * targets. Most sessions are far below the cap, so for typical
 * agents this is defense-in-depth rather than an active limit.
 *
 * This is NOT a fix for vectorize-io/hindsight#1284 (the upstream
 * unbounded-growth bug for consolidation across a whole bank); it's a
 * companion safety rail until that lands. Operators who want a
 * different value can stop the container and re-run `docker run`
 * with `-e HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=N`.
 */
export const HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE = 1000;

/**
 * Default consumer slug for the hindsight broker socket. Path-as-identity
 * — the broker binds `/run/switchroom/auth-broker/<slug>/sock` and chowns
 * it to the configured UID. See `auth.consumers[]` in `src/config/schema.ts`
 * and RFC H §4.8.
 */
export const HINDSIGHT_CONSUMER_NAME = "hindsight";

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
 * `update_memory` (no such tool) now FAIL HONESTLY instead of silently
 * reporting success. SEPARATE security follow-up still open: vault-sweep's
 * secret-scrub has no working single-memory delete path AND hard-throws on the
 * stateless server at vault-sweep.ts:194 — it needs a document-granularity
 * rework to actually scrub, not just fail loudly.
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
 * Reranker smart-defaults (v0.13.22).
 *
 * The hindsight server's cross-encoder reranker is the single biggest
 * latency contributor on the recall path — 87% of p50 5.6s on the
 * 2026-05-24 fleet audit. Each of these knobs has a vendor default that
 * is sub-optimal for switchroom's workload (CPU-only, shared host,
 * Telegram-shaped concurrency); we override to the optimal value out of
 * the box so a fresh `switchroom setup` produces a fast hindsight
 * without any operator tuning.
 *
 * - BUCKET_BATCHING: vendor default `false`. Vendor's own config.py
 *   comment promises "36-54% speedup, quality-identical" by sorting
 *   candidate pairs by length to avoid padding waste. Pure win on CPU.
 *
 * - MAX_CANDIDATES: vendor default 300. At our `recallBudget=low`
 *   ~100 candidates feed in and we cap to 12 final memories; scoring
 *   300 wastes ~50% of rerank CPU on candidates that will never make
 *   the top-N.
 *
 * - LOCAL_MAX_CONCURRENT: vendor default 4. With 9 always-on agents
 *   that's up to 36 simultaneous CPU-bound rerank tasks on a shared
 *   16-core host — thrashes. Cap at 2 leaves headroom for burst.
 *
 * - RECALL_MAX_CONCURRENT: vendor default 32. Sized for a dedicated
 *   hindsight box; switchroom is co-tenant with the fleet, hostd,
 *   brokers, etc. 8 matches realistic concurrency without lock
 *   contention.
 *
 * All four are operator-overridable by editing the generated compose
 * snippet or the `docker run -e ...` flags — but they should never
 * NEED tuning for a single-host fleet install.
 */
export const HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING = "true";
export const HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES = 150;
// Vendor default 4. v0.13.22 dropped this to 2 paired with the now-
// reverted `--cpus=2.0` CPU cap; with CPU restored, 4-way concurrency
// is the right knob — lets 4 fleet agents' recalls overlap without
// thrashing per-pair compute (which is the actual bottleneck, not
// task-level contention).
export const HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT = 4;
export const HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT = 8;

/**
 * Reflect wall-clock timeout. Vendor default is 300s. Mental-model
 * refresh re-runs the model's `source_query` through the agentic reflect
 * loop; on a large bank (observed: 12-13k observations) that legitimately
 * exceeds 300s, so the refresh times out and the model stays stale —
 * which is the main reason user-profile models go unpopulated on
 * high-volume agents (2026-06-19 fleet: refresh timeouts across 8 banks).
 * 600s lets large-bank refreshes complete. Trade-off: an interactive
 * `reflect` query also gets the longer ceiling, but those rarely approach
 * 300s, so the net is strictly more models successfully refreshing.
 */
export const HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S = 600;

/**
 * Consolidation throughput knobs — throttled HARD for shared-quota safety.
 * Consolidation is LLM-bound via the claude-code provider (observed
 * ~510s/op), and every concurrent op is a live claude (Sonnet) subprocess
 * spending the subscription's quota.
 *
 * Since 2026-07-05 hindsight is UNPINNED (auth.consumers[hindsight] has no
 * `account:`) — it follows the fleet-active account and shares the SAME
 * live-turn quota the agents use. That makes the hard ceiling on concurrent
 * model calls (MAX_SLOTS × LLM_PARALLELISM) a direct tax on the fleet: on
 * 2026-07-06 an 18-way consolidation fan-out (3 × 6) across multiple banks
 * exhausted the shared account (429 rate-limit wall) and starved live agent
 * turns. Operator decision: hindsight keeps sharing the fleet's failover,
 * but consolidation must NEVER be able to exhaust the quota — so the
 * concurrency ceiling is throttled to 1 × 2 = 2 concurrent model calls
 * (was 18), and per-round scope is cut so an op can't monopolise a slot for
 * long.
 *
 * - MAX_SLOTS 1: at most one bank consolidates at a time (no cross-bank
 *   fan-out — that fan-out is exactly what walled the account).
 * - LLM_PARALLELISM 2: at most two tag-groups in flight within that one op.
 *   1 × 2 = 2 concurrent claude subprocesses, ceiling.
 * - MAX_MEMORIES_PER_ROUND 100: bounded scope per op → faster slot release,
 *   more re-queue points where the fleet can reclaim the quota.
 * - LLM_BATCH_SIZE 12 (unchanged): facts per LLM call — tokens-per-call, not
 *   concurrency, so it doesn't affect the shared-quota ceiling.
 * Consolidation now drains slower by design; that is the accepted trade for
 * never walling the live fleet. All values remain operator-overridable via
 * the generated compose / -e (raise them only with a dedicated isolated
 * account pinned back on the consumer).
 */
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE = 12;
export const HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS = 1;
export const HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM = 2;
export const HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND = 100;

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
export const HINDSIGHT_DEFAULT_MEM_LIMIT = "8g";
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
 * (8g) so shm can't starve the app. Applies to BOTH the standalone
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
 * Check if Docker is available on the system.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container is currently running.
 */
export function isHindsightRunning(): boolean {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "--filter", "name=switchroom-hindsight", "--format", "{{.Status}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container exists (running or stopped).
 */
export function isHindsightContainerExists(): boolean {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=switchroom-hindsight", "--format", "{{.Names}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
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
): void {
  const apiPort = ports?.apiPort ?? HINDSIGHT_DEFAULT_API_PORT;
  const uiPort = ports?.uiPort ?? HINDSIGHT_DEFAULT_UI_PORT;

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

  // Non-secret env stays on `-e` — provider name + observation cap are
  // configuration, not secrets. `HINDSIGHT_API_LLM_PROVIDER=claude-code`
  // selects the subscription-honest path; `HINDSIGHT_API_LLM_MODEL` pins the
  // memory-ops model (default HINDSIGHT_DEFAULT_MODEL, or the cheap LiteLLM
  // default, operator-overridable via `hindsight.llm`).
  const envArgs: string[] = [
    "-e", `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=${HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE}`,
    "-e", `HINDSIGHT_API_LLM_PROVIDER=${llmProvider}`,
    "-e", `HINDSIGHT_API_LLM_MODEL=${llmModel}`,
    // Per-op LLM overrides (only the configured vars — see resolveHindsightPerOpLlm).
    ...perOpLlm.flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-e", `HINDSIGHT_API_MCP_STATELESS=${HINDSIGHT_DEFAULT_MCP_STATELESS}`,
    // Reranker smart-defaults (v0.13.22) — see constants above for
    // rationale. Each closes a vendor-default gap that hurts our
    // CPU-only / shared-host / Telegram workload.
    "-e", `HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=${HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING}`,
    "-e", `HINDSIGHT_API_RERANKER_MAX_CANDIDATES=${HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES}`,
    "-e", `HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=${HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT}`,
    "-e", `HINDSIGHT_API_RECALL_MAX_CONCURRENT=${HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT}`,
    // Reflect wall timeout — let large-bank mental-model refreshes finish
    // (vendor 300s times out on 12k+ obs banks → stale user-profile models).
    "-e", `HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S}`,
    // Consolidation concurrency: throttled by #2894 to a hard ceiling of
    // MAX_SLOTS 1 × LLM_PARALLELISM 2 = 2 concurrent model calls (was 18), so
    // consolidation can never exhaust the shared failover quota. Batch size 12
    // and per-round scope 100 bound tokens/scope per op. See constants above.
    "-e", `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=${HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE}`,
    "-e", `HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=${HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS}`,
    "-e", `HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=${HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM}`,
    "-e", `HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND=${HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND}`,
  ];

  // The `claude-code` provider drives an underlying claude subprocess; pin
  // `ANTHROPIC_MODEL` to the same model so the subprocess (and any LiteLLM
  // proxy it routes through, below) targets it. Only meaningful for the
  // claude-code path — other providers ignore it.
  if (llmProvider === "claude-code") {
    envArgs.push("-e", `ANTHROPIC_MODEL=${llmModel}`);
  }

  if (litellm) {
    // Host-network mode: the container shares the host network stack so
    // 127.0.0.1:4010 (LiteLLM) is directly reachable, identical to how
    // agent containers work. Explicit port env vars preserve the same
    // external ports (18888/19999) the operator is used to.
    const litellmRoot = litellm.baseUrl.replace(/\/+$/, "");
    // Claude models ride the Anthropic pass-through (<root>/anthropic,
    // raw byte-forward, OAuth) — the model-mapped route re-chunks the SSE
    // stream and stalls long Claude responses mid-flight (the 2026-07-05
    // stall). Any other model (e.g. OpenRouter) MUST use the model-mapped
    // root instead — the pass-through only forwards to the real Anthropic
    // API, so a non-Claude model_name there 404s / always fails open.
    const anthropicBaseUrl = isClaudeModel(llmModel)
      ? `${litellmRoot}/anthropic`
      : litellmRoot;
    envArgs.push(
      // HINDSIGHT_API_PORT is the only port knob the upstream config.py
      // recognizes; the CP service has no equivalent env var override.
      "-e", `HINDSIGHT_API_PORT=${apiPort}`,
      // In host-network mode the container shares the host's network stack,
      // so the CP dashboard's dataplane calls resolve `localhost:<port>`
      // against host-bound listeners. The image default for the dataplane
      // URL is `http://localhost:8888`, but 8888 is where we MOVED OFF (it's
      // squatted on this host by an unrelated container → the dashboard's
      // data calls 502 while the API is healthy on ${apiPort}). Pin the CP
      // dataplane URL to the SAME port the API actually binds so it tracks
      // any auto-bump instead of the stale 8888 default.
      "-e", `HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:${apiPort}`,
      // LiteLLM routing: inherited by the claude_agent_sdk subprocess so
      // consolidation/reflect calls hit the proxy for spend tracking.
      "-e", `ANTHROPIC_BASE_URL=${anthropicBaseUrl}`,
      "-e", `ANTHROPIC_CUSTOM_HEADERS=x-litellm-api-key: Bearer ${litellm.apiKey}\nx-litellm-customer-id: hindsight\nx-litellm-tags: service:hindsight`,
    );
  }

  const args = [
    "run", "-d",
    "--name", "switchroom-hindsight",
    "--restart", "always",
    // Container resource caps (memory + pids only; CPU uncapped —
    // see HINDSIGHT_DEFAULT_MEM_LIMIT constant for the v0.13.22 → v0.13.23
    // unwind rationale).
    `--memory=${HINDSIGHT_DEFAULT_MEM_LIMIT}`,
    `--memory-reservation=${HINDSIGHT_DEFAULT_MEM_RESERVATION}`,
    `--pids-limit=${HINDSIGHT_DEFAULT_PIDS_LIMIT}`,
    // PostgreSQL needs far more than Docker's 64MB default shm (see
    // HINDSIGHT_DEFAULT_SHM_SIZE) or all writes/queries fail with
    // "No space left on device". Keep in sync with the compose snippet.
    `--shm-size=${HINDSIGHT_DEFAULT_SHM_SIZE}`,
    // Liveness signal for a wedged API: docker had no health probe for
    // hindsight, so an unresponsive server (or a never-booting one) stayed
    // "up" forever. This marks the container "unhealthy" in `docker inspect`
    // / `docker ps` so operators and the doctor probe can SEE the wedge.
    // NOTE: vanilla Docker does NOT auto-restart an unhealthy container —
    // `--restart always` acts on process EXIT only, never on health status.
    // So this is visibility, not a self-heal; an unhealthy-but-not-exited
    // API keeps running until something (operator / an autoheal sidecar)
    // acts on the status. See PR follow-up for the restart-on-unhealthy
    // mechanism. python3 is always present in the image; curl/wget are not.
    "--health-cmd", litellm
      ? `python3 -c 'import urllib.request,sys; sys.exit(0 if urllib.request.urlopen("http://localhost:${apiPort}/health",timeout=4).getcode()==200 else 1)'`
      : HINDSIGHT_HEALTHCHECK_CMD,
    "--health-interval", "30s",
    "--health-timeout", "5s",
    "--health-retries", "3",
    "--health-start-period", "60s",
  ];

  if (litellm) {
    // Host network: ports are published directly (no -p flags).
    args.push("--network", "host");
  } else {
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
 * Stop and remove the Hindsight Docker container.
 */
export function stopHindsight(): void {
  try {
    execFileSync("docker", ["stop", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be stopped */ }
  try {
    execFileSync("docker", ["rm", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be removed */ }
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
): string {
  const { provider: llmProvider, model: llmModel } = resolveHindsightLlm(llm);
  const perOpLlm = resolveHindsightPerOpLlm(llm);
  const environment = [
    `      - HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=${HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE}`,
    `      - HINDSIGHT_API_LLM_PROVIDER=${llmProvider}`,
    `      - HINDSIGHT_API_LLM_MODEL=${llmModel}`,
    // Per-op LLM overrides (only the configured vars — see resolveHindsightPerOpLlm).
    ...perOpLlm.map(([k, v]) => `      - ${k}=${v}`),
    // Mirror of the docker-run path: with the claude-code provider, pin
    // ANTHROPIC_MODEL to the same model for the underlying claude subprocess.
    ...(llmProvider === "claude-code" ? [`      - ANTHROPIC_MODEL=${llmModel}`] : []),
    // Pin the CP dashboard's dataplane URL to the port the API actually
    // binds INSIDE the container. This compose path is bridge-networked
    // (host ${HINDSIGHT_DEFAULT_API_PORT} → container 8888), so the API binds
    // the image default 8888 internally and there is no host-port collision
    // in the container's own netns. We still set the var explicitly (rather
    // than leaning on the image default) so it stays correct and matches the
    // docker-run path, where host-network mode requires it point at the
    // moved-off API port to dodge the squatted-8888 → 502 dashboard bug.
    `      - HINDSIGHT_CP_DATAPLANE_API_URL=http://localhost:8888`,
  ];
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
  return [
    "services:",
    ...initService,
    "  switchroom-hindsight:",
    `    image: ${HINDSIGHT_IMAGE}`,
    "    container_name: switchroom-hindsight",
    ...dependsOn,
    "    ports:",
    // Host side 18888/19999 → container 8888/9999. The host port MUST match
    // HINDSIGHT_DEFAULT_API_PORT / the scaffolded memory.config.url or agents
    // point at a dead URL (see the 2026-07 outage).
    // Bind to 127.0.0.1 only: the hindsight API is TOKENLESS, so publishing on
    // 0.0.0.0 would expose the unauthenticated MCP/REST surface to the network.
    // This mirrors the startHindsight() docker-run path, which binds loopback.
    `      - "127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}:8888"`,
    "      - \"127.0.0.1:19999:9999\"",
    "    environment:",
    ...environment,
    `      - HINDSIGHT_API_MCP_STATELESS=${HINDSIGHT_DEFAULT_MCP_STATELESS}`,
    `      - HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=${HINDSIGHT_DEFAULT_RERANKER_BUCKET_BATCHING}`,
    `      - HINDSIGHT_API_RERANKER_MAX_CANDIDATES=${HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES}`,
    `      - HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=${HINDSIGHT_DEFAULT_RERANKER_LOCAL_MAX_CONCURRENT}`,
    `      - HINDSIGHT_API_RECALL_MAX_CONCURRENT=${HINDSIGHT_DEFAULT_RECALL_MAX_CONCURRENT}`,
    `      - HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S}`,
    `      - HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=${HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE}`,
    `      - HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=${HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS}`,
    `      - HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=${HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM}`,
    `      - HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND=${HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND}`,
    `    mem_limit: ${HINDSIGHT_DEFAULT_MEM_LIMIT}`,
    `    mem_reservation: ${HINDSIGHT_DEFAULT_MEM_RESERVATION}`,
    `    pids_limit: ${HINDSIGHT_DEFAULT_PIDS_LIMIT}`,
    // PostgreSQL shm — see HINDSIGHT_DEFAULT_SHM_SIZE. Without this the
    // container gets Docker's 64MB default and all writes/queries fail.
    `    shm_size: ${HINDSIGHT_DEFAULT_SHM_SIZE}`,
    // Liveness — restart a wedged/never-booted API (see the docker-run path).
    "    healthcheck:",
    `      test: ${JSON.stringify(["CMD", "python3", "-c", HINDSIGHT_HEALTHCHECK_PY])}`,
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
