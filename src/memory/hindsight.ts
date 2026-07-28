import type { SwitchroomConfig, MemoryBackendConfig } from "../config/schema.js";
import { resolveUsers } from "../config/users.js";
import { HINDSIGHT_DEFAULT_API_PORT, HINDSIGHT_DEFAULT_MCP_URL } from "../setup/hindsight.js";

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * Claude Code tool-search escape hatch. When `ENABLE_TOOL_SEARCH` is on,
   * the CLI defers (lazy-loads) every MCP server's tool schemas by default;
   * `alwaysLoad: true` pins THIS server's tools to stay loaded so the model
   * can call them without a ToolSearch round-trip. Set on the load-bearing
   * framework servers (switchroom-telegram reply/get_recent_messages,
   * hindsight, agent-config); the heavy per-agent integration servers
   * (webkite/perplexity/marketing) deliberately omit it so they defer.
   * Claude Code reads `config.alwaysLoad` (CLI ≥2.1.x); harmless/ignored when
   * tool search is off or on older CLIs.
   */
  alwaysLoad?: boolean;
}

/**
 * In-container path to the switchroom CLI (`Dockerfile.agent` symlinks
 * `dist/cli/switchroom.js` here). Local copy of scaffold.ts's
 * DOCKER_SWITCHROOM_CLI_PATH — duplicated (not imported) because
 * scaffold.ts imports this module and the reverse import would be a cycle.
 * tests/memory.test.ts pins the two in lockstep.
 */
export const HINDSIGHT_SHIM_CLI_PATH = "/usr/local/bin/switchroom";

/**
 * In-container HOME for the agent (mirror of scaffold.ts
 * DOCKER_AGENT_HOME / compose.ts emitAgentService env). Claude Code spawns
 * MCP commands with a SANITIZED env, so HOME + the shim inputs must be
 * threaded explicitly onto the entry.
 */
export const HINDSIGHT_SHIM_AGENT_HOME = "/state/agent/home";

/**
 * Generate the MCP server config entry for Hindsight.
 *
 * Hindsight exposes MCP via Streamable HTTP at /mcp/. The host/port can be
 * overridden in switchroom.yaml's memory.config.url; defaults to 127.0.0.1:18888
 * (HINDSIGHT_DEFAULT_MCP_URL). The upstream default of 8888 conflicts with
 * Coolify, nginx front-proxies and tunnel gateways — hence the 18888 default,
 * which the launcher binds and the scaffolding writes in lockstep.
 *
 * Default transport is the **lazy-connect stdio shim**
 * (`switchroom hindsight-mcp-shim`, src/cli/hindsight-mcp-shim.ts): Claude
 * Code marks an HTTP MCP server failed for the ENTIRE session when the
 * backend is down at session start (~3 handshake retries, then only a
 * manual /mcp recovers), so a direct `type: "http"` entry couples the
 * agent's whole memory tool surface to hindsight being up at the instant
 * the session boots. The shim always completes the stdio handshake itself
 * and lazy-connects to the backend per call, so registration can never
 * fail and mid-session outages self-heal.
 *
 * Escape hatch: `memory.config.mcp_transport: "http"` restores the old
 * direct HTTP entry.
 */
export function generateHindsightMcpConfig(
  collection: string,
  memoryConfig: MemoryBackendConfig,
): McpServerConfig {
  const url = (memoryConfig.config?.url as string | undefined)
    ?? HINDSIGHT_DEFAULT_MCP_URL;
  if (memoryConfig.config?.mcp_transport === "http") {
    return {
      type: "http",
      url,
      headers: {
        "X-Bank-Id": collection,
      },
    };
  }
  return {
    type: "stdio",
    command: HINDSIGHT_SHIM_CLI_PATH,
    args: ["hindsight-mcp-shim"],
    // Claude Code spawns MCP commands with a sanitized env — every input
    // the shim needs must be threaded here explicitly (the X-Bank-Id
    // header of the http form becomes HINDSIGHT_BANK_ID).
    env: {
      HINDSIGHT_MCP_URL: url,
      HINDSIGHT_BANK_ID: collection,
      HINDSIGHT_SHIM_CACHE_DIR: `${HINDSIGHT_SHIM_AGENT_HOME}/.hindsight-shim`,
      HOME: HINDSIGHT_SHIM_AGENT_HOME,
    },
  };
}

/**
 * Generate a docker-compose YAML snippet for the Hindsight service.
 */
export function generateDockerComposeSnippet(
  memoryConfig: MemoryBackendConfig,
): string {
  const provider = memoryConfig.config?.provider ?? "ollama";
  const model = memoryConfig.config?.model;

  const envLines = [`      - LLM_PROVIDER=${provider}`];
  if (model) {
    envLines.push(`      - EMBEDDING_MODEL=${model}`);
  }
  if (memoryConfig.config?.api_key) {
    envLines.push(`      - API_KEY=${memoryConfig.config.api_key}`);
  }

  return [
    "hindsight:",
    "  image: ghcr.io/vectorize-io/hindsight:latest",
    "  ports:",
    `    - "${HINDSIGHT_DEFAULT_API_PORT}:8888"`,
    "    - \"19999:9999\"",
    "  environment:",
    ...envLines,
    "  volumes:",
    "    - hindsight-data:/home/hindsight/.pg0",
    "  restart: always",
  ].join("\n");
}

/**
 * Look up the Hindsight collection name for an agent.
 * Falls back to the agent's name if no explicit collection is configured.
 */
export function getCollectionForAgent(
  agentName: string,
  config: SwitchroomConfig,
): string {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.collection ?? agentName;
}

/**
 * Collect the standalone "profile banks" referenced across the config — the
 * per-user / shared hindsight banks that recall routes to but that are NOT any
 * agent's own `memory.collection`. Deduped, drawn from:
 *   - `users.<name>.profile_bank` (first-class users, even if not yet assigned)
 *   - every bank any agent actually recalls, via `resolveUsers` (so the cascade
 *     + `serves`/`knows` + explicit `additional_banks`/`sender_banks` are all
 *     covered, not just raw per-agent config).
 *
 * These are invisible to the agent-driven health surfaces (dashboard Memory
 * tab, `doctor`, `memory stats`), which only enumerate agent collections — so
 * each of those surfaces unions this set in to show profile-bank health too.
 *
 * With `excludeAgentCollections` (default true) any bank that is already some
 * agent's collection is dropped, so a bank never shows as both.
 */
export function collectProfileBanks(
  config: SwitchroomConfig,
  opts: { excludeAgentCollections?: boolean } = {},
): Set<string> {
  const { excludeAgentCollections = true } = opts;
  const banks = new Set<string>();
  for (const user of Object.values(config.users ?? {})) {
    if (user.profile_bank) banks.add(user.profile_bank);
  }
  for (const agentName of Object.keys(config.agents)) {
    const { senderBanks, additionalBanks } = resolveUsers(config, agentName);
    for (const b of Object.values(senderBanks)) banks.add(b);
    for (const b of additionalBanks) banks.add(b);
  }
  if (excludeAgentCollections) {
    for (const agentName of Object.keys(config.agents)) {
      banks.delete(getCollectionForAgent(agentName, config));
    }
  }
  return banks;
}

/**
 * Check whether an agent has strict memory isolation.
 * Strict agents are excluded from cross-agent reflection.
 */
export function isStrictIsolation(
  agentName: string,
  config: SwitchroomConfig,
): boolean {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.isolation === "strict";
}

/**
 * Single source of truth for "is Hindsight memory wiring active for
 * this config" — gates MCP tool injection, auto-recall, bank
 * creation/mission ops, and the memory system-prompt block.
 *
 * `SWITCHROOM_MEMORY_BACKEND=none` force-disables Hindsight regardless
 * of `memory.backend`, matching the precedence in
 * `src/cli/setup.ts:stepMemoryBackend`. Factored here after
 * install-validation 2026-05-17 (R2 / prior #25) found THREE
 * independent copies of `config.memory?.backend === "hindsight"` in
 * scaffold.ts, only one of which honored the env override — so a
 * `SWITCHROOM_MEMORY_BACKEND=none` install stayed clean through
 * `setup` but re-introduced Hindsight wiring (and "Failed to create
 * Hindsight bank" warnings) on the next `switchroom agent
 * restart`/`reconcile`. Keep this the only place that decides.
 *
 * Semantics preserved from the prior inline expression: config unset
 * or any non-"hindsight" value ⇒ false; only `backend: "hindsight"`
 * (and env not "none") ⇒ true.
 */
export function isHindsightEnabled(
  config: SwitchroomConfig | undefined,
): boolean {
  if (process.env.SWITCHROOM_MEMORY_BACKEND === "none") return false;
  return config?.memory?.backend === "hindsight";
}

/**
 * Recommended default `retain_mission` for new agents, and the SINGLE source
 * of truth for the retain mission across switchroom: the vendored plugin's
 * `vendor/hindsight-memory/settings.json` `retainMission` is pinned to this
 * exact string by a drift guard in `tests/memory.bank-missions.test.ts`.
 *
 * Why the pin: BOTH values reach the same extraction step. Switchroom seeds
 * the bank-side `retain_mission` here (via `updateBankMissions` at scaffold),
 * while the plugin independently pushes `settings.json`'s `retainMission`
 * through `lib/bank.py: ensure_bank_mission` the first time it sees a bank on
 * a fresh state dir. Before 2026-07-25 the two texts differed, so which
 * mission actually shaped extraction depended on scaffold-vs-plugin ordering.
 *
 * Historically sourced from upstream Hindsight's per-user-memory guide:
 *   https://github.com/vectorize-io/hindsight/blob/main/hindsight-docs/guides/2026-04-15-guide-openclaw-per-user-memory-across-channels-setup.md
 *   (lines 188–193)
 *
 * The mission shapes the LLM extraction step that fires inside
 * Hindsight's auto-retain. Tighter wording here directly lifts retained
 * memory quality (less conversational filler stored, fewer marginal hits
 * surfacing in subsequent recalls).
 *
 * 2026-07-19 (hindsight fleet review): live fleet banks skewed heavily
 * toward transient in-flight-task narration ("P6 worker paused waiting on
 * its PR", "three more tracks dispatched") — experience-node volume
 * exceeded world-fact volume on the busiest bank. That class of memory is
 * process status, not a fact/decision/outcome worth recalling later, and
 * it's exactly what feeds the consolidation backlog. Added an explicit
 * carve-out below so the extraction step recognizes it as noise alongside
 * one-off chatter, not just "temporary task noise" (which didn't stop the
 * pattern in practice).
 *
 * Switchroom seeds this for newly scaffolded agents only (see
 * `scaffoldAgent` in `src/agents/scaffold.ts`). Existing agents'
 * missions are left alone — operators may have customized them, and
 * `reconcileAgent` does not push a default. Operators can always
 * override per-agent via `agents.<name>.memory.retain_mission` in
 * `switchroom.yaml`.
 *
 * 2026-07-25 (retain-noise pass): the extraction model is `gpt-oss-20b` —
 * small and local. A general principle ("ignore transient operational
 * details") did not survive contact with it: production banks stored pure
 * transcript traces ("The assistant used ToolSearch to query for hindsight
 * bank statistics"), hindsight's own failures with the batch UUID inline,
 * restatements of the then-current prompt, and undated transient state
 * ("User has no unread mail" — which then recalls forever as a standing
 * fact). Small models need concrete NEGATIVE examples, so the exclusions
 * below are enumerated. The positive counterweight sentence ("a preference
 * revealed by a request is durable") is load-bearing: without it, an
 * exclusion-only mission made the model return an empty/degenerate response
 * on chatty-but-real turns (measured against 6 live retain windows).
 *
 * 2026-07-25 (review finding 4, PROPOSED AND THEN REVERTED — do not
 * re-attempt without better evidence): a follow-up review argued bullet 7
 * ("Greetings, acknowledgements, and routine operational chatter") was a
 * vibe judgement that discarded soft taste preferences on the fleet's
 * non-coding agents, and narrowed it to content-free acknowledgements plus a
 * personal-likes clause. Sampling disproved the premise and showed the change
 * was a regression:
 *  - the claimed film-window loss did not reproduce — the mission as written
 *    below already kept the horror-dislike and film preferences;
 *  - on a real operational window the narrowed mission extracted 8 facts vs 0
 *    for this text and 4 for the pre-PR default, including "Plugin PR worker
 *    still running" — which the in-flight-narration bullet above explicitly
 *    forbids. Looser than the baseline it was meant to improve on;
 *  - the sampling method is unreliable at n=1: identical input under the
 *    identical narrowed mission yielded 0, then 6, then 6 facts.
 * So the text stays as-is and the mission-CONTENT question is deferred to
 * #3532 (profile-scoped retain missions) — a coding agent and a health coach
 * should not share one extraction mission, which is the durable fix that a
 * single global reword cannot be.
 *
 * 2026-07-28 (tool-exhaust pass — the text below). The 2026-07-25 mission
 * shipped and reached every live bank, and it still leaked transcript exhaust.
 * That is measured, not argued: the mission above was live on overlord from
 * 2026-07-27 12:03, klanker from 2026-07-25 09:19 and finn/carrie from
 * 2026-07-26 14:03, yet overlord's whole-shape tool-exhaust rate ran 1.12 /
 * 1.18 / 0.69 units per 1k world+experience units on 2026-07-25 / -26 / -27,
 * ABOVE its 0.00–0.83 per 1k over the preceding week.
 *
 * So this revision was chosen by A/B rather than by taste. The arms were run
 * offline against the REAL extraction path — `fact_extraction`'s
 * `_build_extraction_prompt_and_schema` + `_retain_mission_preamble` +
 * `_build_user_message` + `_build_request_body`, POSTed to the same LiteLLM
 * endpoint and the same local `gpt-oss:20b` the retain worker uses — over 52
 * real retain chunks sampled from windows that had actually leaked. Nothing
 * was written to any bank. Hand-labelled over all 143 extracted facts:
 *
 *   arm A (the 2026-07-25 mission): 84 facts, 42 tool exhaust (50.0%), 42 durable
 *   arm B (this text):              59 facts, 12 tool exhaust (20.3%), 47 durable
 *
 * The durable count going UP while the total falls is the point: B is not
 * simply extracting less. Caveats, stated because they bound the claim — the
 * labelling is single-rater, n=52 chunks, one model.
 *
 * What changed, and why each part earns its bytes:
 *  - The "A TOOL RESULT IS NOT A FACT" test up front. gpt-oss-20b applies a
 *    subject test far more reliably than a category test; every remaining
 *    bullet is a special case of it.
 *  - Verbatim negative exemplars lifted from units the previous mission
 *    actually let through, not invented ones. The 2026-07-25 note above is
 *    right that small models need concrete negatives; it just did not have
 *    enough of them, and the ones it had did not cover tool RESULTS.
 *  - A /tmp-and-scratchpad-path bullet, and a slash-command bullet.
 *  - The positive counterweight sentence is preserved unchanged and remains
 *    load-bearing (see 2026-07-25 above).
 *  - Bullet 7 ("greetings, acknowledgements...") is preserved verbatim: the
 *    2026-07-25 revert finding above stands and was not re-litigated here.
 *
 * KNOWN RESIDUAL — this does not close the hole. B's 12 remaining exhaust
 * facts are dominated by one class (6 of 12): Claude Code's own Bash-tool
 * system reminder, "the session's current working directory remains <path>;
 * directory changes made by backgrounded commands do not affect subsequent
 * commands". 127 paraphrases of that single sentence already sit in live
 * banks (overlord 84, klanker 39, finn 3, carrie 1, hand-checked, 0/127 false
 * positives). It survives the mission because it is not false and does not
 * look like narration — it reads as a durable system fact. A prompt cannot be
 * expected to win that one; if it needs closing it wants a deterministic
 * pre-retain filter, which is deliberately NOT in this PR.
 *
 * 2026-07-28 (volatile-state pass — the "Volatile state written as a timeless
 * assertion" bullet). A SECOND failure class, distinct from tool exhaust and
 * not addressed by the pass above: point-in-time state facts retained as bare
 * timeless assertions, which nothing ever supersedes and which therefore recall
 * forever as though still true.
 *
 * Measured on bank `klanker` (2026-07-28), not argued. The query "what version
 * is the switchroom fleet running right now" returned 38 results. Top hit:
 * `Switchroom fleet is running image version v0.18.19` — retained 2026-07-19
 * and wrong by then — followed by v0.19.6, v0.19.8, v0.18.7 and v0.16.49. The
 * correct current value did not appear at all. The same query surfaced FIVE
 * near-identical copies of one "the repo is at <path>, version v0.19.5" fact,
 * retained on different days.
 *
 * Note what this is NOT: not a consolidation failure (consolidation rewrites
 * the observation when a new fact contradicts an old one, but the stale raw
 * fact survives and still recalls), and not something the dedup threshold can
 * reach (`_dedup_adjudicate` probes `["observation"]` only — see the note on
 * the dedup threshold in src/setup/hindsight-perf-defaults.ts). The read-time
 * lever is `prefer_observations`, already on by default. The retain-time lever
 * is this bullet: stop creating the undated assertion in the first place.
 *
 * The existing "Transient state ... unless the fact is explicitly dated" bullet
 * was live on klanker's bank from 2026-07-25 09:19 and did not stop any of the
 * above, so it is kept (the 2026-07-25 finding that removing bullets regresses
 * extraction stands) and a stronger bullet is added ABOVE it. The new bullet
 * follows the shape the 2026-07-28 A/B proved out rather than inventing a new
 * one: a subject test ("a version, count, size, backlog, status ... is true
 * only at the instant it was said"), verbatim negative exemplars lifted from
 * units that actually leaked into the live bank, and an explicit repair
 * instruction (date it inline, else drop) so the model has somewhere to put a
 * claim that IS worth keeping.
 *
 * HONESTLY BOUNDED — this bullet was NOT re-run through the 52-chunk offline
 * A/B that chose the text above; it is justified by the live-bank measurement
 * plus consistency with that pass's proven shape. It is additive (no existing
 * bullet was removed or reworded), which bounds the regression risk to
 * "extraction gets slightly more conservative", and the positive counterweight
 * sentence is untouched. If it needs stronger evidence, re-run the A/B harness
 * described above with this as arm C.
 */
export const DEFAULT_RETAIN_MISSION =
  "Extract durable facts that will still be true and useful weeks from now: user preferences and standing rules, ongoing projects and recurring commitments, technical and architectural decisions with their rationale, and people/tool relationships. A preference revealed by a request is durable — record the preference (what the user likes, wants, or always does), not the request itself.\n" +
  "\n" +
  "A TOOL RESULT IS NOT A FACT. Before extracting, ask: is the subject of this\n" +
  "candidate a file path, a command/process/agent/session id, a temp directory, or\n" +
  "the location where some output was written? If yes, drop it — it is transcript\n" +
  "exhaust, not memory.\n" +
  "\n" +
  "NEVER extract:\n" +
  "- Tool results verbatim or paraphrased. Concretely, never produce a fact whose\n" +
  "  text resembles any of these: \"File created successfully at /path/to/file\",\n" +
  "  \"A background command with ID bctz4yskm is running, and its output will be\n" +
  "  written to /tmp/...\", \"Async agent a745598ba84e71df1 was launched successfully\n" +
  "  and is running in the background\", \"User executed a Bash command to sleep for\n" +
  "  200 seconds\", \"The assistant used grep to locate 'truncateSync' in src/foo.ts\".\n" +
  "- Anything mentioning a path under /tmp, a scratchpad directory, or a .tmp file.\n" +
  "- Agent tool-use traces or narration of what the assistant did (e.g. \"the\n" +
  "  assistant used X to query Y\", \"ran a search\", \"sent the message\").\n" +
  "- In-flight workflow/process narration (a sub-task started, paused, or is still\n" +
  "  running) — retain the outcome only once the task completes or a decision is made.\n" +
  "- Operation, request, batch, agent, command or session IDs, UUIDs, hashes, or error codes.\n" +
  "- Slash commands the user typed and their effects (e.g. \"User issued /clear to\n" +
  "  reset assistant state\").\n" +
  "- Hindsight's own errors, retries, backlogs, or internal state — the memory\n" +
  "  system's self-reports are not memories.\n" +
  "- Restatements of the user's current request or the task in progress.\n" +
  "- Volatile state written as a timeless assertion. A version, count, size,\n" +
  "  backlog, status, or any \"X is running Y\" / \"X is at Y\" / \"X is currently Y\"\n" +
  "  claim is true only at the instant it was said. Concretely, never produce a\n" +
  "  fact whose text resembles any of these: \"Switchroom fleet is running image\n" +
  "  version v0.18.19\", \"The switchroom repo is at /path/to/fleet, version\n" +
  "  v0.19.5\", \"Bank overlord has 43155 pending consolidations\", \"The build is\n" +
  "  currently green\". If the claim is worth keeping, put the date INSIDE the\n" +
  "  fact text (\"As of 2026-07-19 the fleet was running v0.18.19\"); if you\n" +
  "  cannot date it, drop it. An undated one is recalled forever as though it\n" +
  "  were still true, which is worse than not remembering it at all.\n" +
  "- Transient state (unread counts, build status, what is running right now) unless\n" +
  "  the fact is explicitly dated, in which case record it as a dated observation.\n" +
  "- Greetings, acknowledgements, and routine operational chatter.\n" +
  "\n" +
  "If a candidate fact matches an exclusion, drop it rather than rewording it. If\n" +
  "nothing durable remains, return an empty facts list.";

/**
 * Ordered registry of every retain mission switchroom has ever shipped as a
 * DEFAULT, oldest first. Purely historical — do not edit an entry, only
 * append the outgoing text when `DEFAULT_RETAIN_MISSION` changes.
 *
 * Why it exists (2026-07-25 review finding 1, corrected by the re-review):
 * a rewrite of `DEFAULT_RETAIN_MISSION` DID reach live banks — but only by
 * accident, and unsafely. `switchroom apply` re-scaffolds every agent
 * (`src/cli/apply.ts`; it never calls `reconcileAgent`), and scaffold pushed
 * `retain_mission: configured ?? DEFAULT_RETAIN_MISSION` unconditionally on
 * every run. That is the mechanism by which all 24 live banks came to carry
 * `SUPERSEDED_RETAIN_MISSIONS[2]` despite no agent setting `retain_mission` in
 * `switchroom.yaml` (verified live 2026-07-25). The `reconcileAgent` path —
 * which pushed only an operator's yaml mission — and the plugin's
 * `ensure_bank_mission` short-circuit were both dead ends, so the propagation
 * nobody had designed was the one doing the work.
 *
 * The problem was the *unconditional* part: an operator who hand-edited a
 * mission through the Hindsight API had it silently overwritten on the next
 * apply. Both bank-op sites now route through `decideRetainMissionUpgrade`
 * (`resolveRetainMissionPush` in scaffold.ts), and this registry is what makes
 * the push safe: it fires only when the bank's current mission byte-equals a
 * known previous default (or is unset). Any customization — a hand-edit
 * through the API, even a whitespace difference — matches nothing here and is
 * left untouched. Operator yaml still wins outright.
 *
 * The registry/REST read machinery is load-bearing on BOTH paths now; before
 * the re-review fix it was reached only on `agent reconcile` / restart
 * (`src/cli/agent.ts`).
 */
export const SUPERSEDED_RETAIN_MISSIONS: readonly string[] = [
  // 3e028eeb3 (2026-05) — the vendored plugin's original settings.json
  // `retainMission`, pushed bank-side by lib/bank.py ensure_bank_mission.
  "Extract technical decisions, architectural choices, user preferences, project context, and people/tool relationships. Ignore routine greetings and transient operational details.",
  // d7c406994 (#458) — first switchroom-seeded DEFAULT_RETAIN_MISSION.
  "Extract user preferences, ongoing projects, recurring commitments, " +
    "important context, and durable facts that should help across future " +
    "conversations. Skip one-off chatter and temporary task noise.",
  // 9a9b7176c (#3418) — added the in-flight-narration carve-out. This is the
  // text every live bank was carrying as of 2026-07-25.
  "Extract user preferences, ongoing projects, recurring commitments, " +
    "important context, and durable facts that should help across future " +
    "conversations. Skip one-off chatter and temporary task noise, " +
    "including in-flight workflow/process narration (a sub-task started, " +
    "paused, or is still running) — only retain the outcome once a task " +
    "actually completes or a decision is made.",
  // (2026-07-25 retain-noise pass) — first mission to enumerate negative
  // exemplars. This is the text every live bank was carrying as of
  // 2026-07-27, and the A arm of the A/B recorded on DEFAULT_RETAIN_MISSION.
  "Extract durable facts that will still be true and useful weeks from now: " +
  "user preferences and standing rules, ongoing projects and recurring " +
  "commitments, technical and architectural decisions with their rationale, " +
  "and people/tool relationships. A preference revealed by a request is " +
  "durable — record the preference (what the user likes, wants, or always " +
  "does), not the request itself.\n\n" +
  "NEVER extract:\n" +
  "- Agent tool-use traces or narration of what the assistant did (e.g. " +
  '"the assistant used X to query Y", "ran a search", "sent the message").\n' +
  "- In-flight workflow/process narration (a sub-task started, paused, or is " +
  "still running) — retain the outcome only once the task completes or a " +
  "decision is made.\n" +
  "- Operation, request, batch or session IDs, UUIDs, hashes, or error codes.\n" +
  "- Hindsight's own errors, retries, backlogs, or internal state — the " +
  "memory system's self-reports are not memories.\n" +
  "- Restatements of the user's current request or the task in progress.\n" +
  "- Transient state (unread counts, build status, what is running right now) " +
  "unless the fact is explicitly dated, in which case record it as a dated " +
  "observation.\n" +
  "- Greetings, acknowledgements, and routine operational chatter.\n\n" +
  "If a candidate fact matches an exclusion, drop it rather than rewording " +
  "it. If nothing durable remains, return an empty facts list.",
  // (2026-07-28 tool-exhaust pass, #3878) — the A/B-selected arm B. This is
  // the text every live bank was carrying when the volatile-state bullet was
  // added below it. Reproduced verbatim from the outgoing literal, line for
  // line, so `isUpgradableRetainMission` still byte-matches a bank that has
  // it and can upgrade rather than treating it as an operator customization.
  "Extract durable facts that will still be true and useful weeks from now: user preferences and standing rules, ongoing projects and recurring commitments, technical and architectural decisions with their rationale, and people/tool relationships. A preference revealed by a request is durable — record the preference (what the user likes, wants, or always does), not the request itself.\n" +
  "\n" +
  "A TOOL RESULT IS NOT A FACT. Before extracting, ask: is the subject of this\n" +
  "candidate a file path, a command/process/agent/session id, a temp directory, or\n" +
  "the location where some output was written? If yes, drop it — it is transcript\n" +
  "exhaust, not memory.\n" +
  "\n" +
  "NEVER extract:\n" +
  "- Tool results verbatim or paraphrased. Concretely, never produce a fact whose\n" +
  "  text resembles any of these: \"File created successfully at /path/to/file\",\n" +
  "  \"A background command with ID bctz4yskm is running, and its output will be\n" +
  "  written to /tmp/...\", \"Async agent a745598ba84e71df1 was launched successfully\n" +
  "  and is running in the background\", \"User executed a Bash command to sleep for\n" +
  "  200 seconds\", \"The assistant used grep to locate 'truncateSync' in src/foo.ts\".\n" +
  "- Anything mentioning a path under /tmp, a scratchpad directory, or a .tmp file.\n" +
  "- Agent tool-use traces or narration of what the assistant did (e.g. \"the\n" +
  "  assistant used X to query Y\", \"ran a search\", \"sent the message\").\n" +
  "- In-flight workflow/process narration (a sub-task started, paused, or is still\n" +
  "  running) — retain the outcome only once the task completes or a decision is made.\n" +
  "- Operation, request, batch, agent, command or session IDs, UUIDs, hashes, or error codes.\n" +
  "- Slash commands the user typed and their effects (e.g. \"User issued /clear to\n" +
  "  reset assistant state\").\n" +
  "- Hindsight's own errors, retries, backlogs, or internal state — the memory\n" +
  "  system's self-reports are not memories.\n" +
  "- Restatements of the user's current request or the task in progress.\n" +
  "- Transient state (unread counts, build status, what is running right now) unless\n" +
  "  the fact is explicitly dated, in which case record it as a dated observation.\n" +
  "- Greetings, acknowledgements, and routine operational chatter.\n" +
  "\n" +
  "If a candidate fact matches an exclusion, drop it rather than rewording it. If\n" +
  "nothing durable remains, return an empty facts list.",
];

/**
 * Should reconcile overwrite this bank's retain mission with the current
 * `DEFAULT_RETAIN_MISSION`?
 *
 * True when the bank has no mission at all, or its mission byte-equals a
 * superseded default. False for anything else — including the current
 * default (nothing to do) and any operator customization (never clobbered).
 */
export function isUpgradableRetainMission(current: string | null | undefined): boolean {
  if (current == null || current.trim() === "") return true;
  return SUPERSEDED_RETAIN_MISSIONS.includes(current);
}

/**
 * Reconcile-time retain-mission decision (pure).
 *
 * @param configured `agents.<name>.memory.retain_mission` from yaml, if any.
 * @param current    The bank's live `retain_mission`; null ONLY when the read
 *                   succeeded and the field is genuinely unset. A FAILED read
 *                   must not be passed as null — the caller skips the retain
 *                   push entirely in that case, because "unknown" must never
 *                   be treated as "upgradable" (that would clobber a
 *                   customized mission whenever Hindsight hiccups).
 *
 * Three outcomes:
 *  - `"config"`   — the operator set a mission in yaml; push it verbatim
 *                   (unchanged pre-existing behaviour, and it wins outright).
 *  - `"upgrade"`  — no yaml mission and the bank is carrying an unset or
 *                   superseded default; push `DEFAULT_RETAIN_MISSION`.
 *  - `"none"`     — the bank is already current, or carries a mission that is
 *                   NOT a known default (i.e. someone customized it). Leave
 *                   it alone.
 */
export function decideRetainMissionUpgrade(
  configured: string | undefined | null,
  current: string | null,
): { action: "config" | "upgrade" | "none"; mission?: string } {
  return decideMissionUpgrade(
    configured,
    current,
    DEFAULT_RETAIN_MISSION,
    SUPERSEDED_RETAIN_MISSIONS,
  );
}

/**
 * Field-agnostic form of {@link decideRetainMissionUpgrade}.
 *
 * The never-clobber rule is the whole point, and it is identical for every
 * mission-shaped bank config field: switchroom may seed and upgrade its OWN
 * defaults, and must never overwrite text a human wrote. Encoding it once means
 * a second managed mission field (`observations_mission`, below) cannot drift
 * into a weaker rule by being implemented separately.
 *
 * @param configured Operator yaml value, if any. Wins outright, needs no read.
 * @param current    The bank's live value; null ONLY when the read SUCCEEDED
 *                   and the field is genuinely unset. A FAILED read must not be
 *                   passed here at all — see `decideRetainMissionUpgrade`'s doc.
 * @param desired    The default switchroom wants the bank to carry.
 * @param shipped    Every OTHER value switchroom has ever shipped as a default
 *                   for this field. Membership is byte-equality, so any
 *                   hand-edit (even whitespace) matches nothing and is left
 *                   alone.
 */
export function decideMissionUpgrade(
  configured: string | undefined | null,
  current: string | null,
  desired: string,
  shipped: readonly string[],
): { action: "config" | "upgrade" | "none"; mission?: string } {
  if (configured) return { action: "config", mission: configured };
  if (current === desired) return { action: "none" };
  if (current == null || current.trim() === "" || shipped.includes(current)) {
    return { action: "upgrade", mission: desired };
  }
  return { action: "none" };
}

/**
 * Recommended default `observations_mission` for every switchroom-managed bank
 * — the consolidation-side counterpart to {@link DEFAULT_RETAIN_MISSION}.
 *
 * ## The divergence this closes
 *
 * `observations_mission` is a documented Hindsight bank config field: "Defines
 * what this bank should synthesise into durable observations"
 * (<https://hindsight.vectorize.io/> bank configuration reference). Switchroom
 * already had every piece of plumbing for it — `BankMissionExtras`,
 * `resolveBankMissionExtras`, the `config_updates` write path — but the only
 * value that ever reached a bank was
 * `PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission`, keyed on
 * `agents.<name>.extends`. Verified live 2026-07-28 against
 * switchroom-hindsight (`GET /v1/default/banks/<id>/config` for every bank):
 * all 27 banks carried `observations_mission: null`, including the
 * health-coach agent's, because every live agent runs `extends: default`. The
 * whole fleet therefore ran the engine's stock mission and the profile knob was
 * dead code in practice.
 *
 * The stock mission is `_DEFAULT_MISSION` in
 * `hindsight_api/engine/consolidation/prompts.py:10` — "Track anything notable
 * in the new facts — names, numbers, dates, places, events, decisions, claims,
 * relationships, and recurring patterns." It is deliberately maximal, and it is
 * the wrong shape for a switchroom bank for two reasons that are checkable
 * rather than aesthetic:
 *
 *  - **The observation tier is PREFERRED at recall.** `memory.recall.types`
 *    defaults to `["world","experience","observation"]` and
 *    `prefer_observations` defaults to true (`src/config/schema.ts`). So
 *    switchroom biases the injected block toward observations while telling the
 *    consolidator to synthesise "anything notable".
 *  - **The raw fact layer leaks exactly what "anything notable" preserves.**
 *    `DEFAULT_RETAIN_MISSION` above records the measured tool-exhaust leak (A/B
 *    over 52 real retain chunks; 20.3% residual exhaust in the shipped arm),
 *    and consolidation reads those leaked facts. Scoping the consolidation step
 *    is the second line of defence on the SAME failure, at the tier recall
 *    prefers.
 *
 * ## Blast radius — narrower than the docs claim
 *
 * The bank-config doc page says `observations_mission` "replaces the built-in
 * consolidation rules entirely". That overstates it, and the difference is why
 * this change is low-risk. In the deployed engine
 * (`ghcr.io/switchroom/switchroom-hindsight:v0.19.26`, read 2026-07-28)
 * `build_batch_consolidation_prompt` (`prompts.py:159`) substitutes this text
 * for the `## MISSION` block ONLY; `_PROCESSING_RULES` (prefer-update-over-
 * create, one-facet-per-observation, match-by-entity, state-change cascade),
 * `_DECISION_GUIDE` and `_OUTPUT_SECTION` are concatenated unconditionally on
 * every call. So this text scopes WHAT is synthesised and cannot disable
 * merge/dedup behaviour.
 *
 * The engine does state its own precedence — "If anything in this MISSION
 * conflicts with the PROCESSING RULES ... the MISSION takes priority"
 * (`prompts.py:15`). The text below is therefore written purely in scope terms
 * (what to keep, what to drop) and says nothing about merge-vs-create, so it
 * never contradicts the rules it outranks.
 *
 * ## Why this text
 *
 * It keeps the stock mission's positive coverage — the consolidator must still
 * be told it may record decisions, relationships and patterns. An
 * exclusion-only mission produced degenerate empty output against this same
 * small local extraction model in the retain-mission work above, which is why
 * the positive clause leads and the exclusions follow.
 */
export const DEFAULT_OBSERVATIONS_MISSION =
  "Synthesise durable, standing knowledge about the people, projects, and systems this agent works with: preferences and standing rules, roles and relationships, skills and recurring patterns, technical and operational decisions with their rationale, and the state of long-running work once it lands.\n" +
  "\n" +
  "The test is durability, not notability: an observation must still be worth reading weeks from now. A single dated event belongs in an observation only when it establishes or changes a standing fact.\n" +
  "\n" +
  "Do NOT synthesise observations from:\n" +
  "- Transcript exhaust — tool calls and their results, file paths, temp or scratchpad directories, where some output was written, or narration of what an assistant did.\n" +
  "- Identifiers with no standing meaning: session, agent, request, batch or command IDs, UUIDs, hashes, error codes.\n" +
  "- In-flight process narration — a task started, paused, or still running. Record the outcome once it lands, not the running state.\n" +
  "- The memory system's own errors, retries, backlogs, or internal state.\n" +
  "- Transient state (what is running right now, unread counts, build status) unless the fact is explicitly dated, in which case record it as dated.\n" +
  "\n" +
  "If the new facts contain nothing durable, record nothing rather than synthesising a weak observation.";

/**
 * Ordered registry of every `observations_mission` switchroom has shipped as a
 * DEFAULT, oldest first — the `observations_mission` analogue of
 * {@link SUPERSEDED_RETAIN_MISSIONS}, consumed the same way by
 * {@link decideMissionUpgrade}. Append the OUTGOING text when
 * {@link DEFAULT_OBSERVATIONS_MISSION} changes; never edit an entry.
 *
 * Seeded with the `health-coach` profile default, which is the only
 * observations mission switchroom has ever pushed. Listing it here is what lets
 * an existing health-coach bank carrying it be recognised as switchroom-authored
 * and upgradable, rather than mistaken for an operator hand-edit and frozen.
 */
export const SUPERSEDED_OBSERVATIONS_MISSIONS: readonly string[] = [
  // PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission, shipped since
  // the Phase 2 bank-specialisation work.
  "Synthesise the person's wellbeing patterns, motivations, and emotional " +
    "context — how habits, setbacks, and encouragement connect over time.",
];

/**
 * Reconcile-time `observations_mission` decision (pure).
 *
 * Precedence: operator yaml > built-in profile default > the fleet default. The
 * profile default is the DESIRED value for a profiled agent rather than a mere
 * fallback, so a health-coach bank keeps its wellbeing mission instead of being
 * flattened to the generic one.
 *
 * @param configured     `agents.<name>.memory.observations_mission` from yaml.
 * @param profileDefault `PROFILE_MEMORY_DEFAULTS[<profile>].observations_mission`.
 * @param current        The bank's live value; null ONLY on a SUCCESSFUL read of
 *                       an unset field (see {@link decideMissionUpgrade}).
 */
export function decideObservationsMissionUpgrade(
  configured: string | undefined | null,
  profileDefault: string | undefined,
  current: string | null,
): { action: "config" | "upgrade" | "none"; mission?: string } {
  const desired = profileDefault ?? DEFAULT_OBSERVATIONS_MISSION;
  // Every text switchroom has ever shipped as a default for this field is
  // upgradable, INCLUDING the current fleet default — otherwise a profiled
  // agent whose bank was seeded generically could never reach its profile
  // mission. `desired` itself is excluded so the "already current" short-circuit
  // in decideMissionUpgrade stays the one that fires.
  const shipped = [...SUPERSEDED_OBSERVATIONS_MISSIONS, DEFAULT_OBSERVATIONS_MISSION].filter(
    (m) => m !== desired,
  );
  return decideMissionUpgrade(configured, current, desired, shipped);
}

/**
 * Read a bank's current `retain_mission` from Hindsight.
 *
 * Uses the REST config surface, NOT MCP: `get_bank` returns only
 * bank_id/name/disposition/mission (verified live 2026-07-25 against
 * switchroom-hindsight) — the retain mission is a CONFIG field and is
 * readable only at `GET /v1/default/banks/<id>/config`. Same asymmetry as
 * the write path, where `retain_mission` must ride in `config_updates`.
 *
 * Best-effort with a short timeout; never throws. `{ ok: true, mission: null }`
 * means the bank exists and the `retain_mission` KEY is present but null —
 * i.e. genuinely unset.
 *
 * A 200 whose body lacks `config`, or whose `config` lacks the
 * `retain_mission` key at all, is reported as `{ ok: false }` — NOT as
 * "unset". `isUpgradableRetainMission(null)` is true, so mapping an
 * unrecognised shape to null would push the default over every customized
 * mission fleet-wide the day Hindsight renests or renames the field
 * (2026-07-25 re-review M1).
 */
export async function fetchBankRetainMission(
  apiUrl: string,
  bankId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; mission: string | null } | { ok: false; reason: string }> {
  return fetchBankMissionField(apiUrl, bankId, "retain_mission", opts);
}

/**
 * Read a bank's current `observations_mission` from Hindsight. Same contract,
 * timeouts and unrecognised-shape posture as {@link fetchBankRetainMission} —
 * see that doc comment; only the config key differs.
 */
export async function fetchBankObservationsMission(
  apiUrl: string,
  bankId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; mission: string | null } | { ok: false; reason: string }> {
  return fetchBankMissionField(apiUrl, bankId, "observations_mission", opts);
}

/**
 * Shared reader behind {@link fetchBankRetainMission} and
 * {@link fetchBankObservationsMission}.
 *
 * The unrecognised-shape posture is the load-bearing part and is why this is
 * one function rather than two: a 200 whose body lacks `config`, or whose
 * `config` lacks the requested KEY, is `{ ok: false }` and NOT "unset". The
 * upgrade decision treats null as upgradable, so mapping an unrecognised shape
 * to null would push a default over every customized mission fleet-wide the day
 * Hindsight renests or renames a field (2026-07-25 re-review M1).
 */
async function fetchBankMissionField(
  apiUrl: string,
  bankId: string,
  field: "retain_mission" | "observations_mission",
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; mission: string | null } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const base = apiUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const url = `${base}/v1/default/banks/${encodeURIComponent(bankId)}/config`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const body = (await resp.json()) as {
      config?: Record<string, unknown> | null;
    };
    const config = body?.config;
    if (config == null || typeof config !== "object") {
      return { ok: false, reason: "Unexpected shape" };
    }
    if (!(field in config)) {
      return { ok: false, reason: "Unexpected shape" };
    }
    const mission = config[field];
    if (mission != null && typeof mission !== "string") {
      return { ok: false, reason: "Unexpected shape" };
    }
    return { ok: true, mission: (mission as string | undefined) ?? null };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}

/**
 * Hindsight bank disposition traits (1-5 each). Mirrors the engine's flat
 * `disposition_skepticism` / `disposition_literalism` / `disposition_empathy`
 * config fields (confirmed against the live `/v1/bank-template-schema`:
 * integers 1-5, engine default 3 when null). switchroom models them as one
 * nested object for ergonomic YAML and flattens at the API boundary.
 */
export interface BankDisposition {
  skepticism?: number;
  literalism?: number;
  empathy?: number;
}

/**
 * Extra bank-mission fields threaded through the config cascade (Phase 2 of
 * `reference/rfcs/hindsight-synthesis-layers.md` — "a persona without its own
 * memory is cosplay"; banks should be *specialized*, not merely isolated).
 *
 * `reflect_mission` and `observations_mission` are string config fields;
 * `disposition` flattens to the three `disposition_*` integer fields.
 */
export interface BankMissionExtras {
  reflect_mission?: string;
  observations_mission?: string;
  disposition?: BankDisposition;
}

/**
 * Code-level memory defaults keyed by built-in **filesystem** profile
 * (`agents.<name>.extends`). These differentiate the specialists so the
 * feature works on a fresh `switchroom setup` with zero YAML (defaults
 * principle) — a coach leans empathy-high, an analyst/EA leans skeptical and
 * literal. Operator config (already cascaded) overrides these per-key.
 *
 * Only `disposition` + `observations_mission` are defaulted here; the
 * persona statement (`reflect_mission` / `bank_mission`) stays operator-driven
 * so there is no code-vs-yaml persona conflict. Profiles not listed inherit
 * the engine default (all traits 3, no observations mission).
 */
export const PROFILE_MEMORY_DEFAULTS: Record<string, BankMissionExtras> = {
  "health-coach": {
    disposition: { skepticism: 2, literalism: 2, empathy: 5 },
    observations_mission:
      "Synthesise the person's wellbeing patterns, motivations, and emotional " +
      "context — how habits, setbacks, and encouragement connect over time.",
  },
  "executive-assistant": {
    disposition: { skepticism: 4, literalism: 4, empathy: 3 },
  },
  coding: {
    disposition: { skepticism: 4, literalism: 5, empathy: 2 },
  },
};

/**
 * Merge two dispositions per-key (override wins on each trait, inherits the
 * rest). Returns undefined when neither side sets anything.
 */
function mergeDisposition(
  base: BankDisposition | undefined,
  over: BankDisposition | undefined,
): BankDisposition | undefined {
  if (!base && !over) return undefined;
  const merged: BankDisposition = { ...(base ?? {}), ...(over ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolve the effective {@link BankMissionExtras} for an agent by layering
 * the resolved memory config over the built-in profile defaults
 * ({@link PROFILE_MEMORY_DEFAULTS}). Config wins; disposition merges per-key.
 *
 * Used by BOTH the scaffold and reconcile bank-update paths in
 * `src/agents/scaffold.ts`, so existing banks pick up profile/config changes
 * on `switchroom apply` — not only freshly scaffolded ones.
 */
export function resolveBankMissionExtras(
  memory:
    | { reflect_mission?: string; observations_mission?: string; disposition?: BankDisposition }
    | undefined,
  profileName: string,
): BankMissionExtras {
  const pd = PROFILE_MEMORY_DEFAULTS[profileName] ?? {};
  const out: BankMissionExtras = {};

  const reflect = memory?.reflect_mission ?? pd.reflect_mission;
  if (reflect != null) out.reflect_mission = reflect;

  const observations = memory?.observations_mission ?? pd.observations_mission;
  if (observations != null) out.observations_mission = observations;

  const disposition = mergeDisposition(pd.disposition, memory?.disposition);
  if (disposition) out.disposition = disposition;

  return out;
}

/**
 * Parse a Hindsight MCP response body.
 *
 * Hindsight's MCP server returns text/event-stream responses of the form:
 *
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * `await resp.json()` throws on that because it is not raw JSON. Strip the
 * SSE preamble and parse the JSON payload manually. Falls back to raw text
 * parsing if no `data:` line is present, so a server that responds with
 * plain JSON still works.
 */
async function parseSseOrJson<T>(resp: Response): Promise<T> {
  const text = await resp.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(payload) as T;
}

/**
 * Result of a Hindsight MCP probe.
 */
export type HindsightProbe =
  | { ok: true; serverName: string; serverVersion: string }
  | { ok: false; reason: string };

/**
 * Fetch the live tools/list from a Hindsight MCP endpoint — the advertised tool
 * surface (name + required args), used by `switchroom doctor`'s contract-drift
 * check (classifyToolContract). Best-effort with a short timeout; never throws.
 * Returns the tool list on success, or a reason on failure. X-Bank-Id uses a
 * throwaway probe id (tools/list is bank-independent).
 */
export async function fetchHindsightToolsList(
  apiUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; bankId?: string },
): Promise<{ ok: true; tools: Array<{ name: string; required: string[] }> } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 4000;
  const bankId = opts?.bankId ?? "__doctor_probe__";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const parsed = await parseSseOrJson<{
      result?: { tools?: Array<{ name?: string; inputSchema?: { required?: string[] } }> };
    }>(resp);
    const raw = parsed.result?.tools;
    if (!Array.isArray(raw)) return { ok: false, reason: "no tools in tools/list response" };
    const tools = raw
      .filter((t): t is { name: string; inputSchema?: { required?: string[] } } => typeof t?.name === "string")
      .map((t) => ({ name: t.name, required: t.inputSchema?.required ?? [] }));
    return { ok: true, tools };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}

/**
 * Probe a Hindsight MCP endpoint by issuing an `initialize` request and
 * reading the `serverInfo` it returns. Used by `switchroom doctor` to
 * confirm that the URL configured in `memory.config.url` is actually
 * serving Hindsight (vs. some other process happening to bind the same
 * port) and to surface the server version in the doctor output.
 *
 * Best-effort with a short timeout; never throws. Connection refused /
 * fetch failures normalize to `{ ok: false, reason: "Unreachable" }` so
 * callers can render an operator-specific message; protocol errors
 * (HTTP non-200, missing session id, malformed JSON) surface as
 * `{ ok: false, reason: "..." }` with a concrete reason.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param opts Optional fetch implementation and timeout
 */
export async function probeHindsight(
  apiUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<HindsightProbe> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 3000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom-doctor", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}` };
    }

    const data = await parseSseOrJson<{
      result?: { serverInfo?: { name?: string; version?: string } };
    }>(resp);

    const info = data.result?.serverInfo;
    if (!info?.name || !info?.version) {
      return { ok: false, reason: "Missing serverInfo in initialize response" };
    }

    return { ok: true, serverName: info.name, serverVersion: info.version };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    const msg = String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("ENOTFOUND")
    ) {
      return { ok: false, reason: "Unreachable" };
    }
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A single operator-declared mental model for a bank.
 *
 * These are the Phase-5 "curated per-specialist" models: named, opt-in,
 * operator-authored in `switchroom.yaml` (`memory.mental_models`). Unlike the
 * retired auto-seeded "user-profile" model (#2447), NOTHING is created unless
 * the operator explicitly declares it — so zero declarations means zero models,
 * exactly matching post-#2447 behaviour. This deliberately does NOT reintroduce
 * a fixed identity model: "who the user is" stays owned by the dedicated profile
 * banks (`users.*.profile_bank`), never a per-agent mental model.
 */
export interface MentalModelSpec {
  /** Stable model name (the identity key for idempotent ensure). */
  name: string;
  /** The reflection query the model answers, refreshed from bank content. */
  sourceQuery: string;
  /**
   * When true, Hindsight refreshes the model after each consolidation. Defaults
   * OFF (undefined) — refresh adds bounded background model-spend + timeout risk
   * (see RFC Phase 5), so it is opt-in per model.
   */
  refreshAfterConsolidation?: boolean;
  /** Optional cap on the synthesized model's token size. */
  maxTokens?: number;
}

/**
 * Ensure a single, operator-declared Mental Model exists for a bank.
 *
 * Idempotent: creates the model if no model with `spec.name` exists, otherwise
 * a no-op success. Matches existence by exact item NAME (a substring check
 * false-positives across sibling models — see the history in the list step).
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to create the MM in
 * @param spec   The declared model (name + source_query + optional knobs)
 * @param opts   Optional fetch implementation and timeout
 * @returns {ok: true} on success, {ok: false, reason} on error
 */
export async function ensureMentalModel(
  apiUrl: string,
  bankId: string,
  spec: MentalModelSpec,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  // Only send optional args when set — keeps the create payload minimal and
  // schema-clean (props verified against tests/fixtures/hindsight-tools-list).
  const createArguments: Record<string, unknown> = {
    name: spec.name,
    source_query: spec.sourceQuery,
  };
  if (spec.refreshAfterConsolidation !== undefined) {
    createArguments.trigger_refresh_after_consolidation =
      spec.refreshAfterConsolidation;
  }
  if (spec.maxTokens !== undefined) {
    createArguments.max_tokens = spec.maxTokens;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: Initialize MCP session
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    // Hindsight MCP is stateless by design and does not issue an
    // mcp-session-id; the MCP spec makes that header optional. Forward
    // it only when a stateful server actually returns one. Hard-failing
    // on its absence silently broke every scaffold memory-onboarding op
    // (bank create / mission / mental model) fleet-wide against the
    // stateless Hindsight server.
    const sessionId = initResponse.headers.get("mcp-session-id");
    const sessionHeader: Record<string, string> = sessionId
      ? { "mcp-session-id": sessionId }
      : {};

    // Step 2: Check if MM already exists
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const listResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        ...sessionHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "list_mental_models",
          arguments: {},
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (listResponse.ok) {
      try {
        const listData = await parseSseOrJson<{
          result?: { content?: Array<{ text?: string }> };
        }>(listResponse);
        // The list payload is a JSON STRING of {items:[{name,...}]}. The old
        // existence check did a naive substring `models.includes("user-profile")`
        // on that whole blob — which FALSE-POSITIVED whenever ANOTHER mental
        // model's name / source_query / content merely contained the substring
        // "user-profile" (e.g. lawgpt's Lisa-focused models, or a sibling
        // "User Profile" model). That made `ensureUserProfileMentalModel` skip
        // creation and report "ready" while the bank had NO user-profile model.
        // Match by exact item NAME instead.
        const models = listData.result?.content?.[0]?.text;
        if (models && typeof models === "string") {
          const parsed = JSON.parse(models) as { items?: Array<{ name?: string }> };
          const items = Array.isArray(parsed?.items) ? parsed.items : [];
          if (items.some((m) => m?.name === spec.name)) {
            return { ok: true }; // Already exists (by exact name)
          }
        }
      } catch {
        // Parse failed (not SSE / not the expected JSON shape). Fall through to
        // the create attempt; if the MM already exists, create returns an
        // idempotent error we swallow below.
      }
    }

    // Step 3: Create the MM
    const timeout3 = setTimeout(() => controller.abort(), timeoutMs);
    const createResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        ...sessionHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_mental_model",
          // The server's create_mental_model argument is `source_query`, not
          // `query` (an upstream rename). Passing `query` returns HTTP 200 with
          // isError:true "Missing required argument: source_query" — and if a
          // caller only checked `createResponse.ok` (HTTP status), it would
          // report {ok:true} while creating NOTHING (the isError check below
          // guards that). Optional knobs (trigger_refresh_after_consolidation,
          // max_tokens) are added by the caller in `createArguments` only when
          // set. Do NOT add `types` — it is not in create_mental_model's schema
          // (props on 0.8.5: name, source_query, mental_model_id, tags,
          // tags_match, max_tokens, trigger_refresh_after_consolidation,
          // bank_id); the server silently drops it and it reds
          // memory.hindsight-contract.fixture.
          //
          // `tags_match` (new in 0.8.5) only matters for a TAGGED model, and
          // switchroom never passes `tags` here — declared models in
          // `memory.mental_models[]` have no tags field. If that ever changes,
          // note the upstream default: a tagged model with no explicit
          // tags_match resolves to `all_strict`, i.e. a memory must carry EVERY
          // one of the model's tags to be included. Pass "any" unless you mean
          // that.
          arguments: createArguments,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout3);

    if (!createResponse.ok) {
      return { ok: false, reason: `Create MM HTTP ${createResponse.status}` };
    }

    // Check the MCP result envelope — a tools/call can return HTTP 200 with
    // isError:true (e.g. a missing/renamed argument). Don't report success on
    // an error, or the next `ensureUserProfileMentalModel` keeps "creating" a
    // model that never lands.
    try {
      const created = await parseSseOrJson<{
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }>(createResponse);
      if (created.result?.isError === true) {
        const msg = created.result.content?.[0]?.text ?? "create returned isError";
        return { ok: false, reason: msg };
      }
    } catch {
      // Unparseable body — treat HTTP 200 as success (legacy) rather than fail
      // a working create on a parse hiccup.
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    return { ok: false, reason: String(err) };
  }
}

/**
 * The source_query for the (retired-from-auto-wiring) user-profile model.
 * Kept as a named constant so the dormant dashboard "Build profile" path and
 * its tests share one definition. NOT auto-created by scaffold/reconcile any
 * more (#2447) — dedicated profile banks own user identity.
 */
export const USER_PROFILE_SOURCE_QUERY =
  "What are the key facts, preferences, context, and communication style about the user I talk to? Summarize what matters for making the agent feel like it knows them.";

/**
 * Ensure the user-profile Mental Model exists for a bank.
 *
 * DORMANT auto-wiring: scaffold/reconcile no longer call this (#2447 retired
 * per-agent user-profile models in favour of dedicated profile banks). Kept for
 * the operator-triggered dashboard "Build profile" path. Thin wrapper over the
 * generalized {@link ensureMentalModel}.
 */
export async function ensureUserProfileMentalModel(
  apiUrl: string,
  bankId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return ensureMentalModel(
    apiUrl,
    bankId,
    { name: "user-profile", sourceQuery: USER_PROFILE_SOURCE_QUERY },
    opts
  );
}

/**
 * The raw shape of a `memory.mental_models[]` entry as it lands from
 * switchroom.yaml (snake_case, post-cascade). Mapped to {@link MentalModelSpec}
 * by {@link ensureDeclaredMentalModels}.
 */
export interface DeclaredMentalModelConfig {
  name: string;
  source_query: string;
  refresh_after_consolidation?: boolean;
  max_tokens?: number;
}

/**
 * The result of ensuring one declared model, for legible scaffold/reconcile
 * logging.
 */
export interface EnsureMentalModelOutcome {
  name: string;
  ok: boolean;
  reason?: string;
}

/**
 * Ensure every operator-DECLARED mental model exists for a bank (Phase 5).
 *
 * This is the invariant-clean replacement for the retired auto-seeding (#2447):
 * it creates ONLY the models the operator named in `memory.mental_models`, so
 * an agent with no declarations gets no models (identical to post-#2447
 * behaviour). No fixed "user-profile" identity model is implied — that domain
 * stays with the dedicated profile banks. Each model is ensured idempotently
 * (create-if-absent by exact name); best-effort and never throws, so a slow or
 * down Hindsight never blocks scaffold/reconcile.
 *
 * @param apiUrl  Hindsight MCP endpoint
 * @param bankId  The agent's bank id
 * @param models  The declared models (may be undefined / empty → no-op)
 * @param opts    Optional fetch impl + per-model timeout
 * @returns per-model outcomes (empty array when nothing was declared)
 */
export async function ensureDeclaredMentalModels(
  apiUrl: string,
  bankId: string,
  models: DeclaredMentalModelConfig[] | undefined,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<EnsureMentalModelOutcome[]> {
  if (!models || models.length === 0) return [];

  const outcomes: EnsureMentalModelOutcome[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    // Defensive de-dupe (schema also rejects dupes) so one bad config can't
    // double-create; first declaration wins.
    if (seen.has(m.name)) continue;
    seen.add(m.name);

    const spec: MentalModelSpec = {
      name: m.name,
      sourceQuery: m.source_query,
      refreshAfterConsolidation: m.refresh_after_consolidation,
      maxTokens: m.max_tokens,
    };
    try {
      const result = await ensureMentalModel(apiUrl, bankId, spec, opts);
      outcomes.push(
        result.ok
          ? { name: m.name, ok: true }
          : { name: m.name, ok: false, reason: result.reason }
      );
    } catch (err) {
      outcomes.push({ name: m.name, ok: false, reason: String(err) });
    }
  }
  return outcomes;
}

/**
 * Idempotently create a Hindsight bank via MCP.
 *
 * Calls Hindsight's create_bank tool. Hindsight's create_bank is documented
 * as "Create a new memory bank or get an existing one" — so calling this on
 * an already-existing bank is a no-op and returns success. Best-effort with
 * timeout; never throws.
 *
 * Used by `switchroom agent create` to make sure an agent's bank exists
 * BEFORE its first `retain` call — without this, the first retain against a
 * missing bank blows up with a raw foreign-key constraint violation because
 * Hindsight's `get_bank_stats` silently returns empty on a missing bank.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to create (typically the agent name)
 * @param opts Optional fetch implementation, timeout, and optional name/mission
 * @returns {ok: true} on success, {ok: false, reason} on error. reason will be
 *   "Unreachable" when the Hindsight daemon is not running (connection refused
 *   / network error) so callers can render a specific operator-facing message.
 */
export async function createBank(
  apiUrl: string,
  bankId: string,
  opts?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    name?: string;
    mission?: string;
  }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: Initialize MCP session
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    // Hindsight MCP is stateless by design and does not issue an
    // mcp-session-id; the MCP spec makes that header optional. Forward
    // it only when a stateful server actually returns one. Hard-failing
    // on its absence silently broke every scaffold memory-onboarding op
    // (bank create / mission / mental model) fleet-wide against the
    // stateless Hindsight server.
    const sessionId = initResponse.headers.get("mcp-session-id");
    const sessionHeader: Record<string, string> = sessionId
      ? { "mcp-session-id": sessionId }
      : {};

    // Step 2: Call create_bank tool
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const args: Record<string, unknown> = { bank_id: bankId };
    if (opts?.name) args.name = opts.name;
    if (opts?.mission) args.mission = opts.mission;

    const toolResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        ...sessionHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_bank",
          arguments: args,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (!toolResponse.ok) {
      return { ok: false, reason: `Tool call HTTP ${toolResponse.status}` };
    }

    // Check the MCP result envelope — a tools/call returns HTTP 200 with
    // isError:true on a renamed/unknown arg (the source_query class). Without
    // this, a future bank_id rename would report success while creating no bank.
    try {
      const created = await parseSseOrJson<{
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }>(toolResponse);
      if (created.result?.isError === true) {
        return { ok: false, reason: created.result.content?.[0]?.text ?? "create_bank returned isError" };
      }
    } catch {
      // Unparseable body — treat HTTP 200 as success (legacy) rather than fail a
      // working create on a parse hiccup.
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    // ECONNREFUSED / fetch failed → daemon not running. Normalize to
    // "Unreachable" so the CLI can surface a specific operator message.
    // Also catch the undici connect-layer failure ("Unable to connect. Is
    // the computer able to access the url?" / UND_ERR_CONNECT), which none
    // of the substrings above match — it was falling through to the scary
    // "⚠ Failed to create Hindsight bank" branch on every restart instead
    // of the calm "unreachable — agent still usable" path.
    const msg = String(err);
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("Failed to fetch") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("Unable to connect") ||
      msg.includes("UND_ERR_CONNECT") ||
      causeCode === "UND_ERR_CONNECT" ||
      causeCode === "ECONNREFUSED" ||
      causeCode === "ENOTFOUND"
    ) {
      return { ok: false, reason: "Unreachable" };
    }
    return { ok: false, reason: msg };
  }
}

/**
 * Update bank mission statements via MCP.
 *
 * Calls Hindsight's update_bank tool to set bank_mission and/or retain_mission.
 * Best-effort with timeout; never throws.
 *
 * @param apiUrl Hindsight MCP endpoint (e.g. "http://127.0.0.1:18888/mcp/")
 * @param bankId The bank ID to update
 * @param missions Object with optional bank_mission and/or retain_mission
 * @param opts Optional fetch implementation and timeout
 * @returns {ok: true} on success, {ok: false, reason} on error
 */
export async function updateBankMissions(
  apiUrl: string,
  bankId: string,
  missions: {
    bank_mission?: string;
    retain_mission?: string;
    reflect_mission?: string;
    observations_mission?: string;
    disposition?: BankDisposition;
  },
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: Initialize MCP session
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    // Hindsight MCP is stateless by design and does not issue an
    // mcp-session-id; the MCP spec makes that header optional. Forward
    // it only when a stateful server actually returns one. Hard-failing
    // on its absence silently broke every scaffold memory-onboarding op
    // (bank create / mission / mental model) fleet-wide against the
    // stateless Hindsight server.
    const sessionId = initResponse.headers.get("mcp-session-id");
    const sessionHeader: Record<string, string> = sessionId
      ? { "mcp-session-id": sessionId }
      : {};

    // Step 2: Call update_bank tool
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const toolResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        ...sessionHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_bank",
          // `update_bank` accepts top-level `mission` (the bank mission) but
          // NOT a top-level `retain_mission` — that is a CONFIG field and must
          // go through `config_updates` (verified live: the server SILENTLY
          // DROPPED a top-level retain_mission, so the retain-steering half of
          // every mission update was a live no-op). Every other steering field
          // is a config field too and routes the same way.
          //
          // The engine stores the top-level `mission` as `config.reflect_mission`
          // (verified live: switchroom's bank_mission lands there). So
          // `reflect_mission` and `bank_mission` target the SAME field — when
          // the explicit `reflect_mission` is set we route it through
          // config_updates and drop the top-level `mission` so the two can't
          // race; a bare `bank_mission` keeps the legacy top-level route.
          arguments: {
            bank_id: bankId,
            ...(missions.reflect_mission == null && missions.bank_mission != null
              ? { mission: missions.bank_mission }
              : {}),
            ...(() => {
              const configUpdates: Record<string, unknown> = {};
              if (missions.retain_mission != null)
                configUpdates.retain_mission = missions.retain_mission;
              if (missions.reflect_mission != null)
                configUpdates.reflect_mission = missions.reflect_mission;
              if (missions.observations_mission != null)
                configUpdates.observations_mission = missions.observations_mission;
              const d = missions.disposition;
              if (d?.skepticism != null) configUpdates.disposition_skepticism = d.skepticism;
              if (d?.literalism != null) configUpdates.disposition_literalism = d.literalism;
              if (d?.empathy != null) configUpdates.disposition_empathy = d.empathy;
              return Object.keys(configUpdates).length > 0 ? { config_updates: configUpdates } : {};
            })(),
          },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (!toolResponse.ok) {
      return { ok: false, reason: `Tool call HTTP ${toolResponse.status}` };
    }

    // Check the MCP result envelope — HTTP 200 + isError:true on a renamed/
    // unknown arg. Without this, a future arg rename would report success while
    // updating nothing.
    try {
      const updated = await parseSseOrJson<{
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }>(toolResponse);
      if (updated.result?.isError === true) {
        return { ok: false, reason: updated.result.content?.[0]?.text ?? "update_bank returned isError" };
      }
    } catch {
      // Unparseable body — treat HTTP 200 as success (legacy).
    }

    return { ok: true };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    return { ok: false, reason: String(err) };
  }
}

/**
 * Pure: decide whether an `update_memory` MCP response actually applied `tag`.
 *
 * WHY THIS IS A READ-BACK AND NOT AN `isError` CHECK (2026-07-27, verified
 * live against hindsight 0.8.4 and by AST-diffing the 0.8.4/0.8.5 wheels):
 *
 * `isError` fires only for an unknown TOOL. `update_memory` is a real,
 * unconditionally-registered tool, so an unknown ARGUMENT — `add_tags` — is
 * **silently dropped** by the server and the call returns `isError:false` with
 * a response byte-identical to the same call without the argument. An
 * `isError` guard therefore can never fire here, and any claim that demote
 * "fails loudly" on the back of one is false.
 *
 * Application errors are equally invisible to `isError`: a missing memory
 * comes back as `isError:false` with the body `{"error": "Memory '…' not
 * found"}` (probed live). Both classes have to be read out of the body.
 *
 * What makes detection possible at all is that `update_memory` returns the
 * **updated memory unit** — `hindsight_api/mcp_tools.py` `_register_update_memory`
 * returns `memory.update_memory_unit(...)`, which tail-calls `get_memory_unit`
 * and always emits a `tags` key (`engine/memory_engine.py`, `"tags": row["tags"]
 * if row["tags"] else []`). So the response IS the read-back: if the tag is not
 * in it, the write did not happen. No second round-trip, no extra callsite.
 *
 * This also self-heals: the day upstream grows a per-memory tag-write argument,
 * the returned unit carries the tag and this returns ok without any code change.
 *
 * Every non-confirming shape is a failure. "Could not verify" is a failure, not
 * a pass — reporting success on an unread body is the exact bug this replaces.
 */
export function verifyTagWriteResponse(
  result: { isError?: boolean; content?: Array<{ text?: string }> } | undefined,
  tag: string,
): { ok: true } | { ok: false; reason: string } {
  const cannotApply =
    "hindsight has no per-memory tag-write path: `update_memory` accepts only " +
    "text / context / occurred_start / occurred_end / fact_type / entities, and " +
    "an unknown argument like `add_tags` is silently dropped (isError stays false)";

  if (!result) {
    return { ok: false, reason: "no MCP result envelope in the update_memory response" };
  }
  if (result.isError === true) {
    return { ok: false, reason: result.content?.[0]?.text ?? "update_memory returned isError" };
  }

  const text = result.content?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) {
    return {
      ok: false,
      reason: `update_memory returned no body, so the tag write could not be confirmed — ${cannotApply}`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: `update_memory returned an unparseable body (${text.slice(0, 120)}), so the tag write could not be confirmed`,
    };
  }

  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      reason: `update_memory returned a non-object body (${text.slice(0, 120)}), so the tag write could not be confirmed`,
    };
  }

  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") {
    // Application errors arrive with isError:false — e.g. a bad memory id.
    return { ok: false, reason: record.error };
  }

  const tags = record.tags;
  if (!Array.isArray(tags)) {
    return {
      ok: false,
      reason: `update_memory returned no \`tags\` field, so the tag write could not be confirmed — ${cannotApply}`,
    };
  }
  if (!tags.includes(tag)) {
    return {
      ok: false,
      reason:
        `the server accepted the call but the memory came back WITHOUT \`${tag}\` ` +
        `(tags: ${tags.length === 0 ? "none" : tags.map(String).join(", ")}) — ${cannotApply}`,
    };
  }
  return { ok: true };
}

/**
 * Append a tag to an existing memory in a Hindsight bank.
 *
 * Wraps the Hindsight MCP `update_memory` tool. Used by
 * `switchroom memory demote` (#475 follow-up) to add the
 * `[demote-from-recall]` tag to noisy memories that the operator
 * spots in the recall-log. Once tagged, recall.py's
 * `_is_demoted_memory` filter (#432 4.4) excludes the memory from
 * subsequent auto-recall blocks while keeping it queryable via
 * `mcp__hindsight__recall` and `reflect`.
 *
 * Success is decided by {@link verifyTagWriteResponse} reading the tag back out
 * of the returned memory unit — NOT by HTTP status and NOT by `isError`, both
 * of which are structurally blind to the failure that actually occurs here.
 *
 * Best-effort with timeout; never throws. Mirrors `updateBankMissions`
 * shape so the caller pattern stays consistent across switchroom's
 * Hindsight-touching helpers.
 */
export async function addMemoryTag(
  apiUrl: string,
  bankId: string,
  memoryId: string,
  tag: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Step 1: initialize MCP session (required for any subsequent tools/call).
    const initResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!initResponse.ok) {
      return { ok: false, reason: `HTTP ${initResponse.status}` };
    }

    // Hindsight MCP is stateless by design and does not issue an
    // mcp-session-id; the MCP spec makes that header optional. Forward
    // it only when a stateful server actually returns one. Hard-failing
    // on its absence silently broke every scaffold memory-onboarding op
    // (bank create / mission / mental model) fleet-wide against the
    // stateless Hindsight server.
    const sessionId = initResponse.headers.get("mcp-session-id");
    const sessionHeader: Record<string, string> = sessionId
      ? { "mcp-session-id": sessionId }
      : {};

    // Step 2: call update_memory with `add_tags` to append the tag.
    //
    // HONEST-FAILURE note, CORRECTED 2026-07-27 against hindsight 0.8.4 (live)
    // and the 0.8.4/0.8.5 wheels (AST diff):
    //
    // The 2026-06-07 audit recorded `update_memory` as a phantom tool. That was
    // wrong — it is a real, unconditionally-registered MCP tool (and has been
    // since at least 0.8.4; the audit's snapshot was just stale). What is
    // actually missing is the ARG: `update_memory` accepts only
    // text / context / occurred_start / occurred_end / fact_type / entities
    // (plus bank_id / memory_id). There is no `add_tags` and no `tags`, and the
    // per-memory REST route `PATCH /v1/default/banks/{bank}/memories/{id}` takes
    // the same field set — so there is no PER-MEMORY tag-write path on either
    // wheel. (`PATCH .../documents/{document_id}` does rewrite the tags of a
    // document's memory units, but it is document-scoped, REPLACES rather than
    // appends, requires a non-null document_id, and triggers re-consolidation —
    // unusable for demoting one memory. Tracked on #3772.) Tags can otherwise
    // only be attached at retain time.
    //
    // Because the tool is real, the server does NOT reject the unknown argument:
    // it silently drops it and answers isError:false with a body byte-identical
    // to the same call without it (probed live). An isError check therefore
    // cannot detect this, and neither can the HTTP status the pre-#3762 code
    // used. Detection comes from verifyTagWriteResponse() reading the tag back
    // out of the memory unit update_memory returns. That also makes the callsite
    // forward-compatible: the day upstream grows a tag-write arg the read-back
    // simply confirms and this starts succeeding, and the `knownUnsupportedArgs`
    // entry in src/memory/hindsight-tools.ts reds the fixture test to say so.
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const toolResponse = await fetchImpl(`${apiUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        ...sessionHeader,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "update_memory",
          arguments: {
            bank_id: bankId,
            memory_id: memoryId,
            add_tags: [tag],
          },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout2);

    if (!toolResponse.ok) {
      return { ok: false, reason: `Tool call HTTP ${toolResponse.status}` };
    }

    // Read the tag back out of the returned memory unit. HTTP 200 means
    // nothing here and neither does isError (see verifyTagWriteResponse) —
    // the ONLY evidence that the write landed is the tag being present in the
    // response body. An unreadable body is a failure, not a pass: the legacy
    // "treat HTTP-200 as success" fallback is precisely how `memory demote`
    // printed "✓ Tag applied." while tagging nothing.
    let parsed: {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    try {
      parsed = await parseSseOrJson<{
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      }>(toolResponse);
    } catch (err) {
      return {
        ok: false,
        reason: `could not read the update_memory response (${String(err)}), so the tag write is unconfirmed`,
      };
    }

    return verifyTagWriteResponse(parsed.result, tag);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "Timeout" };
    }
    return { ok: false, reason: String(err) };
  }
}

/** Canonical demote tag honoured by `_is_demoted_memory` in
 *  `vendor/hindsight-memory/scripts/recall.py` (#432 phase 4.4).
 *  Exported so CLI commands and tests stay in lockstep with the
 *  Python-side filter without hard-coding the literal in two places. */
export const DEMOTE_FROM_RECALL_TAG = "[demote-from-recall]";
