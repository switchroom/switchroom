import { z } from "zod";
import {
  OBSERVATION_SCOPES,
  OBSERVATION_SCOPE_STRATEGIES,
} from "../memory/observation-scopes.js";

/**
 * A single entry in an agent's code_repos list.
 * Declares a git repo the agent is allowed to claim worktrees from,
 * with an optional short alias and per-repo concurrency cap.
 */
export const CodeRepoEntrySchema = z.object({
  name: z.string().describe("Short alias used when claiming (e.g. 'switchroom')"),
  source: z
    .string()
    .describe("Absolute or home-relative path to the repo (e.g. ~/code/switchroom)"),
  concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max simultaneous worktrees for this repo (default 5)"),
});

/**
 * A single entry in an agent's bind_mounts list (#1164).
 *
 * Adds a host path to the agent container's bind-mount set, on top of the
 * standard dual-mount baseline (agent state dir, .claude project dir, logs,
 * read-only skills + credentials). Intended use case: dogfooding /
 * self-modification — an admin agent that needs to read or edit the
 * switchroom source tree at `~/code/switchroom`, or another repo not
 * covered by the default mount policy.
 *
 * Admin-gated: the compose generator refuses to emit bind_mounts for an
 * agent without `admin: true`. The denylist (`/`, `/etc`, `/proc`, `/sys`,
 * `/dev`, `/run`, `/var/run`, `/boot`, `/var/lib/docker`, and the docker
 * socket) is enforced in `src/agents/compose.ts`.
 */
export const AgentBindMountSchema = z.object({
  source: z
    .string()
    .describe(
      "Absolute host path to bind-mount into the container. Tilde-expansion " +
      "is not performed — use the literal absolute path (e.g. " +
      "'/home/me/code/switchroom'). The compose generator refuses sources " +
      "under system paths (/, /etc, /proc, /sys, /dev, /run, /var/run, " +
      "/boot, /var/lib/docker) and the docker socket.",
    ),
  target: z
    .string()
    .optional()
    .describe(
      "Container path the source mounts to. Must be absolute. Defaults to " +
      "the same path as `source` (matches switchroom's existing dual-mount " +
      "convention so absolute paths in scaffolded scripts Just Work).",
    ),
  mode: z
    .enum(["ro", "rw"])
    .optional()
    .describe(
      "Read-only (default) or read-write. Use `rw` only when the agent " +
      "must mutate the host path (e.g. editing switchroom source). " +
      "Default: 'ro'.",
    ),
});

// Tier-0 deterministic poll specs (reference/rfcs/cheap-cron-sessions.md §2.1).
// A `kind: poll` entry runs model-free in the scheduler process; only a
// *hit* escalates to a model fire (Tier 1/2) using the entry's prompt +
// model/context. Two declarative, operator-approved poll types — never an
// agent-authored script (the declaration itself is the capability; see
// §6 SSRF/egress hardening). Discriminated on `type`.
export const HttpDiffPollSchema = z.object({
  type: z.literal("http-diff"),
  url: z
    .string()
    .url()
    .describe(
      "Poll target. Host MUST match the operator egress allowlist (§6.1) — " +
      "loopback/private/link-local/non-https are rejected; the IP is " +
      "resolve-then-pinned against DNS-rebind. Not agent-writable without " +
      "operator commit.",
    ),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string()).optional(),
  secrets: z
    .array(z.string().regex(/^[a-zA-Z0-9_\-/]+$/, "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes"))
    .default([])
    .describe(
      "Vault keys this poll may inject into request headers. Each is " +
      "HOST-PINNED (§6.1): a secret may only be sent to the host it is bound " +
      "to in operator config, so an approved poll cannot exfil it elsewhere.",
    ),
  diff_jsonpath: z.string().describe("JSONPath into the response; the extracted value is compared to state_key."),
  state_key: z.string().describe("Key under /state/agent/poll-state.json holding the last-seen value."),
});

// NOTE: a `telegram-reactions` poll type was prototyped here but removed
// (#2307 follow-up) — it was never wired (it errored "not yet wired" at
// runtime) and is redundant with `reaction_dispatch` (#2291), which is
// event-driven (Telegram pushes the reaction → instant wake) rather than
// polled, and is the path the Linear-capture default uses. The poll's only
// niche — a non-admin bot in a group that can't receive reaction pushes — is
// not a topology switchroom targets (its bots are admins in their own chats).
// `PollSpecSchema` stays a single-arm discriminated union on `type` so a future
// poll type can be added back without changing the shape.
export const PollSpecSchema = z.discriminatedUnion("type", [
  HttpDiffPollSchema,
]);

// Tier-0 deterministic ACTION specs (reference/rfcs/cheap-cron-sessions.md §2.1,
// reference/jobs/crons-use-the-model-only-when-it-earns-it.md). A `kind: action`
// entry runs model-free in the scheduler process and COMPLETES the work — it
// never escalates to a model (the terminal sibling of `kind: poll`, which
// escalates on a hit). Zero tokens, no second `claude`, no session wake.
// Only mechanical verbs whose output is FULLY determined by config +
// deterministic substitution belong here; anything needing NL synthesis
// (a Linear issue body, a summary) must stay `kind: poll`/`prompt` and use a
// model. Discriminated on `type`.
export const TelegramMessageActionSchema = z.object({
  type: z.literal("telegram-message"),
  text: z
    .string()
    .min(1)
    .describe(
      "Operator-authored message text. Posts to the AGENT'S OWN chat only " +
      "(the chat is not configurable — fenced by construction), into the " +
      "entry-level `topic` when set. Supports ONLY deterministic placeholders " +
      "{{date}} / {{time}} (UTC, from the fire clock) and {{agent}}. NO vault " +
      "secrets (use a webhook action for secret-bearing requests) and NO model " +
      "output — the text is fully determined by config.",
    ),
  parse_mode: z.enum(["html", "text"]).default("html").describe("Telegram parse mode for the message body."),
});

export const WebhookActionSchema = z.object({
  type: z.literal("webhook"),
  url: z
    .string()
    .url()
    .describe(
      "Webhook target. SAME egress fence as an http-diff poll (§6.1): https " +
      "only, host on the operator egress allowlist, loopback/private/link-local " +
      "rejected, resolved IP DNS-rebind-pinned. Not agent-writable without an " +
      "operator commit.",
    ),
  method: z.enum(["GET", "POST"]).default("POST"),
  headers: z.record(z.string()).optional().describe("Static headers; {{secret}} substitution applies."),
  body: z.string().optional().describe("Static request body; {{secret}} substitution applies."),
  secrets: z
    .array(z.string().regex(/^[a-zA-Z0-9_\-/]+$/, "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes"))
    .default([])
    .describe(
      "Vault keys this webhook may inject into headers/body via {{name}}. Each " +
      "is HOST-PINNED (§6.1): a secret may only be sent to the host it is bound " +
      "to in operator config, so an approved action cannot exfil it elsewhere.",
    ),
});

export const ActionSpecSchema = z.discriminatedUnion("type", [
  TelegramMessageActionSchema,
  WebhookActionSchema,
]);

export const ScheduleEntrySchema = z
  .object({
  cron: z.string().describe("Cron expression (e.g., '0 8 * * *')"),
  prompt: z
    .string()
    .optional()
    .describe(
      "Prompt to send at the scheduled time (the escalation prompt when " +
      "kind=poll; templated with {{diff}}). Required for kind prompt/poll; " +
      "absent for kind=action (an action has no model fire, so no prompt).",
    ),
  kind: z
    .enum(["poll", "prompt", "action"])
    .optional()
    .describe(
      "Tier-0 routing (reference/rfcs/cheap-cron-sessions.md). 'prompt' (default) " +
      "fires a model turn every tick (Tier 1/2 per `context`). 'poll' runs a " +
      "model-free deterministic check (requires `poll`) and only escalates to " +
      "a model fire on a hit. 'action' runs a model-free deterministic verb " +
      "(requires `action`) that COMPLETES the work and never escalates — zero " +
      "tokens, no session. poll/prompt tiering is on by default " +
      "(SWITCHROOM_CHEAP_CRON=0 is the kill-switch); an action is model-free " +
      "regardless (the kill-switch governs model tiering, not deterministic " +
      "actions).",
    ),
  poll: PollSpecSchema.optional().describe("Required iff kind=poll. The declarative poll spec."),
  action: ActionSpecSchema.optional().describe("Required iff kind=action. The declarative action spec (telegram-message or webhook)."),
  model: z
    .string()
    .optional()
    .describe(
      "Cron model hint. Reactivated by SWITCHROOM_CHEAP_CRON (was DEPRECATED/" +
      "IGNORED in v0.8). A known-cheap id (sonnet/haiku family) routes the " +
      "fire to a fresh cheap cron session (Tier 1, `context: fresh`); 'opus', " +
      "a custom id, or unset routes to the agent's live session (Tier 2, " +
      "`context: agent`) — the conservative default that preserves pre-v0.8 " +
      "behaviour. Note: a live session's model is fixed at launch, so on Tier " +
      "2 this is informational. See docs/scheduling.md.",
    ),
  context: z
    .enum(["fresh", "agent"])
    .optional()
    .describe(
      "Does this cron need the agent, or just a model? 'fresh' → a minimal-" +
      "context cheap cron session (Tier 1). 'agent' → the agent's live " +
      "session with full persona/memory (Tier 2). Unset → inferred from " +
      "`model` (cheap→fresh, else agent). On by default; " +
      "SWITCHROOM_CHEAP_CRON=0 is the kill-switch.",
    ),
  secrets: z
    .array(z.string().regex(/^[a-zA-Z0-9_\-/]+$/, "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes"))
    .default([])
    .describe(
      "Vault key names this cron task may read via the vault-broker daemon. " +
      "Empty by default — broker requests for unlisted keys are denied. " +
      "Note: this is misconfiguration protection (a typo in cron-A doesn't " +
      "accidentally read cron-B's keys) rather than a security boundary — " +
      "anyone who can edit cron scripts can also edit switchroom.yaml, and " +
      "anyone with the vault passphrase can read the vault file directly. " +
      "See docs/configuration.md for the full framing.",
    ),
  topic: z
    .union([
      z.string().min(1, "topic alias must be non-empty"),
      z.number().int().positive("topic ID must be a positive integer"),
    ])
    .optional()
    .describe(
      "Forum topic this cron fires into when the owning agent is in " +
      "supergroup-owned mode (channels.telegram.chat_id set). Either a " +
      "string alias resolved against `topic_aliases` (e.g. \"planning\") " +
      "or a numeric topic ID. Falls back to the agent's `default_topic_id` " +
      "when unset. Ignored for agents in fleet-shared or dm_only mode. " +
      "Alias-resolution happens at config-load — typos surface immediately. " +
      "See reference/rfcs/supergroup-mode.md.",
    ),
  })
  .superRefine((entry, ctx) => {
    const kind = entry.kind ?? "prompt";
    if (kind === "poll" && !entry.poll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["poll"],
        message: "kind: poll requires a `poll` spec (http-diff).",
      });
    }
    if (kind !== "poll" && entry.poll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["poll"],
        message: "`poll` is only valid when kind: poll.",
      });
    }
    if (kind === "action" && !entry.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "kind: action requires an `action` spec (telegram-message or webhook).",
      });
    }
    if (kind !== "action" && entry.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "`action` is only valid when kind: action.",
      });
    }
    // prompt is the model fire's text — required for prompt/poll, absent for action.
    if (kind !== "action" && (entry.prompt === undefined || entry.prompt.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: `kind: ${kind} requires a non-empty \`prompt\`.`,
      });
    }
    if (kind === "action" && entry.prompt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "`prompt` is not valid for kind: action (an action never fires a model).",
      });
    }
  });

export const AgentSoulSchema = z
  .object({
    name: z.string().describe("Agent persona name (e.g., 'Coach', 'Sage')"),
    style: z.string().describe("Communication style description"),
    creature: z
      .string()
      .optional()
      .describe("Persona creature/form (e.g., 'owl', 'octopus')"),
    vibe: z
      .string()
      .optional()
      .describe("One-line personality vibe (e.g., 'calm, precise')"),
    expertise: z
      .string()
      .optional()
      .describe("Domain expertise summary rendered into the persona"),
    emoji: z
      .string()
      .optional()
      .describe("Signature emoji for the persona (e.g., '🦉')"),
    boundaries: z
      .string()
      .optional()
      .describe("Behavioral boundaries and disclaimers"),
    shape: z
      .enum(["executive-assistant", "developer", "coach", "generalist"])
      .default("generalist")
      .describe(
        "Persona-shape discriminator the per-agent CLAUDE.md template can " +
        "branch on (e.g., 'you are an executive assistant' vs 'a senior " +
        "engineer'). No runtime behavior yet — template work lands in a " +
        "later issue. Cascade: override (per-agent wins over default)."
      ),
  })
  .optional();

export const AgentToolsSchema = z
  .object({
    allow: z
      .array(z.string())
      .default([])
      .describe("Allowed tools (use ['all'] for unrestricted)"),
    deny: z
      .array(z.string())
      .default([])
      .describe("Denied tools (overrides allow)"),
  })
  .optional();

/**
 * `memory.observation_scopes` — an operator PIN for the per-row
 * `observation_scopes` switchroom stamps on every retained Hindsight MemoryItem.
 *
 * This is an override, not the default path. Since #4035 the default is the
 * plugin's `curated` strategy (`observationScopeStrategy`), which computes a
 * scope per retain; a pin here wins over that strategy outright. `combined` is
 * the pin form of opting out (restores the pre-feature engine default). See
 * `docs/configuration.md` § "Observation scopes".
 *
 * Declared once and reused by BOTH `AgentMemorySchema` and the
 * defaults/profile-tier mirror, so the two tiers cannot drift into accepting
 * different sets.
 *
 * An ENUM, not a free string: the value is invisible after the write. A typo
 * (`shred`) would apply clean, go on the wire, and leave the engine falling
 * back to its own default scope — surfacing months later as a bank whose
 * observations never merged. `switchroom apply` is the cheap place to catch
 * that; the plugin re-validates in `lib/config.resolve_observation_scopes` for
 * a hand-edited settings.json or raw env var, which this schema cannot reach.
 */
const ObservationScopesSchema = z
  .enum(OBSERVATION_SCOPES)
  .optional()
  .describe(
    "Operator PIN for the per-row observation scope, overriding the " +
    "default `curated` strategy (see docs/configuration.md). \"shared\" " +
    "forces Hindsight's consolidation to write EVERY observation into ONE " +
    "global untagged scope — what several agents pooling one bank want so " +
    "their observations merge rather than sitting in parallel silos. " +
    "\"combined\" is the pin form of opting out (restores the pre-#4035 " +
    "engine default). UNSET does NOT mean 'nothing on the wire': the " +
    "`curated` strategy still computes a scope per retain. Applies to " +
    "every retain path (Stop hook, " +
    "sidechain, boot reconcile, queue drain, backfill, session-handoff " +
    "mirror) and is carried on the queued payload, so a retain that fails " +
    "now and drains later still lands in this scope. Accepted values: " +
    `${OBSERVATION_SCOPES.join(", ")}. ` +
    "Cascade: override (per-agent wins over default)."
  );

/**
 * `memory.observation_scope_strategy` — the per-retain SELECTOR that decides
 * how switchroom computes each row's `observation_scopes` when no pin is set.
 * This is the first-class surface for the plugin's `observationScopeStrategy`
 * knob (shipped on-by-default in #4035): `curated` (default) strips volatile
 * per-session provenance tags so cross-session dedup happens; `shared` forces
 * the one global untagged scope; `combined` / `off` opt out entirely,
 * restoring the pre-feature engine default. A manual `observation_scopes` pin
 * still wins over the strategy outright.
 *
 * Declared once and reused by BOTH `AgentMemorySchema` and the
 * defaults/profile-tier mirror, so the two tiers cannot drift. Same enum
 * rationale as the pin: a typo is invisible after the write, so rejecting it
 * at `switchroom apply` is the cheap catch; the plugin re-validates
 * (`lib/config.compute_observation_scopes`) for a raw env / settings.json
 * value this schema cannot reach.
 */
const ObservationScopeStrategySchema = z
  .enum(OBSERVATION_SCOPE_STRATEGIES)
  .optional()
  .describe(
    "Per-retain strategy that decides how the observation scope is " +
    "computed when no `observation_scopes` pin is set. \"curated\" " +
    "(the default since #4035) strips volatile per-session provenance " +
    "tags from each retain's consolidation scope — keeping the stable " +
    "semantic ones on the source fact — so an agent's observations dedup " +
    "and merge across sessions instead of pocketing one-per-session. " +
    "\"shared\" sends every retain to the one global untagged scope. " +
    "\"combined\" / \"off\" opt OUT: no per-row scope goes on the wire, " +
    "restoring the pre-feature engine default (byte-identical to an " +
    "unconfigured client). OMITTED BY DEFAULT: unset leaves the plugin's " +
    "own default (`curated`) in force. A manual `observation_scopes` pin " +
    "wins over this strategy. Accepted values: " +
    `${OBSERVATION_SCOPE_STRATEGIES.join(", ")}. ` +
    "Cascade: override (per-agent wins over default)."
  );

/**
 * `memory.anti_confabulation_directive` — the seeded guardrail directive that
 * tells reflect to answer "the bank does not know" rather than synthesising an
 * answer retrieval does not support.
 *
 * Three shapes, one knob, matching the "defaults do the right thing;
 * complexity is opt-in" rule:
 *
 *   - **unset / `true`** → switchroom seeds and maintains its own default. The
 *     zero-config path; nothing in yaml is required to get the guardrail.
 *   - **`false`** → seed nothing, and leave any existing directive of that
 *     name alone (a bank that already has one keeps it — opting out of
 *     MANAGEMENT is not a delete).
 *   - **a string** → operator-authored text. Wins outright and is re-asserted
 *     on every apply, exactly like `memory.retain_mission`.
 *
 * A fourth override path needs no yaml at all: edit the directive in the bank.
 * Seeding only ever upgrades text that byte-matches a default switchroom
 * itself shipped, so a hand-edit is permanent (see
 * `src/memory/hindsight-seed-directives.ts`).
 *
 * Declared once and reused by BOTH `AgentMemorySchema` and the
 * defaults/profile-tier mirror so the two tiers cannot drift.
 */
const AntiConfabulationDirectiveSchema = z
  .union([z.boolean(), z.string().min(1)])
  .optional()
  .describe(
    "The seeded anti-confabulation directive: reflect has no relevance " +
    "floor (`min_scores` is a /recall-only parameter), so a bank holding " +
    "nothing relevant still yields a confident answer, and a question that " +
    "presupposes a decision reliably produces one. Directives ARE applied " +
    "during reflect, so this is the lever. Unset or true (the default) " +
    "seeds and maintains switchroom's own text; false disables seeding and " +
    "leaves any existing directive untouched; a string is operator-authored " +
    "text that wins outright. Switchroom only ever upgrades directive text " +
    "byte-equal to a default it shipped, so editing the directive in the " +
    "bank is also a permanent override. " +
    "Cascade: override (per-agent wins over default)."
  );

export const AgentMemorySchema = z
  .object({
    collection: z.string().describe("Hindsight collection name for this agent"),
    auto_recall: z
      .boolean()
      .default(true)
      .describe("Auto-search memories before each response"),
    file: z
      .boolean()
      .default(true)
      .describe(
        "Maintain a curated workspace MEMORY.md file (seeded once, " +
        "auto-loaded every turn). Set false for hindsight-only memory: " +
        "the file is not seeded or re-created, so once migrated into " +
        "Hindsight and deleted it stays gone. Recall + directives carry " +
        "the memory instead. Cascade: override (per-agent wins over default)."
      ),
    isolation: z
      .enum(["default", "strict"])
      .default("default")
      .describe(
        "strict = never shared cross-agent, default = eligible for reflect"
      ),
    profile: z
      .string()
      .optional()
      .describe(
        "Memory profile bank this agent's curated memory defaults key off — " +
        "the built-in disposition + observations_mission in PROFILE_MEMORY_DEFAULTS. " +
        "Decouples the memory profile from `extends` (the filesystem persona " +
        "profile), so an agent on `extends: default` can opt into the `coding` " +
        "memory bundle via `memory.profile: coding` without inheriting the coding " +
        "persona. Resolution: memory.profile → extends → DEFAULT_PROFILE (see " +
        "resolveMemoryProfile). Unset ⇒ byte-identical to keying off `extends`."
      ),
    bank_mission: z
      .string()
      .optional()
      .describe(
        "Bank-level mission statement used during recall to contextualize " +
        "results. NOTE: this is an alias for the Hindsight engine's " +
        "`reflect_mission` field (verified live: switchroom's bank_mission " +
        "lands in `config.reflect_mission`). Prefer `reflect_mission` going " +
        "forward; `bank_mission` is retained for back-compat. If both are " +
        "set, `reflect_mission` wins. Cascade: override."
      ),
    reflect_mission: z
      .string()
      .optional()
      .describe(
        "Mission/context steering Hindsight Reflect operations (the bank's " +
        "'who am I / what matters' framing applied during recall). The " +
        "engine-accurate name for what `bank_mission` sets. Cascade: override."
      ),
    reflect_budget: z
      .enum(["low", "mid", "high"])
      .optional()
      .describe(
        "Thinking/retrieval budget injected into reflect MCP calls when the " +
        "caller omits budget. Unset ⇒ shim default (mid). Explicit per-call " +
        "budget always wins. Higher = better recall on fuzzy queries, more " +
        "backend latency/compute. stdio-shim transport only (ignored under " +
        "memory.config.mcp_transport: http). Cascade: override (per-agent " +
        "wins over default)."
      ),
    reflect_max_tokens: z
      .number()
      .int()
      .positive()
      .max(8192)
      .optional()
      .describe(
        "Token cap injected into reflect MCP calls when caller omits " +
        "max_tokens. Unset ⇒ shim default 1024. Values much above ~2048 risk " +
        "exceeding Claude Code's MCP output cap, silently dropping the " +
        "payload — raise deliberately. Explicit per-call values always win. " +
        "stdio-shim transport only. Cascade: override."
      ),
    retain_mission: z
      .string()
      .optional()
      .describe("Instructions for the fact extraction LLM during retain. Cascade: override."),
    mental_models: z
      .array(
        z.object({
          name: z
            .string()
            .min(1)
            .describe(
              "Stable model name (identity key for idempotent ensure). Two " +
              "declarations with the same name in one agent are rejected."
            ),
          source_query: z
            .string()
            .min(1)
            .max(2000)
            .describe(
              "The reflection query the model answers, semantically " +
              "refreshed from the bank's content. Capped at 2000 chars — a " +
              "standing reflection query, not a document; the ceiling also " +
              "bounds what an agent-proposed model can smuggle past the " +
              "operator approval card."
            ),
          refresh_after_consolidation: z
            .boolean()
            .optional()
            .describe(
              "Refresh this model after each consolidation. Defaults OFF — " +
              "refresh adds bounded background model-spend + timeout risk " +
              "(RFC Phase 5), so it is opt-in per model."
            ),
          max_tokens: z
            .number()
            .int()
            .positive()
            .max(8192)
            .optional()
            .describe(
              "Cap on the synthesized model's token size. Upper-bounded at " +
              "8192 — a mental model is a standing summary, not a corpus; the " +
              "ceiling also caps what an agent-proposed model can request."
            ),
        })
      )
      .superRefine((models, ctx) => {
        const seen = new Set<string>();
        for (let i = 0; i < models.length; i++) {
          const key = models[i].name;
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, "name"],
              message:
                `duplicate mental_models name "${key}" — model names must be ` +
                `unique within an agent (they are the idempotent-ensure key)`,
            });
          }
          seen.add(key);
        }
      })
      .optional()
      .describe(
        "Operator-declared, per-specialist Hindsight mental models (RFC " +
        "Phase 5). Named, opt-in curated reflections this agent's bank should " +
        "carry — e.g. a coach's 'training-plan-state' or a lawyer's " +
        "'open-matters'. Ensured idempotently at scaffold/reconcile: NOTHING " +
        "is created unless declared here (zero declarations = zero models, " +
        "matching post-#2447 behaviour), and no fixed identity model is " +
        "reintroduced — 'who the user is' stays owned by dedicated profile " +
        "banks (users.*.profile_bank), never a per-agent model. Per-agent " +
        "ONLY: intentionally not accepted at the defaults/profile tier, so a " +
        "model can never be fleet-seeded — each specialist opts in on its own " +
        "(the invariant-clean inverse of the retired blind auto-seeding)."
      ),
    observations_mission: z
      .string()
      .optional()
      .describe(
        "Steers what the observation-consolidation LLM synthesises from raw " +
        "facts (the higher-order 'what patterns matter' lens). Cascade: override."
      ),
    disposition: z
      .object({
        skepticism: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How much the bank doubts unverified claims (1-5; engine default 3)."),
        literalism: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How literally the bank reads statements vs inferring intent (1-5; engine default 3)."),
        empathy: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How much the bank weights emotional/relational context (1-5; engine default 3)."),
      })
      .optional()
      .describe(
        "Personality traits (1-5 each) steering how this bank frames recall, " +
        "reflect, and observation synthesis — a coach leans empathy-high, a " +
        "lawyer/analyst leans skepticism/literalism-high. Maps to the engine's " +
        "flat `disposition_skepticism`/`_literalism`/`_empathy` fields. " +
        "Cascade: per-key merge (an agent overrides individual traits and " +
        "inherits the rest, matching `recall`)."
      ),
    directive_capture_nudge: z
      .boolean()
      .optional()
      .describe(
        "Deterministic directive-capture nudge (issue #2848 Stage B). When " +
        "on (switchroom default true — Stage A measured a ~55% miss rate on " +
        "durable corrections), the auto-recall hook regex-detects correction " +
        "/ standing-rule-shaped inbound (\"always/never …\", \"from now on …\", " +
        "\"stop doing …\", a stated preference, \"that's wrong, it's …\") and " +
        "appends a terse advisory to the turn's context telling the model to " +
        "persist the rule with mcp__hindsight__create_directive if it IS " +
        "durable. Detection is pure regex — the model does the judgment " +
        "in-session and calls create_directive itself (no model callsite, no " +
        "silent hook-side write). Set false to disable per-agent. " +
        "Cascade: override (per-agent wins over default)."
      ),
    anti_confabulation_directive: AntiConfabulationDirectiveSchema,
    observation_scopes: ObservationScopesSchema,
    observation_scope_strategy: ObservationScopeStrategySchema,
    recall: z
      .object({
        max_memories: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cap on the number of memories injected into the prompt by " +
            "auto-recall, regardless of token budget. Plugin default is 12. " +
            "0 disables the cap (all memories Hindsight returns are injected).",
          ),
        cache_ttl_secs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Per-session recall cache TTL in seconds. When > 0, identical " +
            "(prompt, bank) within the same session reuse the cached recall " +
            "result instead of round-tripping to Hindsight. 0 disables. " +
            "Default is 600 (10 min) for switchroom-managed agents.",
          ),
        hook_timeout_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Ceiling (seconds) Claude Code gives the UserPromptSubmit recall " +
            "hook before killing it. Stamped into the installed plugin's " +
            "hooks/hooks.json, so it survives `switchroom apply` reinstalling " +
            "the plugin. Default 12. Raising it lets slow banks finish at the " +
            "cost of pre-turn dead air; `parallel_deadline_seconds` and " +
            "`request_timeout_seconds` are both kept under it. A value below " +
            "3s is raised to 3s and reported: the fan-out deadline must be at " +
            "least 1s AND still leave 2s of post-deadline headroom, so a " +
            "lower ceiling admits no usable envelope at all.",
          ),
        parallel_deadline_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Shared deadline (seconds) for the whole parallel multi-bank " +
            "recall fan-out. Slots unfinished when it elapses are abandoned " +
            "and reported as timed out. Defaults to `hook_timeout_seconds` " +
            "minus 2s of headroom for block formatting, cache write and " +
            "stdout flush, so a straggler bank can never push the hook past " +
            "its ceiling. Set explicitly to override that derivation; a value " +
            "that would leave less than 2s under the hook ceiling — including " +
            "one set EQUAL to it — is clamped back to `hook_timeout_seconds` " +
            "minus 2, and the clamp is reported. Equality is not allowed: at " +
            "zero headroom the hook is killed mid-write and the turn loses " +
            "both the memories and the recall_log row explaining why.",
          ),
        query_max_tokens: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cap on the number of DISTINCT BM25 terms the recall hook may " +
            "put on the wire. `recallMaxQueryChars` bounds characters, which " +
            "is not the cost driver: Hindsight OR-joins every query token " +
            "into one tsquery and Postgres native FTS ranks the entire " +
            "matched set before the top-60 heapsort, so cost tracks TERMS. " +
            "An 800-char composed query is ~96 distinct terms and matched " +
            "119,510 of 135,565 rows on the `overlord` bank (14.0s for the " +
            "3-arm " +
            "BM25 UNION), past the per-bank timeout — 96.8% of that agent's " +
            "own-bank recalls returned nothing. Plugin default is 24 " +
            "(measured 48,433 rows / 2.7s on the same bank). Terms are " +
            "chosen recency-first (the latest turn beats prior context), " +
            "then by selectivity. 0 disables shaping (rollback lever).",
          ),
        query_stop_terms: z
          // A BM25 term, as Hindsight's tokenizer produces them: word chars
          // plus the `. / -` that hold compound tokens (semvers, paths,
          // hyphenated identifiers) together. Anything else could never match
          // a token anyway, and the constraint keeps the value trivially safe
          // to embed in the single-quoted start.sh export.
          .array(z.string().min(1).regex(/^[\w./-]+$/))
          .optional()
          .describe(
            "Extra terms dropped from the BM25 recall query, on top of the " +
            "built-in English stopword list. For BANK-SPECIFIC " +
            "high-document-frequency words a generic stoplist cannot know " +
            "about: on `overlord`, `switchroom` matches 20% of the bank and " +
            "`agent` another 20%, purely because that is what the corpus is " +
            "about, and each such term drags tens of thousands of rows into " +
            "the ranking. Defaults to [].",
          ),
        request_timeout_seconds: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Per-bank HTTP read timeout, in seconds, for one recall " +
            "request. Even parallelised, each bank carries its own deadline " +
            "so ONE hung bank returns empty instead of consuming the shared " +
            "deadline and starving its siblings. The plugin default is 12 " +
            "(raised from a hardcoded 8 in #3757, which fired on 96.8% of " +
            "one agent's own-bank recalls). Switchroom defaults it to the " +
            "effective `parallel_deadline_seconds` instead — 10 at the " +
            "shipped ceiling — because the shared fan-out deadline is " +
            "already the tighter outer guard, so a per-bank value above it " +
            "can never bind. An explicitly configured value above the " +
            "effective deadline is clamped down to it, and the clamp is " +
            "reported.",
          ),
        own_bank_min_slots: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Slots inside `max_memories` reserved as a FLOOR for the agent's " +
            "own bank when recall fans out to more than one bank. The merged " +
            "set is sorted globally by relevance and head-sliced, which is " +
            "winner-take-all across banks: when both banks return more " +
            "candidates than the cap, one bank's score distribution can fill " +
            "every slot and the agent gets a dossier about its operator with " +
            "none of its own session memory. A floor, not a quota: at most " +
            "this many slots, only if the own bank returned that many, and " +
            "only up to HALF the cap shared with `additional_bank_min_slots` " +
            "— the rest is always won on pure relevance, so composition still " +
            "moves with the scores. Fixes score-based crowd-out only; a " +
            "timed-out bank returns no candidates and reservation is a no-op " +
            "there. 0 disables (default). Switchroom-managed agents use 2 " +
            "against the fleet-deployed cap of 6.",
          ),
        additional_bank_min_slots: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Slots inside `max_memories` reserved as a FLOOR for the " +
            "additional (profile / shared / sender) banks. Symmetric with " +
            "`own_bank_min_slots` — same floor-not-quota semantics, and the " +
            "two share the same half-of-cap reservation budget. When they sum " +
            "above that budget the own-bank floor is honoured first. 0 " +
            "disables (default). Switchroom-managed agents use 1 against the " +
            "fleet-deployed cap of 6. Observe `injected_own_bank_count` / " +
            "`injected_additional_bank_count` via " +
            "`switchroom memory recall-log`.",
          ),
        min_score: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Absolute floor on a memory's engine relevance score " +
            "(`scores.final`) for it to be injected. 0 disables (default, " +
            "and the shipped fleet behaviour). Exists for one measured " +
            "failure: when the agent's own bank times out, recall still " +
            "injects side-bank residue under the banner 'Relevant memories " +
            "from past conversations' — 98.4% of degraded turns have a best " +
            "injected score below 0.01, against 28.4% of healthy ones. Six " +
            "noise memories are worse than none, because the agent cannot " +
            "tell them apart. Below-floor results are dropped BEFORE " +
            "rendering, and when the floor empties the set the turn says so " +
            "rather than going silent. Do NOT read this as a general " +
            "precision control: `scores.final` is not calibrated across " +
            "queries, and #3761 measured that an unconditional 0.01 floor " +
            "empties ~28% of HEALTHY recalls — which is why " +
            "`min_score_scope` defaults to degraded turns only. Observe " +
            "`dropped_below_min_score` via `switchroom memory recall-log`.",
          ),
        min_score_scope: z
          .enum(["degraded", "all"])
          .optional()
          .describe(
            "Which turns `min_score` binds on. \"degraded\" (default) — only " +
            "turns where the agent's OWN bank timed out or was unreachable, " +
            "the population where a below-floor score actually predicts " +
            "noise and where the agent already receives the degraded-recall " +
            "disclosure. \"all\" — every turn; only for an operator who has " +
            "measured their own bank's score distribution, since it " +
            "re-creates the empty-recall failure of #3541 at any floor " +
            "calibrated on degraded data. No effect while `min_score` is 0.",
          ),
        types: z
          .array(z.string())
          .optional()
          .describe(
            "Hindsight fact types to recall. Switchroom default is " +
            "[\"world\", \"experience\", \"observation\"] — the synthesized " +
            "`observation` tier is on by default. Set to " +
            "[\"world\", \"experience\"] to opt out of observation-backed " +
            "recall for this agent (or fleet-wide under defaults).",
          ),
        additional_banks: z
          .array(z.string())
          .optional()
          .describe(
            "Extra Hindsight banks to recall from on every turn, merged into " +
            "the agent's own bank results — e.g. a shared operator/household " +
            "profile bank authored via `switchroom memory profile`. Each is " +
            "recalled with the `request_timeout_seconds` per-bank timeout " +
            "(defaults to the effective `parallel_deadline_seconds`, 10s at " +
            "the shipped ceiling) and is non-fatal on failure. Stays " +
            "within the single tenant: all banks are the operator's data, in " +
            "the operator's Hindsight instance (see the `single-tenant` " +
            "invariant). Defaults to [] (no extra banks).",
          ),
        sender_banks: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Per-speaker recall routing: a map of Telegram sender → extra " +
            "recall bank. When a message arrives, the agent also recalls the " +
            "speaker's bank (matched by Telegram username — a leading @ is " +
            "optional — or numeric user_id), merged " +
            "into its own results — so each trusted user gets their own " +
            "profile context. Additive recall scoping within the single " +
            "tenant: never an access boundary (who may drive an agent stays " +
            "the per-agent user assignment in `access.allowFrom`). Author the " +
            "banks via `switchroom memory profile`.",
          ),
        skip_trivial: z
          .boolean()
          .optional()
          .describe(
            "Skip recall on plausibly-stateless trivial turns (time/date/" +
            "greeting). Switchroom default true — saves the recall arm + " +
            "injected tokens on turns that never need memory, guarded so it " +
            "never skips a turn that references user/project/session state. " +
            "Set false to always run recall.",
          ),
        // ── Passthrough knobs (#3841) ────────────────────────────────────
        // Every one of these was previously reachable only by hand-editing
        // the installed plugin (reverted by the next `switchroom apply`) or by
        // smuggling a raw HINDSIGHT_RECALL_* into the agent's `env:` map. Each
        // defaults to the value the fleet already runs, and start.sh exports
        // all of them unconditionally (#3774) — see
        // src/setup/hindsight-recall-passthrough.ts.
        budget: z
          .enum(["low", "mid", "high"])
          .optional()
          .describe(
            "How hard Hindsight searches. \"low\" (switchroom default) = " +
            "vector retrieval only, ~1-2s. \"mid\" adds the LLM rerank pass " +
            "and measured ~5s of hook latency on real fleet turns — the " +
            "second-largest contributor to perceived dead air after model " +
            "TTFT. \"high\" is thorough and slower still. Raise it for an " +
            "agent whose recall quality matters more than its reply latency " +
            "(a research or audit role); leave it at low for chat.",
          ),
        max_tokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Token budget for the injected memory block. Default 1024. This " +
            "is the TOKEN bound; `max_memories` is the separate COUNT bound " +
            "and the tighter of the two wins. Raise it only alongside " +
            "`max_memories` — on its own it buys nothing once the count cap " +
            "binds.",
          ),
        prefer_observations: z
          .boolean()
          .optional()
          .describe(
            "Bias recall toward the synthesized `observation` tier, " +
            "backfilling the slots freed by superseded raw facts for denser " +
            "coverage inside the same budget. Default true. Set false to " +
            "rank raw `world`/`experience` facts on equal footing — useful " +
            "when auditing what the consolidation engine actually stored, or " +
            "if a bank's observations are stale.",
          ),
        context_turns: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "How many recent human turns are composed into the recall query. " +
            "Default 2, so a bare follow-up (\"and the port?\") embeds with " +
            "its antecedent instead of recalling on the pronoun alone. 1 = " +
            "the latest turn only. Raising it costs BM25 terms, which is the " +
            "real recall cost driver — `query_max_tokens` still bounds the " +
            "result, so a large value mostly shifts which terms survive.",
          ),
        roles: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Transcript roles the multi-turn composition may draw from. " +
            "Default [\"user\", \"assistant\"]. Set [\"user\"] to compose " +
            "the query from the human's words only — worth trying when an " +
            "agent's own verbose replies are dominating the query terms. No " +
            "effect while `context_turns` is 1.",
          ),
        prompt_preamble: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The banner rendered above injected memories. The agent reads " +
            "this line as the instruction for how to treat the block, so it " +
            "is a behaviour knob, not cosmetics. Default tells the model to " +
            "prioritise recent memories on conflict and ignore irrelevant " +
            "ones. Override to tighten that framing for a specialised agent.",
          ),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Restrict recall to memories carrying these tags. Default [] = " +
            "no filter (match everything). This is a HARD filter applied " +
            "server-side — a memory without the tags cannot surface at any " +
            "score — so it is for a genuinely scoped agent, not for " +
            "ranking. Use `tag_weights` when you want a preference rather " +
            "than an exclusion.",
          ),
        tags_match: z
          .enum(["any", "all", "any_strict", "all_strict"])
          .optional()
          .describe(
            "How `tags` combine. \"any\" (default) = at least one; " +
            "\"all\" = every tag. The `_strict` forms additionally require " +
            "the memory to actually carry the tags rather than merely rank " +
            "for them. No effect while `tags` and `tag_groups` are empty.",
          ),
        tag_groups: z
          .union([
            z.array(z.array(z.string().min(1))),
            z.record(z.string(), z.array(z.string().min(1))),
          ])
          .optional()
          .describe(
            "Tag filtering with grouping — either an OR-of-ANDs list " +
            "([[\"a\",\"b\"],[\"c\"]] = (a AND b) OR c) or a named " +
            "{group: [tags]} map. Default unset (no grouping). Use when a " +
            "flat `tags` + `tags_match` cannot express the scope you need.",
          ),
        tag_weights: z
          .record(z.string(), z.number().min(0))
          .optional()
          .describe(
            "Per-tag multipliers applied to `scores.final` just before the " +
            "final sort — a DEMOTION/PROMOTION, never a drop, so a " +
            "down-weighted memory still surfaces when it is the only " +
            "relevant hit. MERGED over switchroom's seed " +
            "({\"sidechain\": 0.8}, which ranks delegated sub-agent " +
            "process-memories just under first-party ones), so setting one " +
            "unrelated weight does not silently undo it; pass " +
            "`sidechain: 1.0` to neutralise the seed. Reach for this when " +
            "recall_log shows one class of memory crowding the block.",
          ),
        additional_bank_filters: z
          .record(
            z.string(),
            z
              .object({
                tags: z.array(z.string().min(1)).optional(),
                tags_match: z.enum(["any", "all", "any_strict", "all_strict"]).optional(),
                tag_groups: z
                  .union([
                    z.array(z.array(z.string().min(1))),
                    z.record(z.string(), z.array(z.string().min(1))),
                  ])
                  .optional(),
              })
              .strict(),
          )
          .optional()
          .describe(
            "Per-bank overrides of the tag filters above, keyed by bank id " +
            "(applies to `additional_banks` AND to sender banks). Default " +
            "{} = every extra bank inherits the global filters. Use it to " +
            "scope a shared bank — e.g. recall only `profile`-tagged " +
            "memories from the operator's profile bank while leaving the " +
            "agent's own bank unfiltered.",
          ),
        transcript_fallback: z
          .boolean()
          .optional()
          .describe(
            "When every bank returns zero results AND no bank hit its " +
            "deadline, grep the current session's transcript tail for turns " +
            "matching the query and inject them as a clearly-labelled " +
            "lower-confidence block. Default true — it covers the window " +
            "between an abrupt kill and the next boot reconciliation, where " +
            "the fact layer was never told about the lost turns. Set false " +
            "if you never want un-consolidated transcript text in context.",
          ),
        transcript_tail_bytes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Bytes of the session transcript read from the tail for the " +
            "multi-turn query composition. Default 262144 (256 KiB), which " +
            "keeps the per-turn read O(1) on a session log that can grow to " +
            "many MB. 0 = read the whole file (the pre-bound behaviour, and " +
            "the rollback lever if a composition ever needs older turns).",
          ),
        max_query_chars: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Character bound on the composed recall query, applied before " +
            "`query_max_tokens` shapes it. Default 800. Truncation preserves " +
            "the latest turn and drops the oldest context first. Lower it " +
            "for an agent whose turns are long pasted payloads.",
          ),
        parallel: z
          .boolean()
          .optional()
          .describe(
            "Run the directives fetch and every bank recall concurrently " +
            "under one shared deadline, so total latency is the SLOWEST slot " +
            "rather than their SUM. Default true. false restores the serial " +
            "path — the rollback lever if the parallel path ever misbehaves; " +
            "expect multi-bank recall latency to add up.",
          ),
        topic_filter_mode: z
          .enum(["soft-preamble", "hard-filter"])
          .optional()
          .describe(
            "Supergroup-mode cross-topic memory behaviour. Default " +
            "(unset) → soft-preamble: recall returns memories from all " +
            "topics, and a 'Current topic: …' preamble tells the model " +
            "to self-scope. hard-filter: drop any recalled memory whose " +
            "metadata.thread_id differs from the active inbound's topic. " +
            "Flip to hard-filter when the recall_log shows binding " +
            "failures (model surfacing the right memory but applying " +
            "it to the wrong topic).",
          ),
      })
      .optional()
      .describe("Auto-recall tuning knobs"),
    retain: z
      .object({
        every_n_turns: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "How often the Stop hook fires auto-retention, in turns. The " +
            "vendor plugin default is 10 (a short session can end before " +
            "retention ever fires); switchroom's scaffold default is 3. " +
            "Lower = more frequent, smaller retains + tighter crash " +
            "durability (at 1, every turn is retained before a restart can " +
            "lose it); higher = fewer, larger retains + less LLM churn. " +
            "Raised from the historical 1 to 3 because the local reasoning " +
            "consolidation model (Ollama gpt-oss-20b) ran away on the large " +
            "overlapping every-turn payloads. Set to 1 for the old " +
            "every-turn crash-durability guarantee. Min 1. Cascade: " +
            "per-field merge (agent wins over default).",
          ),
        overlap_turns: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Extra recent turns included in each chunked retain window on " +
            "top of `every_n_turns`, so window = overlap_turns + " +
            "every_n_turns recent turns. Vendor default is 2; switchroom's " +
            "scaffold default is 1 (smaller payloads for the local " +
            "reasoning consolidation model). Higher = more redundant " +
            "context re-sent per fire. Min 0. Cascade: per-field merge.",
          ),
      })
      .optional()
      .describe("Auto-retain (Stop-hook consolidation) cadence knobs"),
  })
  .optional();

/**
 * A single hook entry in switchroom.yaml. We accept the ergonomic flat form
 * (`{ command, timeout?, async?, env?, matcher? }`) and translate to
 * Claude Code's nested `{ hooks: [{ type: "command", ... }] }` shape in
 * scaffold.ts. Keeping the flat form in YAML makes the common case
 * (just run this script on this event) a two-line declaration.
 */
export const HookEntrySchema = z.object({
  command: z.string().describe("Shell command to run. Supports ${CLAUDE_CONFIG_DIR} and ${CLAUDE_PLUGIN_ROOT} substitution."),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in seconds before Claude Code aborts the hook"),
  async: z
    .boolean()
    .optional()
    .describe(
      "If true (valid on Stop only), the hook does not block the agent response"
    ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra env vars passed to the hook process"),
  matcher: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Condition gates (e.g., { channel: 'telegram' })"),
});

/**
 * Per-event arrays of hook entries. Switchroom accepts any Claude Code hook
 * lifecycle event; the list below is the current set as of 2026-04.
 * Unknown event names pass through as-is so future Claude Code events
 * don't break the schema.
 */
export const AgentHooksSchema = z
  .object({
    SessionStart: z.array(HookEntrySchema).optional(),
    UserPromptSubmit: z.array(HookEntrySchema).optional(),
    PreToolUse: z.array(HookEntrySchema).optional(),
    PostToolUse: z.array(HookEntrySchema).optional(),
    Stop: z.array(HookEntrySchema).optional(),
    SessionEnd: z.array(HookEntrySchema).optional(),
  })
  .catchall(z.array(HookEntrySchema))
  .optional();

/**
 * A sub-agent definition that switchroom renders into a
 * `.claude/agents/<name>.md` file. Maps 1:1 onto Claude Code's
 * custom sub-agent frontmatter spec (code.claude.com/docs/en/sub-agents).
 *
 * Only `description` is required here; `name` is derived from the
 * YAML key in `subagents: { <name>: { ... } }`.
 */
export const SubagentSchema = z.object({
  // Optional so profile-level partial overrides (e.g. coding profile
  // overlaying just `isolation: worktree` onto the defaults' worker)
  // don't have to restate the description. The cascade merges by key
  // with defaults; the merged subagent retains the description from
  // defaults. (Install-validation finding #13.)
  description: z
    .string()
    .optional()
    .describe("When the main agent should delegate to this sub-agent"),
  model: z
    .string()
    .optional()
    .describe("Model: 'sonnet', 'opus', 'haiku', full ID, or 'inherit' (default)"),
  background: z
    .boolean()
    .optional()
    .describe("Run in background by default (non-blocking). Default false"),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("'worktree' gives the sub-agent its own git branch"),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool allowlist. Inherits all if omitted"),
  disallowedTools: z
    .array(z.string())
    .optional()
    .describe("Tools to deny (removed from inherited set)"),
  maxTurns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max agentic turns before auto-stop"),
  permissionMode: z
    .enum(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"])
    .optional()
    .describe("Permission mode override for this sub-agent"),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Effort level override"),
  color: z
    .enum(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"])
    .optional()
    .describe("Display color in the task list"),
  memory: z
    .enum(["user", "project", "local"])
    .optional()
    .describe("Persistent memory scope for cross-session learning"),
  skills: z
    .array(z.string())
    .optional()
    .describe("Skills to preload into the sub-agent's context"),
  prompt: z
    .string()
    .optional()
    .describe("System prompt (becomes the markdown body after frontmatter)"),
});

/**
 * Session lifecycle policy. Controls whether the agent resumes its
 * previous Claude Code session on restart or starts fresh.
 *
 * At agent startup, start.sh inspects the most recent session JSONL:
 *   - If the session has been idle longer than `max_idle`, start fresh
 *   - If the session has more user turns than `max_turns`, start fresh
 *   - Otherwise, pass `--continue` to resume
 *
 * A fresh session gets a clean context window with Hindsight recall
 * bringing back relevant memories. The previous session's data stays
 * on disk (Claude Code doesn't delete old sessions).
 */
export const SessionSchema = z
  .object({
    max_idle: z
      .string()
      .regex(
        /^\d+[smh]$/,
        "Duration must be a number followed by s, m, or h (e.g. '2h', '30m')",
      )
      .optional()
      .describe(
        "Start a fresh session if the previous one has been idle " +
        "longer than this duration. Examples: '2h', '30m', '7200s'.",
      ),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Start a fresh session if the previous one has more user " +
        "turns than this. Useful for preventing context bloat on " +
        "long-running agents.",
      ),
    max_context_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Proactively run /compact when the live context window " +
        "occupancy (latest assistant turn input + cache-read + " +
        "cache-creation tokens) reaches this many tokens. Opt-in: " +
        "unset means rely on Claude Code's native auto-compaction. " +
        "Useful on large-window models (e.g. 1M Opus) to hold a " +
        "deliberately lean working context.",
      ),
    idle_clear_after: z
      .string()
      .regex(
        /^\d+[smh]$/,
        "Duration must be a number followed by s, m, or h (e.g. '3h', '90m')",
      )
      .optional()
      .describe(
        "Auto-run /clear (wipe the working context) after the live " +
        "session has been idle this long. Defaults to '3h' when unset " +
        "(on by default); set '0s' to disable. Long-term memory lives " +
        "in Hindsight, so a clear loses only the in-session thread.",
      ),
  })
  .optional();

/**
 * Session-handoff continuity. Fresh sessions start with a clean context
 * window; to avoid losing "where were we?" between sessions, a Stop hook
 * summarizes the previous session into a compact briefing that the next
 * start.sh injects via --append-system-prompt.
 *
 *   - enabled: master switch. When false, no Stop hook is installed and
 *     start.sh skips all handoff logic.
 *   - max_turns_in_briefing: hard cap on how many recent user/assistant
 *     turn pairs are fed to the summarizer. Bounds cost and latency.
 */
export const SessionContinuitySchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe("Master switch for the session-handoff briefing (default true)."),
    max_turns_in_briefing: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cap on recent user/assistant turn pairs fed to the summarizer."),
    resume_mode: z
      .enum(["auto", "continue", "handoff", "none"])
      .optional()
      .describe(
        "How to resume the next session. 'handoff' (default as of #362) " +
        "never passes --continue; a fresh Claude starts each restart and " +
        "reads a briefing assembled from recent Telegram messages, Hindsight " +
        "recall, and today's daily memory file. 'auto' uses --continue when " +
        "the latest JSONL is smaller than resume_max_bytes, else falls back " +
        "to the handoff briefing. 'continue' always passes --continue. " +
        "'none' starts completely fresh every time.",
      ),
    resume_max_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Byte threshold above which 'auto' mode falls back to handoff " +
        "instead of --continue. Default 2_000_000 (~2MB). Large transcripts " +
        "can blow out the context window even with prefix caching, and " +
        "--continue replay is known-fragile at scale.",
      ),
    briefing: z
      .enum(["gateway", "legacy"])
      .optional()
      .describe(
        "Which mechanism assembles the fresh-session reorientation briefing " +
        "(default 'legacy'). 'legacy' keeps today's behaviour: the Stop-hook " +
        ".handoff.md and/or bin/handoff-briefing.sh, injected via " +
        "--append-system-prompt. 'gateway' moves it to a gateway boot-time " +
        "builder sourced from the durable history.db (crash-independent, " +
        "surface-scoped, token-budgeted) and injects it as a synthetic " +
        "<channel source=\"boot_briefing\"> inbound over the durable spool — " +
        "keeping the system-prompt prefix stable for cross-session prompt " +
        "caching. Suppressed automatically when resume_mode is " +
        "'continue'/'auto' (the transcript may be replayed) and on a /reset " +
        "force-fresh boot. Threaded to the gateway as " +
        "SWITCHROOM_SESSION_BRIEFING.",
      ),
    boot_resume: z
      .enum(["always", "in-flight", "never"])
      .optional()
      .describe(
        "How the gateway auto-resumes a turn that was IN FLIGHT when the " +
        "agent restarted. 'in-flight' (default) resumes genuinely " +
        "interrupted work even after a deliberate/operator restart — a " +
        "sanctioned restart landing mid-turn no longer silently drops the " +
        "work. 'always' forces resume unconditionally (same as the " +
        "SWITCHROOM_BOOT_RESUME_ALWAYS=1 escape hatch). 'never' is the " +
        "quota-saving posture: don't auto-replay work across a clean " +
        "restart — but the user is STILL sent a passive notice of what was " +
        "in flight (silence is never used). Independent of the at-most-once " +
        "resume ledger and the bounded resume-chain loop-guard, which always " +
        "apply. Threaded to the gateway as SWITCHROOM_BOOT_RESUME.",
      ),
    session_retention_max_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Session-JSONL retention (issue #2792): keep at most this many " +
        "newest session transcripts under .claude/projects; older ones " +
        "past both this count and the age bound are pruned by the Stop " +
        "hook. The newest sessions (and the handoff source) are always " +
        "kept. Default 20; set 0 to disable the count bound.",
      ),
    session_retention_max_age_days: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Session-JSONL retention (issue #2792): prune session transcripts " +
        "older than this many days (a file is deleted only when it is BOTH " +
        "over the count bound and older than this). Default 30; set 0 to " +
        "disable the age bound.",
      ),
  })
  .optional();

/**
 * Per-channel configuration. Today the only channel is Telegram but
 * the shape is designed to expand (Slack, Discord, Matrix, Email) —
 * each channel lives under its own key with channel-specific options.
 *
 * Telegram options:
 *  - plugin: "switchroom" (default) uses the enhanced switchroom-telegram MCP
 *    with streaming edits, emoji reactions, SQLite history, formatted
 *    output, and per-agent access control. Loaded via
 *    --dangerously-load-development-channels. "official" falls back to
 *    the upstream plugin:telegram@claude-plugins-official marketplace
 *    plugin (basic send/receive only).
 *  - format: default reply format for the channel. Passed to the
 *    plugin via env var. "html" (default) auto-converts markdown.
 *
 * format is pass-through — the plugin reads it from an env var at
 * startup.
 */

/**
 * A single webhook_dispatch rule (#1625, extended for generic/linear in
 * #2272). Shared across the per-source rule arrays under
 * channels.telegram.webhook_dispatch — github / generic / linear all use
 * the same shape. The matcher fields not relevant to a given source are
 * simply ignored at evaluation time (e.g. assignee_any/mentions_any are
 * no-ops for github, exclude_authors is a no-op for generic).
 */
const webhookDispatchRule = z.object({
  description: z.string().optional(),
  match: z
    .object({
      event: z.string(),
      actions: z.array(z.string()).optional(),
      labels_any: z.array(z.string()).optional(),
      labels_all: z.array(z.string()).optional(),
      exclude_authors: z.array(z.string()).optional(),
      assignee_any: z.array(z.string()).optional(),
      mentions_any: z.array(z.string()).optional(),
    })
    .passthrough(),
  prompt: z.string(),
  cooldown: z.string().optional(),
  quiet_hours: z
    .object({
      start: z.number().int().min(0).max(23),
      end: z.number().int().min(0).max(23),
      tz: z.string().optional(),
    })
    .optional(),
});

export const TelegramChannelSchema = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Master switch for the per-agent Telegram gateway sidecar. " +
        "When false, start.sh skips the gateway supervise loop and the " +
        "agent boots without bot-token requirements (smoke-test + " +
        "offline-dev use case).",
      ),
    plugin: z
      .enum(["switchroom", "official"])
      .optional()
      .describe(
        "Which Telegram MCP plugin to load. Default is 'switchroom' — the " +
        "enhanced fork with streaming edits, reactions, history, and " +
        "access control. Set to 'official' for the upstream marketplace " +
        "plugin (basic send/receive only)."
      ),
    format: z
      .enum(["html", "markdownv2", "text"])
      .optional()
      .describe("Default reply format passed to the plugin"),
    // rate_limit_ms removed in #3161 — it was documented and scaffold-
    // exported (SWITCHROOM_TG_RATE_LIMIT_MS) but read by NOTHING; the
    // send gate (telegram-plugin/send-gate.ts, on by default since
    // #3153) is the real outbound throttle. Existing YAML files with a
    // stale rate_limit_ms key are silently ignored by Zod's default
    // strip mode — intentional, same pattern as the progress_card
    // removal (#1122 PR3): operators don't need to clean their YAML.
    stream_mode: z
      .enum(["pty", "checklist"])
      .optional()
      .describe(
        "How live progress is streamed to Telegram during a turn. " +
        "'pty' (default) surfaces text snapshots of Claude Code's TUI — " +
        "compatible but can flicker as Ink re-renders. 'checklist' drives " +
        "a structured progress card from session-tail events — stable " +
        "order, per-tool status emojis, fires only on semantic transitions."
      ),
    stream_throttle_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Throttle window in ms between successive in-place stream edits " +
        "during a turn. Lower = more responsive stream, higher = fewer API " +
        "calls. Floored at 250 by draft-stream itself. Default 400 ms for DMs " +
        "and 1000 ms for groups/forums (respects Telegram's ~1 edit/sec/message " +
        "practical ceiling). Override per-agent if a particular agent needs " +
        "snappier or quieter streaming."
      ),
    clear_status_on_completion: z
      .boolean()
      .optional()
      .describe(
        "When true, the live activity/status feed (the in-place 'what it's " +
        "doing' message — Reading X, Searching the web for Y, …) is DELETED " +
        "when the turn's final answer lands, so only the reply remains. " +
        "Default false: the status message is left in the chat as a record " +
        "(its last step marked done) — no post-then-delete. Per-agent " +
        "override; cascades defaults → profile → agent (per-key)."
      ),
    pin_status_while_working: z
      .boolean()
      .optional()
      .describe(
        "When true (default), the framework SILENTLY pins the already-" +
        "rendered status message while its work is in-flight and auto-unpins " +
        "it on completion — the per-turn activity/status message (foreground) " +
        "and the '🛠 Worker' background-worker message. Keeps in-flight work " +
        "in view when the conversation scrolls past it (fast turns, stacked " +
        "background workers, long turns). No new surface is rendered; it pins " +
        "a message the chat already owns. The pin never buzzes the device. " +
        "The ONE sanctioned pin under chat-is-the-single-source-of-truth. " +
        "Set false to disable. Per-agent override; cascades defaults → " +
        "profile → agent (per-key)."
      ),
    hotReloadStable: z
      .boolean()
      .optional()
      .describe(
        "If true, the stable workspace prefix (AGENTS.md, SOUL.md, USER.md, " +
        "IDENTITY.md, TOOLS.md) is re-injected on every turn via " +
        "the UserPromptSubmit hook instead of baked into --append-system-prompt " +
        "at session start. Lets workspace edits propagate without a restart. " +
        "Costs ~5-10% per-turn latency/spend since the stable prefix is no " +
        "longer prompt-cached."
      ),
    inject_on_change: z
      .boolean()
      .optional()
      .describe(
        "Context-efficiency gate for per-turn hook injection (default true). " +
        "When true (the default), the turn-pacing directive and dynamic " +
        "workspace content are only re-emitted when their content changes or " +
        "the session_id changes — suppressing redundant injection that " +
        "otherwise triples compaction frequency. Set to false to revert to " +
        "the legacy always-emit behaviour (every turn injects the full " +
        "content regardless of whether it changed)."
      ),
    /**
     * Progress-card driver tuning. These knobs are only effective when
     * stream_mode is 'checklist' (the default). All values are in
     * milliseconds unless noted. Omit a field to keep the built-in default.
     */
    orphan_promotion_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How long (ms) a parent turn waits for a sub-agent JSONL watcher " +
        "to deliver sub_agent_started before the heartbeat promotes the spawn " +
        "to a synthesised 'running' row. Default 5000. Set to 0 to disable " +
        "orphan promotion entirely."
      ),
    cold_sub_agent_threshold_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "JSONL-cold threshold (ms). When a running sub-agent emits no events " +
        "for this long, the heartbeat synthesises a turn_end for it so the " +
        "deferred-completion path can proceed. Default 30000. Set to 0 to " +
        "disable the synthetic close."
      ),
    deferred_completion_timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Force-close timeout (ms) for deferred sub-agent completion. After " +
        "the parent turn_end arrives while sub-agents are still running, the " +
        "card is force-closed after this many ms even if sub-agents never " +
        "finish. Watcher-disconnect safety net. Default 180000 (3 min)."
      ),
    approval_timeout_minutes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Operator approval-card lifetime (minutes) for the tool-use 'Allow " +
        "once' card and the vault grant decision wait. After this long with " +
        "no operator tap, the card auto-denies (a TIMEOUT, not a denial — the " +
        "agent is told not to retry). Default 60. hostd-gated verbs " +
        "(mcp__hostd__*) keep their own longer window; the hostd " +
        "config-propose card is not governed by this key."
      ),
    sub_agent_tick_interval_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Heartbeat tick interval (ms) for sub-agent rendering. Forces a " +
        "re-render of the elapsed-time counter while sub-agents are running, " +
        "even during silent stretches between tool calls. Default 10000 (10 s). " +
        "Set to 0 to disable the elapsed-ticker path."
      ),
    edit_budget_threshold: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Telegram API edit budget per minute before the progress-card driver " +
        "falls back to a slower coalesce window. When a chat accumulates more " +
        "than this many card edits in the trailing 60 s, the driver switches " +
        "to a wider coalesce interval until the rate drops back. Default 18. " +
        "Increase if your gateway frequently bumps the Telegram edit-rate ceiling " +
        "with many parallel sub-agents; decrease for a more conservative buffer."
      ),
    send_gate: z
      .object({
        enabled: z
          .boolean()
          .optional()
          .describe(
            "Master switch for the deterministic outbound send gate " +
            "(telegram-plugin/send-gate.ts) — the token-bucket scheduler every " +
            "Bot API call transits so per-surface throttles can't add up past a " +
            "flood ceiling. ON by default. Precedence: the operator break-glass " +
            "env var SWITCHROOM_TELEGRAM_SEND_GATE (0/false/off/no) ALWAYS wins " +
            "when explicitly set; this key only decides when that env var is " +
            "unset. Omit to keep the gate on."
          ),
        global_per_sec: z
          .number()
          .positive()
          .optional()
          .describe(
            "Global bucket sustained rate (Bot API calls/sec across ALL chats). " +
            "Default 25 (headroom under Telegram's ~30/s). Must be > 0 — a zero " +
            "or negative rate would wedge all outbound sends. Omit to keep 25."
          ),
        global_burst: z
          .number()
          .int()
          .positive()
          .describe(
            "Global bucket burst capacity. Default 4; worst-case 1s window " +
            "admits global_burst + global_per_sec = 29 < 30, a real margin under " +
            "the ceiling. Must be an integer >= 1 (a 0 capacity never admits a " +
            "token and wedges sends). Omit to keep 4."
          )
          .optional(),
        per_chat_per_sec: z
          .number()
          .positive()
          .optional()
          .describe(
            "Per-chat sustained rate (calls/sec to a single chat). Default 1. " +
            "Must be > 0 (zero/negative wedges that chat). Omit to keep 1."
          ),
        per_chat_burst: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Per-chat burst capacity. Default 3. Must be an integer >= 1 " +
            "(0 wedges the chat's bucket). Omit to keep 3."
          ),
        per_group_per_min: z
          .number()
          .positive()
          .optional()
          .describe(
            "Per-group sustained rate (calls/min to a single group/supergroup). " +
            "Default 18 (headroom under Telegram's ~20/min group ceiling). Must " +
            "be > 0. Omit to keep 18."
          ),
        per_group_burst: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Per-group burst capacity. Default 2. Must be an integer >= 1 " +
            "(0 wedges the group's bucket). Omit to keep 2."
          ),
        edit_floor_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Minimum ms between successive edits of the SAME message_id " +
            "(last-write-wins coalescing enforces this floor). Default 1500 " +
            "(Telegram's ~1 edit/sec/message practical ceiling). 0 disables the " +
            "floor. Must be an integer >= 0. Omit to keep 1500."
          ),
      })
      .optional()
      .describe(
        "Tunable rate limits for the deterministic outbound send gate " +
        "(telegram-plugin/send-gate.ts). Every key is optional and defaults to " +
        "the send gate's built-in value, so omitting the whole block reproduces " +
        "today's exact behaviour — this is pure operator tuning, no default is " +
        "changed. Cascades from defaults.channels.telegram.send_gate."
      ),
    worker_feed: z
      .object({
        max_rows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Max live-worker rows rendered in the COMBINED worker-activity feed " +
            "(2+ background workers in one chat/thread coalesce into ONE message; " +
            "telegram-plugin/worker-activity-feed.ts) before a compact " +
            "'+M more working…' spill line — keeps the coalesced body compact and " +
            "legible (and under the rich-message wire ceiling). Default 8. A " +
            "single-worker chat renders the full 🛠 Worker card and ignores this. " +
            "Must be an integer >= 1. Omit to keep 8."
          ),
      })
      .optional()
      .describe(
        "Tuning for the coalesced worker-activity feed " +
        "(telegram-plugin/worker-activity-feed.ts). Cascades from " +
        "defaults.channels.telegram.worker_feed."
      ),
    // progress_card block removed in #1122 PR3 (the pinned progress card
    // was replaced by conversational pacing + silence-poke). Existing
    // YAML files with a stale progress_card key will be silently
    // ignored by Zod's strict-passthrough; intentional — operators
    // don't need to clean their YAML for the upgrade to apply.
    stickers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Sticker aliases for the `send_sticker` MCP tool (#576). Maps a " +
        "short alias name (e.g. 'happy', 'thinking') to a Telegram file_id. " +
        "Operator-curated — capture file_ids from inbound stickers the user " +
        "sends and add them here. The agent calls send_sticker(chat_id, " +
        "alias='happy') and the gateway resolves to the file_id at send " +
        "time. Aliases enable persona-flavored expressiveness without " +
        "exposing raw file_ids in the agent prompt. Personal-assistant / " +
        "health-coach personas benefit; coding agents typically don't " +
        "configure any."
      ),
    voice_in: z
      .object({
        enabled: z.boolean().optional().describe("Master switch for voice-message transcription."),
        provider: z.enum(["openai"]).optional().describe(
          "Transcription provider. Only 'openai' (Whisper API) supported in the spike (#578); " +
          "Groq/Deepgram/local-whisper-cli are follow-up choices.",
        ),
        language: z.string().optional().describe(
          "Optional ISO-639-1 language hint (e.g. 'en', 'fr'). Skips Whisper's auto-detection.",
        ),
        api_key: z.string().optional().describe(
          "Transcription-provider API key, as a `vault:<key>` reference " +
          "(e.g. 'vault:openai/api-key' — the default if omitted). The " +
          "gateway resolves it through the vault broker at use-time and " +
          "never writes the resolved value to disk or the agent prompt. " +
          "`switchroom enable voice-in` vault-stores the key and writes " +
          "this reference for you. A literal key is accepted but " +
          "discouraged — keep secrets in the vault.",
        ),
      })
      .optional()
      .describe(
        "Inbound voice-message transcription (#578). When enabled, voice/audio " +
        "messages from allowlisted users are downloaded, transcribed via the " +
        "configured provider, and surface to the agent as the user's text. " +
        "The provider API key is a `vault:` reference (`api_key`, default " +
        "`vault:openai/api-key`) resolved through the vault broker at " +
        "use-time — opt-in third-party key, honest-exception per the " +
        "subscription-honest outcome. Off by default — opt-in per agent. " +
        "Cascades from defaults.channels.telegram.voice_in. " +
        "(Migrated from per-agent root in #596 — see consistency unification.)"
      ),
    voice_out: z
      .object({
        enabled: z.boolean().optional().describe("Master switch for spoken-reply (TTS) voice notes."),
        engine: z
          .enum(["kokoro", "openai"])
          .default("kokoro")
          .describe(
            "Synthesis engine. 'kokoro' = local voice sidecar (POST /tts, " +
            "subscription-honest, no third-party key); 'openai' = OpenAI TTS " +
            "cloud (honest-exception, requires an `api_key` vault ref). " +
            "'kokoro' is only active when the host voice verdict is local " +
            "(SWITCHROOM_VOICE_ENGINE === 'local'); otherwise voice-out is a " +
            "no-op and replies stay text-only.",
          ),
        voice: z.string().optional().describe(
          "Engine-specific voice id (e.g. a Kokoro voice name or an OpenAI " +
          "voice like 'alloy'). Optional — the sidecar/engine has its own " +
          "default when omitted.",
        ),
        reply_mode: z
          .enum(["voice+text", "voice-only", "on-demand"])
          .default("voice+text")
          .describe(
            "How the spoken reply accompanies the text. 'voice+text' sends " +
            "both the normal text reply and a voice note; 'voice-only' sends " +
            "the voice note and suppresses the text body. 'on-demand' sends " +
            "the text reply with a single '🔊 Listen' inline button and " +
            "synthesizes NO audio until the user taps it — zero GPU/sidecar " +
            "work unless requested, which keeps the voice pipeline " +
            "subscription-honest and visible (nothing is generated behind the " +
            "user's back). The Listen button is injected ONLY when the reply " +
            "carries no agent-authored buttons, to avoid colliding with the " +
            "single_use keyboard-strip that protects agent buttons from " +
            "double-fire. In every mode the text reply is ALWAYS still sent " +
            "when synthesis fails or the reply exceeds max_chars — the user's " +
            "answer is never dropped silently.",
          ),
        max_chars: z.number().int().positive().optional().describe(
          "Per-voice-note chunk size (chars). Default 600; clamped to the " +
          "engine's hard cap (1200). A reply LONGER than this is NOT truncated " +
          "to text — it's split on sentence/paragraph boundaries and spoken " +
          "across several sequential voice notes, so the full answer is heard " +
          "even when the user can't read the screen (driving / cycling). Lower " +
          "it for snappier individual notes; raise it (up to 1200) for fewer, " +
          "longer notes.",
        ),
        api_key: z.string().optional().describe(
          "OpenAI TTS API key as a `vault:<key>` reference (only used when " +
          "engine='openai'; default 'vault:openai/api-key'). Resolved through " +
          "the vault broker at use-time and never written to disk or the agent " +
          "prompt. Ignored for engine='kokoro' (the sidecar needs no key).",
        ),
      })
      .optional()
      .describe(
        "Outbound spoken replies via TTS (PR-C2). When enabled, the gateway " +
        "synthesizes the agent's text reply into an OGG/Opus voice note and " +
        "sends it alongside (or instead of) the text, per reply_mode. The " +
        "'kokoro' engine uses the local voice sidecar (POST /tts) and is only " +
        "active when the host voice verdict is local; the 'openai' engine is " +
        "an honest-exception cloud path gated on an `api_key` vault ref. Voice " +
        "is best-effort and fully non-fatal — any TTS error falls back to the " +
        "text reply. Off by default — opt-in per agent. " +
        "Cascades from defaults.channels.telegram.voice_out."
      ),
    telegraph: z
      .object({
        enabled: z.boolean().optional().describe("Master switch for Telegraph Instant View publishing."),
        threshold: z.number().int().positive().optional().describe(
          "Char count above which a reply is published to Telegraph instead of " +
          "HTML-chunked into multiple Telegram messages. Default 3000 (≈3 chunks).",
        ),
        short_name: z.string().optional().describe(
          "Telegraph account display name. Defaults to the agent's slug. Used at " +
          "first-publish to lazily create the account; cached thereafter.",
        ),
        author_name: z.string().optional().describe(
          "Telegraph article byline. Defaults to soul.name when set.",
        ),
      })
      .optional()
      .describe(
        "Long-reply publishing via Telegraph (#579). When enabled, replies " +
        "above the threshold publish as a Telegraph article rendered in " +
        "Telegram via native Instant View. Off by default — content " +
        "residency is real for some personas (lawyer, health-coach with PHI). " +
        "Cascades from defaults.channels.telegram.telegraph. " +
        "(Migrated from per-agent root in #596.)"
      ),
    coalesce: z
      .object({
        window_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Sliding-window (ms) for merging consecutive inbound messages from " +
            "the same sender+topic into ONE Claude turn. Each new message resets " +
            "the timer; the turn starts once the sender pauses for this long. " +
            "Catches forwarded bursts, pasted text the Telegram client split " +
            "into several messages, and mixed text+media forwards. Default 500. " +
            "Set 0 to disable (every message becomes its own turn). Raise for " +
            "users who think in multiple short messages; the trade-off is the " +
            "single-message turn start is delayed by this much (the 👀 ack still " +
            "fires immediately, so perceived latency is unchanged)."
          ),
        max_attachments: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum number of media attachments carried into ONE coalesced " +
            "Claude turn. Default 10 — a full Telegram album (media_group caps " +
            "at 10) or a text+multi-image forwarded burst arrives as a single " +
            "turn; the agent sees numbered attachment fields (image_path, " +
            "image_path_2, …). Set 1 to restore the historical " +
            "single-attachment-per-turn behaviour. Excess attachments beyond " +
            "the cap spill into the next turn. Each attachment is downloaded, " +
            "so a high cap on a slow link delays turn start."
          ),
      })
      .optional()
      .describe(
        "Inbound coalescing — how the gateway groups rapid consecutive messages " +
        "into a single turn so a forwarded album or split paste doesn't fan out " +
        "into N separate turns. Cascades from defaults.channels.telegram.coalesce."
      ),
    litellm_notice: z
      .object({
        window_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Per-agent cooldown window (ms) for the litellm-local 429 notice. " +
            "When the agent trips the LiteLLM proxy's OWN tpm_limit/rpm_limit " +
            "cap (a `litellm-local` classified 429 — see docs/auth.md § " +
            "LiteLLM-proxy-local 429s), the gateway posts ONE calm notice " +
            "naming the fleet token limiter, then counts further hits silently " +
            "for this long; the first notice after the window expires says " +
            "how many were absorbed. Default 900000 (15 min). Invalid values " +
            "fall back to the default."
          ),
      })
      .optional()
      .describe(
        "Debounce tuning for the litellm-local throttle notice — the calm " +
        "'fleet token limiter engaged' message posted when the LiteLLM " +
        "proxy's own rate cap trips (never an Anthropic account limit). " +
        "Cascades from defaults.channels.telegram.litellm_notice."
      ),
    interrupt: z
      .object({
        safe_boundary: z
          .boolean()
          .optional()
          .describe(
            "When true (the default), a `!`-prefix interrupt that arrives while " +
            "the agent is mid-tool-call is DEFERRED: the SIGINT and the " +
            "replacement turn wait until the in-flight tool call finishes (a " +
            "clean boundary) instead of C-c'ing the agent mid-write/mid-bash. If " +
            "no tool is in flight the interrupt still fires immediately. Bounded " +
            "by max_wait_ms so a long tool never strands the user. Set false to " +
            "fire synchronously the moment `!` is received (historical " +
            "behaviour). Rapid repeated `!` while one is pending coalesce into a " +
            "single deferred interrupt carrying the latest body."
          ),
        max_wait_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Upper bound (ms) the gateway waits for a safe boundary before firing " +
            "a deferred `!` interrupt anyway. Only consulted when safe_boundary is " +
            "true. Default 8000. Keep it short — the user explicitly asked to " +
            "interrupt, so a long in-flight tool shouldn't ghost them; the cap " +
            "trades a tiny risk of a mid-tool C-c for a guaranteed response."
          ),
      })
      .optional()
      .describe(
        "Interrupt timing — how a `!`-prefix interrupt behaves when it lands " +
        "mid-tool-call. Off by default (fire immediately). Cascades from " +
        "defaults.channels.telegram.interrupt."
      ),
    button_choice_confirmation: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "When true, tapping an agent-emitted inline_keyboard button annotates " +
            "the source message body with a '✅ You chose: <label> · HH:MM' line so " +
            "the chat surface is self-documenting. Only applies to single-use " +
            "keyboards (re-tappable keyboards are never annotated). Requires the " +
            "agent's parseMode to be the default 'html'. Opt-in (default false). " +
            "Limitation: the annotated body is rebuilt from the message's plain " +
            "text, so any formatting entities (bold, links, code, ...) on the " +
            "original message are lost when the annotation is applied."
          ),
        format: z
          .string()
          .default("✅ You chose: {label} · {time}")
          .describe(
            "Template for the annotation line. `{label}` is replaced with the " +
            "tapped button's text (newlines stripped, HTML-escaped, trimmed to 60 " +
            "chars) and `{time}` with HH:MM in the chosen timezone. Note: retap " +
            "dedup (replacing a prior annotation instead of appending another " +
            "line) only recognizes the DEFAULT format shape — a custom format " +
            "accumulates one line per retap."
          ),
        timezone: z
          .enum(["gateway", "utc"])
          .default("gateway")
          .describe(
            "Timezone for the {time} placeholder. 'gateway' uses the gateway " +
            "process's local time; 'utc' uses UTC. Per-user timezones are out of " +
            "scope for v1."
          ),
      })
      .optional()
      .describe(
        "Auto-confirm 'You chose: X' annotation on inline_keyboard taps (#789). " +
        "Cascades from defaults.channels.telegram.button_choice_confirmation."
      ),
    webhook_sources: z
      .array(z.enum(["github", "generic", "linear"]))
      .optional()
      .describe(
        "External webhook sources allowed to ingest events into this agent's " +
        "log. POST /webhook/<agent>/<source> on the switchroom web server. " +
        "Each source has its own signature verification ('github' = " +
        "X-Hub-Signature-256 HMAC-SHA256, 'generic' = Bearer token, " +
        "'linear' = Linear-Signature bare-hex HMAC-SHA256 of the raw body). " +
        "Per-source secret read from ~/.switchroom/webhook-secrets.json " +
        "keyed by [agent][source]. Verified events append to " +
        "<agent>/telegram/webhook-events.jsonl for the agent to read on " +
        "demand. Off by default — webhook is the only untrusted-inbound " +
        "surface in the system, so opt-in is mandatory. " +
        "Cascades from defaults.channels.telegram.webhook_sources. " +
        "(Migrated from per-agent root in #596 — see #577.)",
      ),
    webhook_dispatch: z
      .object({
        github: z.array(webhookDispatchRule).optional(),
        generic: z.array(webhookDispatchRule).optional(),
        linear: z.array(webhookDispatchRule).optional(),
      })
      .optional()
      .describe(
        "Auto-dispatch rules: when a verified webhook event matches a rule, " +
        "inject the rendered prompt into the agent's live session (#1625). " +
        "Rules are keyed by source — 'github', 'generic', or 'linear' (#2272). " +
        "Supports cooldowns, quiet hours, label/action matchers, and (for " +
        "linear/generic) assignee_any / mentions_any matchers. " +
        "Off by default — opt in per agent. See src/web/webhook-dispatch.ts.",
      ),
    webhook_rate_limit: z
      .object({
        rpm: z.number().int().positive(),
      })
      .optional()
      .describe(
        "Per-source rate limit for the webhook ingest path (#714). " +
        "Off by default — when this key is absent the handler skips " +
        "rate-limit checks entirely. Opt in by setting `rpm` to an " +
        "integer requests-per-minute (token bucket per (agent, source); " +
        "burst equal to rpm). When enabled, exceeding the limit returns " +
        "429 with Retry-After header; first throttle event per " +
        "(agent, source) per 60s window is written to " +
        "<agent>/telegram/issues.jsonl. " +
        "Cascades from defaults.channels.telegram.webhook_rate_limit.",
      ),
    webhook_via_gateway: z
      .boolean()
      .optional()
      .describe(
        "Route verified webhook events to the agent's in-container gateway " +
        "over a peercred-gated UDS (<agent>/telegram/webhook.sock) instead " +
        "of having the host-side web receiver write the agent dir directly. " +
        "Required under the Docker runtime: the receiver runs as the host " +
        "operator UID and cannot write the per-agent-UID-owned agent dir " +
        "(EACCES 500) nor connect the gateway socket. When true the gateway " +
        "(running as the agent UID) becomes the sole writer of " +
        "webhook-events.jsonl + dedup/cooldown state and also fires " +
        "webhook_dispatch. Off by default for back-compat with host-runtime " +
        "installs. See reference/rfcs/webhook-via-gateway-socket.md.",
      ),
    webhook_require_edge: z
      .boolean()
      .optional()
      .describe(
        "Cloudflare-only edge lock: require the X-Switchroom-Edge header " +
        "(injected by a Cloudflare Transform Rule on hooks.switchroom.ai) to " +
        "match the operator's edge secret at ~/.switchroom/webhook-edge-secret " +
        "before any HMAC verification; reject 403 otherwise. Proves the " +
        "request entered through our Cloudflare edge — the per-agent HMAC " +
        "alone can't (it proves body provenance, not network path). Stacks " +
        "on the GitHub-IP WAF + per-agent HMAC. Fail-closed: when required " +
        "but the secret file is missing/empty every request is rejected. Off " +
        "by default. See reference/rfcs/webhook-cloudflare-edge-lock.md.",
      ),
    linear_agent: z
      .object({
        enabled: z.boolean(),
        token: z
          .string()
          .describe(
            "vault:<key> reference to the Linear OAuth app token (actor=app). " +
            "Resolved at runtime via the vault broker (canonically " +
            "vault:linear/<agent>/token). Never an inline literal.",
          ),
        workspace_id: z
          .string()
          .optional()
          .describe(
            "Optional Linear workspace (organization) id this agent is " +
            "installed into. Informational — used for setup hints and " +
            "multi-workspace disambiguation; the token already scopes the " +
            "app to its workspace.",
          ),
        default_team_id: z
          .string()
          .optional()
          .describe(
            "Optional Linear team id new captured issues file into when the " +
            "agent doesn't pass an explicit team_id. Unnecessary for a " +
            "single-team workspace (auto-resolved); set it only when the " +
            "workspace has multiple teams. Manage via " +
            "`switchroom linear-agent set-team <agent> <team>`.",
          ),
      })
      .optional()
      .describe(
        "Linear first-class agent integration (#2298). When enabled, the " +
        "agent appears in a Linear workspace as an app actor (own name/" +
        "avatar, @-mentionable, delegate-assignable). Linear AgentSessionEvent " +
        "webhooks (mention / delegation) wake the agent instantly via the " +
        "same gateway inject path as webhook_dispatch, tagged " +
        "meta.source=\"linear\" with the agent_session_id, and the agent " +
        "responds with structured AgentActivity (thought/message/complete/" +
        "error) via the linear_agent_activity MCP tool. Builds the " +
        "session-lifecycle layer on top of the plain webhook_sources:[linear] " +
        "+ webhook_dispatch support (#2272). The OAuth app token is stored in " +
        "the vault and referenced here as vault:linear/<agent>/token; run " +
        "`switchroom linear-agent setup <agent>` to provision it. Off by " +
        "default — opt in per agent. Cascades from " +
        "defaults.channels.telegram.linear_agent.",
      ),
    // ─── Supergroup-owned mode (RFC reference/rfcs/supergroup-mode.md) ──────
    // Per-agent override of the fleet-wide telegram.forum_chat_id.
    // When set, this agent owns its own supergroup with forum topics
    // (the new third topology, alongside fleet-shared and dm_only).
    // Mode is implied by config shape — no separate `mode:` enum.
    chat_id: z
      .string()
      .regex(/^-\d+$/, "supergroup chat_id must be a negative integer as a string (e.g. \"-1001234567890\")")
      .optional()
      .describe(
        "Per-agent supergroup ID — overrides fleet `telegram.forum_chat_id`. " +
        "When set, requires `default_topic_id`. Negative integer as string. " +
        "Forbidden when `dm_only: true`. See reference/rfcs/supergroup-mode.md.",
      ),
    default_topic_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Forum topic ID this agent's automated outbounds default to when " +
        "no more-specific alias resolves. Defaults to General (topic 1) when " +
        "`chat_id` is set and this is omitted — set it only to pin a different " +
        "fallback topic. " +
        "Telegram's General topic is `id=1` at MTProto but sends omit the " +
        "field — the outbound wrapper strips `message_thread_id === 1` " +
        "on send. Forbidden when `dm_only: true`.",
      ),
    topic_aliases: z
      .record(z.string(), z.number().int().positive())
      .optional()
      .describe(
        "Operator-friendly names for forum topic IDs (e.g. " +
        "`{ general: 1, planning: 17, cron: 23, admin: 31, alerts: 41 }`). " +
        "Referenced from per-cron `topic:` fields and the outbound router " +
        "for autonomous events (boot → alerts, hostd → admin, etc.). " +
        "Cascades per-key through defaults → profile → agent.",
      ),
  })
  .optional()
  .superRefine((tg, ctx) => {
    if (!tg) return;
    // Smart default (P2): `chat_id` no longer *requires* `default_topic_id`
    // — it falls back to General below. We only reject the reverse
    // (default_topic_id without chat_id) which is meaningless.
    if (tg.default_topic_id != null && tg.chat_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`channels.telegram.default_topic_id` requires `chat_id` — default_topic_id is only meaningful when the agent owns its own supergroup.",
        path: ["chat_id"],
      });
    }
    if (tg.topic_aliases != null && tg.chat_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`channels.telegram.topic_aliases` requires `chat_id` — aliases only resolve in supergroup-owned mode.",
        path: ["topic_aliases"],
      });
    }
  })
  .transform((tg) => {
    // Smart default: a supergroup-owned agent (chat_id set) that doesn't pin
    // a default topic falls back to General (topic 1 — the outbound wrapper
    // strips thread_id===1 on send). Keeps the easy path zero-config (P2):
    // the operator sets only `chat_id` and the agent answers, with proactive
    // posts defaulting to General.
    if (tg && tg.chat_id != null && tg.default_topic_id == null) {
      return { ...tg, default_topic_id: 1 };
    }
    return tg;
  });

/**
 * Buzz (Nostr) co-channel — Phase 1 inbound fan-in.
 *
 * A per-agent sidecar (`src/buzz-gateway/`) opens a WebSocket Nostr
 * subscription to a closed Buzz relay, NIP-42-authenticates, and injects
 * allowlisted messages onto the agent's gateway socket as synthesized turns
 * (`meta.source="buzz"`), exactly like the cron sidecar. Phase 1 is
 * INBOUND-ONLY — replies land on Telegram (the authoritative surface).
 *
 * Default OFF: an absent `channels.buzz` block, or `enabled: false`, means
 * start.sh never forks the sidecar and the fleet behaviour is byte-identical
 * to pre-Buzz. Nothing here self-deploys.
 *
 * Security model (fail-closed): every inbound event must pass BOTH signature
 * verification (`verifyEvent`) AND membership of the effective allowlist
 * (`authorized_pubkeys` ∪ `{operator_pubkey}`, hex-normalized) before it can
 * become a turn. The default allowlist is operator-only.
 */
export const BuzzChannelSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Master switch for the per-agent Buzz sidecar. Default false — the " +
        "channel ships dark; start.sh forks the sidecar only when true.",
      ),
    relay_url: z
      .string()
      .regex(/^wss?:\/\//, "relay_url must be a ws:// or wss:// URL")
      .describe(
        "CANONICAL WebSocket URL of the closed Buzz relay — the exact string " +
        "the relay expects in the NIP-42 `relay` auth tag (e.g. " +
        "'ws://127.0.0.1:3000'). A live probe proved the relay validates this " +
        "tag as an exact string match against its own URL BEFORE the " +
        "membership check, so it is the relay's advertised identity, NOT " +
        "necessarily the address the sidecar dials. Set relay_dial_url when " +
        "the reachable address differs (a docker-network IP).",
      ),
    // The sidecar's container cannot reach the relay's own 127.0.0.1 loopback,
    // so when the relay's canonical identity (relay_url) is a loopback/host
    // address, the sidecar must DIAL a docker-network address instead while
    // still TAGGING the canonical relay_url. relay_dial_url carries that dial
    // address; absent → the sidecar dials relay_url directly (correct when the
    // canonical URL is itself reachable from the sidecar).
    relay_dial_url: z
      .string()
      .regex(/^wss?:\/\//, "relay_dial_url must be a ws:// or wss:// URL")
      .optional()
      .describe(
        "Reachable ws:// / wss:// address the sidecar DIALS when it differs " +
        "from the canonical relay_url (e.g. a docker-network IP the relay's " +
        "own 127.0.0.1 can't stand in for). The NIP-42 auth tag still uses " +
        "relay_url. Defaults to relay_url when unset.",
      ),
    // Phase 0 blocker #2 / coordinator directive (2026-08-03, verified live):
    // the relay resolves its community from the HTTP Host header BEFORE the WS
    // upgrade and fail-closes — a missing/wrong Host returns HTTP 404 "relay: no
    // community is configured for this host" and the socket never upgrades.
    // Community host is server-internal (resolved from RELAY_URL) and therefore
    // effectively immutable, so the Host is deployment config, NOT derived at
    // runtime: it is a REQUIRED, validated authority field. `normalize_host`
    // strips only :443/:80, so the value is sent verbatim (port included).
    relay_host: z
      .string()
      .regex(
        /^(\[[0-9a-fA-F:]+\]|[^\s/?#:@]+)(:\d+)?$/,
        "relay_host must be a bare host[:port] authority — no scheme, path, or userinfo (e.g. '127.0.0.1:3000')",
      )
      .describe(
        "REQUIRED HTTP Host header authority sent verbatim on the WS upgrade " +
        "(e.g. '127.0.0.1:3000', port included). The relay resolves its " +
        "community from this header before the upgrade and returns HTTP 404 if " +
        "it is missing/wrong, so it must match the relay's configured " +
        "authority and is deployment config, never derived from the dial URL.",
      ),
    nsec_vault_key: z
      .string()
      .default("buzz/{agent}-nsec")
      .describe(
        "Vault KEY NAME for the agent's Nostr secret key. Broker-fetched " +
        "in-process at sidecar boot; NEVER resolved into env or logged. " +
        "'{agent}' is substituted with the agent name.",
      ),
    operator_pubkey: z
      .string()
      .regex(
        /^(npub1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})$/,
        "operator_pubkey must be a bech32 npub or 64-char hex pubkey",
      )
      .describe(
        "The operator's Nostr pubkey (npub or hex). Always in the effective " +
        "inbound allowlist — the fail-closed default is operator-only.",
      ),
    authorized_pubkeys: z
      .array(z.string())
      .default([])
      .describe(
        "Additional pubkeys (npub or hex) whose signed events may become " +
        "turns. Effective allowlist = this ∪ {operator_pubkey}. Empty by " +
        "default (operator-only).",
      ),
    mirror: z
      .enum(["both", "origin", "off"])
      .default("both")
      .describe(
        "Cross-surface mirror mode. 'both' answers on the origin channel AND " +
        "mirrors a copy to the other; 'off' is a true kill-switch that disables " +
        "the channel in BOTH directions (the inbound sidecar exits idle). " +
        "Phase 2b (S2): 'origin' is DEFERRED — the hub's mirror hook lives only " +
        "in sendReply, so 'origin' cannot be honored soundly; a configured " +
        "'origin' is degraded to 'off' (dark) at runtime by both the sidecar " +
        "config loader and the hub (channel-route.ts parseConfiguredMirrorMode). " +
        "Only 'both' and 'off' ship live in 2b.",
      ),
    chat_id: z
      .string()
      .min(1, "chat_id must be a non-empty Telegram chat id")
      .describe(
        "Telegram chat id an injected Buzz turn is routed to. Phase 1 is " +
        "inbound-only, so the agent's reply lands here on Telegram (the " +
        "authoritative surface); in later phases this is the chat the Buzz " +
        "turn's Telegram copy maps to. Required — the sidecar refuses to run " +
        "live without it (BUZZ_CHAT_ID).",
      ),
    default_channel_id: z
      .string()
      .describe(
        "Relay-minted group UUID (the NIP-29 `h` tag) the sidecar subscribes " +
        "to and stamps on injected turns.",
      ),
    channel_map: z
      .record(z.string(), z.string())
      .default({})
      .describe("Optional map of extra group UUIDs → friendly labels."),
    pubkey_names: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Optional petnames: hex/npub pubkey → display name, used to label " +
        "the sender on injected turns.",
      ),
    pinned_relay_digest: z
      .string()
      .optional()
      .describe(
        "Pinned relay image digest (M4). RESERVED — no consumer of this field " +
        "exists; the existing compat-check (compat-check.ts) validates only " +
        "the wire contract (AUTH kind, message kind, tag names) and does not " +
        "read this field. Kept in the schema so the intended digest-pin can " +
        "be wired without a config shape change.",
      ),
  })
  .strict();

export const ChannelsSchema = z
  .object({
    telegram: TelegramChannelSchema,
    buzz: BuzzChannelSchema.optional(),
  })
  .optional();

/**
 * A Profile is a named bundle of config that agents inherit from via
 * `extends: <name>`. Profiles can be defined two ways:
 *
 *   1. Inline in switchroom.yaml under top-level `profiles: { name: {...} }`
 *   2. As a filesystem directory at `profiles/<name>/` inside the
 *      switchroom repo, containing CLAUDE.md.hbs + SOUL.md.hbs + skills/
 *
 * Inline profiles take priority when both exist with the same name.
 *
 * The schema is the same shape as AgentDefaultsSchema below — every
 * field is optional, no zod defaults — because a profile is literally
 * "a partial agent config". AgentDefaultsSchema is a specialization
 * (the implicit profile that applies to ALL agents).
 *
 * Per-agent-identity fields (topic_name, topic_emoji, topic_id) are
 * intentionally excluded from profiles for the same reason they're
 * excluded from defaults — defaulting a topic name across multiple
 * agents would collapse them onto the same Telegram thread.
 */
/**
 * Rough IANA timezone validator. Accepts canonical Region/City (and
 * Region/Sub/City, e.g. America/Argentina/Buenos_Aires) plus the bare
 * "UTC" string. Explicitly rejects three-letter aliases (EST, PST),
 * bare offsets (UTC+10, +10:00), and empty strings — those are exactly
 * the values that mislead the `date` CLI and Claude Code's clocks in
 * subtle ways on edge-case hosts (Windows-style aliases, containers
 * inheriting a broken $TZ).
 *
 * The pattern is:
 *   - exactly "UTC", OR
 *   - at least one "/"-separated segment group, each segment starting
 *     with a capital and containing [A-Za-z0-9_+-] thereafter.
 *
 * The inner class includes `+-` and `0-9` so real IANA zones like
 * `Etc/GMT+1`, `Etc/GMT-10`, and `America/Port-au-Prince` are accepted.
 * Bare offsets like `UTC+10` and `+10:00` are still rejected because
 * the first (anchored) alternative requires exactly "UTC" and the
 * second requires a capital-letter prefix followed by at least one "/".
 *
 * The "/" requirement is what excludes EST / PST / MST — they have no
 * slash, they aren't "UTC", so they're out. Any real IANA zone carries
 * at least a Region/City pair.
 *
 * Not exhaustive: we don't ship the IANA database itself. If `date -u`
 * accepts a name we reject, add it to the pattern. Cheap validator here
 * beats a 600KB zone bundle we'd never refresh.
 */
const TIMEZONE_REGEX = /^UTC$|^[A-Z][A-Za-z0-9_+-]+(\/[A-Z][A-Za-z0-9_+-]+){1,2}$/;

/**
 * Public predicate over the same `TIMEZONE_REGEX` the `timezone` zod
 * fields validate with. Exported so non-schema callers (the setup
 * wizard's interactive timezone prompt, #2483) validate a hand-typed
 * IANA zone against the exact same rule the config schema enforces,
 * instead of re-deriving a looser one that drifts.
 */
export function isValidTimezone(value: string): boolean {
  return TIMEZONE_REGEX.test(value);
}

const ApproverIdSchema = z.union([z.number(), z.string().regex(/^\d+$/)]);

/**
 * RFC G Phase 1: tier knob for the Google Workspace MCP surface.
 *
 * Maps directly to upstream `google_workspace_mcp`'s `--tool-tier` flag.
 *   - core     ~16 tools: Drive + Docs + Sheets + Calendar (default)
 *   - extended ~40 tools: + Slides, Forms, Tasks, Chat
 *   - complete ~60+ tools: + Gmail (note: Gmail's per-thread approval
 *     shape is unsuitable here today — see RFC G §5 out-of-scope)
 *
 * NOTE the tier governs which TOOLS upstream exposes, not which scopes
 * the minted token carries. Calendar tools in particular are exposed at
 * every tier but only authenticate when the account was consented with
 * the calendar scope (`account add --calendar`, or `cal` in the
 * per-account `services` selection) — no tier mints it by default. The
 * per-account `google_accounts.<email>.{readonly,services}` selection
 * is what keeps tool exposure and token scope in agreement.
 *
 * RFC D shipped without this knob (hardcoded to upstream's full surface
 * via the no-flag default). Phase 1 makes the tier explicit at the
 * config level; Phase 3 wires it through the MCP launcher.
 */
export const GoogleWorkspaceTierSchema = z.enum([
  "core",
  "extended",
  "complete",
]);
export type GoogleWorkspaceTier = z.infer<typeof GoogleWorkspaceTierSchema>;

/**
 * One selectable Google service in the per-account scope selection
 * (v1 read-only scope model). Short tokens are the config + CLI
 * vocabulary; the gdrive MCP launcher maps them to upstream
 * `workspace-mcp --tools` service names (`cal` → `calendar`).
 *
 * A closed enum (unlike `MicrosoftToolTokenSchema`'s regex): Microsoft
 * tokens feed a runtime-built regex where the charset is the guard,
 * these feed a fixed service→scope map where an unknown token would be
 * silently inert — reject it at parse time instead. MUST stay in sync
 * with `GOOGLE_SERVICES` in src/cli/drive.ts (unit-pinned there).
 *
 * v1 is READ-surface-selection only: gmail, per-service write levels,
 * and `calendar.events.readonly` are deliberate follow-ups.
 */
export const GoogleServiceTokenSchema = z.enum([
  "cal",
  "drive",
  "docs",
  "sheets",
  "slides",
]);
export type GoogleServiceToken = z.infer<typeof GoogleServiceTokenSchema>;

/**
 * Top-level drive / google_workspace config block. Centralizes Google OAuth
 * client credentials, the approver allowlist used by `switchroom drive
 * connect`, and (RFC G Phase 1) the tier knob.
 *
 * Block is optional — when omitted, the CLI falls back to env vars
 * (SWITCHROOM_GOOGLE_CLIENT_ID/_SECRET, SWITCHROOM_APPROVER_USER_ID). When
 * both are set, env wins (deliberate: env is for one-off overrides;
 * config is the persistent baseline).
 *
 * **Naming note (RFC G Phase 1):** This schema is exported under both
 * `DriveConfigSchema` (legacy / RFC D name, deprecated alias) and
 * `GoogleWorkspaceConfigSchema` (RFC G canonical name). The shape is
 * identical; the loader accepts either YAML key. Phase 3 will rename
 * the user-facing key in docs + scaffold templates while keeping the
 * alias indefinitely (no pre-announced removal — switchroom's installed
 * base is small enough that a hard removal date isn't earned).
 */
export const GoogleWorkspaceConfigSchema = z
  .object({
    google_client_id: z
      .string()
      .min(1)
      .describe(
        "Google OAuth client ID (literal string or vault reference e.g. 'vault:google-oauth-client-id')"
      ),
    google_client_secret: z
      .string()
      .min(1)
      .describe(
        "Google OAuth client secret (literal string or vault reference e.g. 'vault:google-oauth-client-secret')"
      ),
    approvers: z
      .array(ApproverIdSchema)
      .min(1)
      .describe(
        "Array of numeric Telegram user IDs authorized to approve drive onboarding. " +
        "At least one must be specified."
      ),
    tier: GoogleWorkspaceTierSchema.optional().describe(
      "RFC G Phase 1: which upstream MCP tier to expose. " +
      "core (default) = ~16 tools (Drive+Docs+Sheets+Calendar tools; the " +
      "Calendar tools only authenticate when the account holds the opt-in " +
      "calendar scope — no tier mints it). " +
      "extended = ~40 tools (+Slides, Forms, Tasks, Chat). " +
      "complete = ~60+ tools (+Gmail; not recommended yet — see RFC G §5)."
    ),
  })
  .optional();

/**
 * Legacy alias for back-compat with RFC D shipped config. Identical shape;
 * kept exported so existing imports + tests keep working. New code should
 * prefer `GoogleWorkspaceConfigSchema`.
 */
export const DriveConfigSchema = GoogleWorkspaceConfigSchema;

/**
 * LiteLLM routing block — opt-in per-agent virtual-key auto-provisioning.
 *
 * When `enabled: true` on an agent (or fleet-wide via the top-level block),
 * `switchroom apply` provisions a per-agent LiteLLM virtual key inside a
 * "switchroom" LiteLLM team, stores it in the vault at
 * `litellm/<agent>/api-key`, grants the agent read-ACL (adds the key to the
 * agent's standing `secrets[]`), and the agent container is injected with
 * LiteLLM routing env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_SMALL_FAST_MODEL`,
 * `SWITCHROOM_LITELLM`). start.sh then exports the key as an
 * `ANTHROPIC_CUSTOM_HEADERS` Bearer so the unmodified `claude` CLI routes
 * non-Anthropic models through the LiteLLM proxy. The broker OAuth path for
 * Anthropic itself is untouched — subscription-funded Anthropic, proxy for
 * other models.
 *
 * Every field is optional. Default OFF (the block's absence or `enabled`
 * falsey = zero behavioural change). The same shape appears at three
 * cascade levels — defaults/profiles, per-agent, and top-level (global
 * infra: base_url/admin_key/team/small_fast_model + fleet default
 * `enabled`).
 */
export const LiteLLMConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Opt-in toggle. When true, `switchroom apply` provisions a per-agent " +
        "LiteLLM virtual key and injects routing env into the container. " +
        "Default OFF.",
      ),
    base_url: z
      .string()
      .optional()
      .describe(
        "LiteLLM proxy base URL the agent's claude CLI routes through, e.g. " +
        "'http://127.0.0.1:4010'. Agents use network_mode:host, so loopback " +
        "reaches a host-bound proxy. Exported as ANTHROPIC_BASE_URL.",
      ),
    admin_key: z
      .string()
      .optional()
      .describe(
        "LiteLLM master/admin key used at apply time to provision the team + " +
        "virtual key. Supports a vault reference (e.g. " +
        "'vault:litellm/master-key') — resolution happens at apply time via " +
        "the vault-broker. Never injected into the agent container.",
      ),
    team: z
      .string()
      .optional()
      .describe(
        "LiteLLM team alias the per-agent key is created under. Defaults to " +
        "'switchroom' (applied in code, not as a schema default).",
      ),
    small_fast_model: z
      .string()
      .optional()
      .describe(
        "Model id exported as ANTHROPIC_SMALL_FAST_MODEL for the claude CLI's " +
        "background/fast lane, e.g. 'claude-haiku-4-5-20251001'.",
      ),
    tags: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Extra key/value metadata tags attached to the provisioned LiteLLM " +
        "virtual key. Merged per-key across cascade layers (agent wins).",
      ),
    max_budget: z
      .number()
      .positive()
      .optional()
      .describe(
        "HARD spend cap in USD for this agent's virtual key over one " +
        "`budget_duration` window. LiteLLM refuses the request once the key's " +
        "tracked spend exceeds it, so a runaway loop costs at most this much " +
        "before it is stopped. Defaults to " +
        "DEFAULT_KEY_MAX_BUDGET_USD (see src/litellm/budget.ts) — deliberately " +
        "conservative; raise it per-agent rather than removing it. Set 0 or " +
        "omit `budget_duration` at your own risk: an uncapped key is only as " +
        "bounded as the upstream account balance.",
      ),
    soft_budget: z
      .number()
      .positive()
      .optional()
      .describe(
        "ADVISORY spend threshold in USD. LiteLLM keeps serving past it and " +
        "raises a budget alert instead. Must be < max_budget. NOTE: LiteLLM " +
        "accepts soft_budget only on POST /key/generate (GenerateKeyRequest); " +
        "UpdateKeyRequest does NOT carry it, so changing this value only takes " +
        "effect on a key that is (re)generated, not on an existing one.",
      ),
    budget_duration: z
      .string()
      .regex(
        /^\d+(s|m|h|d|mo)$/,
        "budget_duration must be a LiteLLM duration like '30d', '24h', '1mo'",
      )
      .optional()
      .describe(
        "Rolling window the budget resets on, in LiteLLM duration syntax " +
        "('30d', '24h', '1mo'). Defaults to DEFAULT_KEY_BUDGET_DURATION. " +
        "WITHOUT a duration LiteLLM treats max_budget as a LIFETIME cap that " +
        "never resets — the key silently dies for good once it is hit.",
      ),
  })
  .optional()
  .describe(
    "LiteLLM routing config — opt-in per-agent virtual-key auto-provisioning " +
    "+ routing env. Default OFF. See LiteLLMConfigSchema doc for the full flow.",
  );

/**
 * Fleet-singleton Hindsight (memory backend) configuration.
 *
 * Hindsight runs as a single shared container, so this is a top-level block
 * (a fleet singleton like `litellm:` / `fleet_health:`), NOT a per-agent /
 * per-profile knob. Today the only field is `llm`: the provider + model the
 * container uses for its LLM operations (retain / reflect / consolidation —
 * recall is local-only, no LLM). Both sub-fields are optional; when either is
 * absent, `startHindsight()` (src/setup/hindsight.ts) falls back to the
 * hard-coded defaults (provider=claude-code, model=HINDSIGHT_DEFAULT_MODEL) so
 * an operator who never sets this sees the exact prior behaviour.
 *
 * When `provider` is `claude-code` (the subscription-honest default), the
 * container also inherits `ANTHROPIC_MODEL=<model>` so the underlying claude
 * subprocess (and any LiteLLM proxy it routes through) targets the same model.
 */
export const HindsightPerOpLlmSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Per-op model (upstream `HINDSIGHT_API_<OP>_LLM_MODEL`). Absent → " +
        "inherit the global `hindsight.llm.model`.",
      ),
    provider: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Per-op provider (upstream `HINDSIGHT_API_<OP>_LLM_PROVIDER`). " +
        "Absent → inherit the global `hindsight.llm.provider`.",
      ),
    base_url: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Per-op base URL (upstream `HINDSIGHT_API_<OP>_LLM_BASE_URL`). " +
        "Optional passthrough; absent → inherit the global.",
      ),
    api_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Per-op API key (upstream `HINDSIGHT_API_<OP>_LLM_API_KEY`). Literal " +
        "or `vault:` reference. Optional passthrough; absent → inherit global.",
      ),
    context_window: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Context window (tokens) of the backend serving THIS op. NOT an " +
        "upstream env var — switchroom derives the op's token budget " +
        "(consolidation batch size / max-completion caps / reflect " +
        "max-context cap) from it so a single call can never overflow the " +
        "window. Absent → inherit " +
        "`hindsight.llm.context_window`, else a per-provider default " +
        "(conservative for non-`claude-code` providers, which usually mean " +
        "a local llama.cpp/Ollama slot; a self-hosted `base_url` — loopback, " +
        "RFC1918, `.local`/`.internal` — forces the conservative default too, " +
        "regardless of the provider NAME, since the endpoint is where the " +
        "traffic actually terminates). All three lanes (`retain`, " +
        "`reflect`, `consolidation`) are budgeted independently.",
      ),
  })
  .describe(
    "Per-operation LLM override. Every field optional; an unset field (or " +
    "an omitted op block) inherits the global `hindsight.llm.*`, which is " +
    "already the engine's fallback — switchroom emits only the vars set.",
  );

export const HindsightConfigSchema = z.object({
  gpu: z
    .boolean()
    .optional()
    .describe(
      "Force GPU passthrough for the hindsight container on (`true`) or off " +
      "(`false`), overriding host autodetection in BOTH directions. Absent " +
      "(the default) → autodetect from the persisted host-capabilities " +
      "verdict (`~/.switchroom/host-capabilities.json`), which enables " +
      "`--gpus all` only when that file proves BOTH a GPU and the nvidia " +
      "container toolkit. Set `true` when that verdict is wrong or unreadable " +
      "and you know the host has a working toolkit — switchroom cannot verify " +
      "it for you, and `docker run --gpus all` hard-fails container create on " +
      "a host without one. Set `false` to pin the container to CPU on a GPU " +
      "host. This is also the declarative opt-out for the recreate-time GPU " +
      "drop guard (`switchroom memory setup --recreate` refuses to silently " +
      "turn a GPU container into a CPU one). `--gpu`/`--no-gpu` on `memory " +
      "setup` override this for a single run.",
    ),
  cp_access_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Access key for the hindsight control-plane DASHBOARD (upstream " +
      "`HINDSIGHT_CP_ACCESS_KEY`, port 9999). Literal or — strongly preferred " +
      "— a `vault:` reference such as `vault:hindsight_cp_access_key`, read " +
      "through the broker at container-launch time. This is the ONLY thing " +
      "that arms the dashboard's login: upstream's middleware short-circuits " +
      "to `next()` when the var is unset, so an unset key means the dashboard " +
      "has no authentication at all, not weak authentication. Because of that, " +
      "leaving it unset is FAIL-CLOSED: switchroom pins " +
      "`HINDSIGHT_CP_HOSTNAME=127.0.0.1` so the loginless dashboard is " +
      "reachable only from the host, and warns. Set this to serve the " +
      "dashboard on the LAN/tailnet.",
    ),
  llm: z
    .object({
      provider: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Hindsight LLM provider (upstream `HINDSIGHT_API_LLM_PROVIDER`). " +
          "Defaults to `claude-code` (subscription-honest, broker-fed OAuth). " +
          "Any litellm-routable provider the upstream image supports is valid. " +
          "Serves as the GLOBAL default for every op absent a per-op override.",
        ),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Hindsight LLM model (upstream `HINDSIGHT_API_LLM_MODEL`). Defaults " +
          "to HINDSIGHT_DEFAULT_MODEL. Any model your LiteLLM proxy can route " +
          "is valid, e.g. `openrouter/z-ai/glm-5.2` when routing through the " +
          "fleet proxy. With provider=claude-code this value is ALSO exported " +
          "as `ANTHROPIC_MODEL` to the claude subprocess. Serves as the GLOBAL " +
          "default for every op absent a per-op override.",
        ),
      context_window: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "GLOBAL context window (tokens) of the backend serving hindsight's " +
          "LLM ops — the declared size switchroom derives every token budget " +
          "from. Set this to the real window of whatever you point " +
          "`hindsight.llm` at (e.g. 32768 for a llama.cpp slot launched with " +
          "`-c 65536 -np 2`, 131072 for a large-window OpenRouter model). " +
          "Absent → a per-provider default: 200000 for `claude-code`, a " +
          "conservative 32768 for everything else. Overflowing a local " +
          "backend's window does NOT error — llama.cpp context-shift silently " +
          "drops the system prompt and the model answers conversationally " +
          "with HTTP 200 — so this value is what makes the failure " +
          "detectable at setup time instead of never.",
        ),
      base_url: z
        .string()
        .min(1)
        .optional()
        .describe(
          "GLOBAL LLM base URL (upstream `HINDSIGHT_API_LLM_BASE_URL`). The " +
          "default endpoint every op inherits absent a per-op " +
          "`hindsight.llm.<op>.base_url`. Optional passthrough; unset → the " +
          "engine's provider default. When this points at host loopback the " +
          "hindsight container is forced onto host networking, same as a " +
          "per-op base URL, so the endpoint stays reachable (#3687).",
        ),
      api_key: z
        .string()
        .min(1)
        .optional()
        .describe(
          "GLOBAL LLM API key (upstream `HINDSIGHT_API_LLM_API_KEY`). Literal " +
          "or `vault:` reference. The default credential every op inherits " +
          "absent a per-op `hindsight.llm.<op>.api_key`; the engine reads it as " +
          "a plain env fallback. Optional passthrough (#3687).",
        ),
      retain: HindsightPerOpLlmSchema.optional().describe(
        "Per-op override for the `retain` LLM op (memory ingestion). Emits " +
        "`HINDSIGHT_API_RETAIN_LLM_*`. Absent → uses the global model/provider.",
      ),
      reflect: HindsightPerOpLlmSchema.optional().describe(
        "Per-op override for the `reflect` LLM op (synthesis / mental-model " +
        "refresh). Emits `HINDSIGHT_API_REFLECT_LLM_*`. Absent → uses global.",
      ),
      consolidation: HindsightPerOpLlmSchema.optional().describe(
        "Per-op override for the `consolidation` LLM op (background memory " +
        "merge). Emits `HINDSIGHT_API_CONSOLIDATION_LLM_*`. Absent → global.",
      ),
    })
    .optional()
    .describe(
      "LLM knob for the hindsight container. The flat `provider`/`model` set " +
      "the global default (backward-compatible); optional `retain`/`reflect`/" +
      "`consolidation` blocks override individual ops. All fields optional; " +
      "unset fields fall back to the hard-coded defaults.",
    ),
  env: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Operator overrides for switchroom's capability-gated Hindsight " +
      "performance defaults. Only the keys switchroom actually manages are " +
      "honoured (`HINDSIGHT_PERF_ENV_KEYS` in " +
      "src/setup/hindsight-perf-defaults.ts: RERANKER_LOCAL_FP16, " +
      "RERANKER_LOCAL_BATCH_SIZE, LLM_MAX_CONCURRENT, " +
      "RETAIN/CONSOLIDATION_LLM_MAX_CONCURRENT, LLM_STRICT_SCHEMA, " +
      "LLM_MAX_RETRIES, CONSOLIDATION_LLM_PARALLELISM, " +
      "MAX_OBSERVATIONS_PER_SCOPE, " +
      "RECALL_MAX_CANDIDATES_PER_SOURCE, LINK_EXPANSION_PER_ENTITY_LIMIT, " +
      "LINK_EXPANSION_TIMEOUT, LLM_REASONING_EFFORT, " +
      "RERANKER_LOCAL_BUCKET_BATCHING, RERANKER_MAX_CANDIDATES, " +
      "RERANKER_LOCAL_MAX_CONCURRENT, RECALL_MAX_CONCURRENT, " +
      "REFLECT_WALL_TIMEOUT, WORKER_CONSOLIDATION_RESERVED_SLOTS, " +
      "WORKER_CONSOLIDATION_SLOT_LIMIT, " +
      "CONSOLIDATION_MAX_MEMORIES_PER_ROUND, GRAPH_SEED_MIN_SIMILARITY, " +
      "LLM_SUPPORTS_MAX_ITEMS, RECENCY_DECAY_FUNCTION, " +
      "RECENCY_DECAY_HALFLIFE_DAYS — switchroom defaults recall's recency " +
      "curve to `exponential` with a 30-day half-life so a fact retained " +
      "today outranks a stale one, instead of upstream's near-flat " +
      "linear/365-day window), the override-only keys " +
      "switchroom manages but ships NO default for " +
      "(`HINDSIGHT_PERF_OVERRIDE_ONLY_KEYS`: " +
      "HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY — a per-deployment " +
      "`bank-pattern:priority,...` map; unset means upstream's flat " +
      "created_at FIFO across banks; and " +
      "HINDSIGHT_CE_DECISIVE_RELATIVE_GAP — the rollback knob for " +
      "switchroom's CE-saturation damping patch, a float; >= ~0.65 backs the " +
      "damping out entirely, unset means the patch's own derived gap; and " +
      "HINDSIGHT_API_RECENCY_DECAY_LINEAR_WINDOW_DAYS — only read when the " +
      "decay function is `linear`, so switchroom ships no default for it but " +
      "still honours an operator who flips the function back; and " +
      "HINDSIGHT_API_WORKER_MAX_SLOTS — the worker poller's TOTAL in-flight " +
      "task budget, the pool WORKER_CONSOLIDATION_RESERVED_SLOTS reserves out of; " +
      "unset means upstream's own default; and " +
      "HINDSIGHT_API_WORKER_RETAIN_RESERVED_SLOTS — the reserved slot FLOOR for the " +
      "retain (memory write) lane, carved from that same total; unset means " +
      "upstream's own 0, i.e. no floor and retain competes for the shared " +
      "pool; and " +
      "the pre-0.8.6 name HINDSIGHT_API_WORKER_<TYPE>_MAX_SLOTS is still " +
      "accepted for every operation type and normalised to " +
      "..._RESERVED_SLOTS on the way in, because setting both names for " +
      "one type is a hard boot failure in the engine and switchroom " +
      "therefore emits only the canonical name; and " +
      "HINDSIGHT_API_SEMANTIC_MIN_SIMILARITY — the cosine-similarity floor a " +
      "candidate must reach to be returned by the semantic retrieval arm at " +
      "all (0..1); unset means upstream's own 0.3, and where it should sit " +
      "depends on the bank's embedding model and phrasing diversity, so " +
      "switchroom ships no opinion; and " +
      "HINDSIGHT_MCP_RECALL_BUDGET_MODE — the rollback knob for switchroom's " +
      "mcp-recall-token-budget image patch; `legacy` restores upstream's " +
      "exact pre-patch recall returns, anything else or unset is the " +
      "honest-envelope mode; and " +
      "HINDSIGHT_API_LLM_TEMPERATURE_REFLECT — upstream's own per-op reflect " +
      "temperature knob, made live by switchroom's reflect-temperature image " +
      "patch; a float, or `none` to omit the kwarg (provider default, " +
      "upstream's accidental pre-patch behaviour); unset means the image's " +
      "baked default 0.1; and " +
      "HINDSIGHT_API_CONSOLIDATION_RECALL_MAX_CONCURRENT — the background " +
      "half of switchroom's recall-admission split (#3660): of the " +
      "RECALL_MAX_CONCURRENT admission slots, at most this many may be held " +
      "by background consolidation recalls at once, so foreground per-turn " +
      "recall always keeps the remainder; must be >= 1 and strictly less " +
      "than RECALL_MAX_CONCURRENT or the engine refuses to boot; unset " +
      "means the image's derived default min(2, RECALL_MAX_CONCURRENT - 1); " +
      "1 biases hard toward the interactive lane while a consolidation " +
      "backlog drains; and " +
      "HINDSIGHT_MM_REFRESH_MIN_INTERVAL_S — the rollback/tuning knob for " +
      "switchroom's MM-refresh-debounce image patch: the minimum seconds " +
      "between consolidation-triggered refreshes of one mental model; unset " +
      "means the image's baked 3600, 0 restores upstream's " +
      "refresh-every-round behaviour; explicit and cron-scheduled refreshes " +
      "are never debounced; and " +
      "HINDSIGHT_API_TEMPORAL_LANGUAGES — the language set dateparser is " +
      "restricted to during temporal query analysis, made live by switchroom's " +
      "temporal-language image patch (which ended a 200+-locale auto-detection " +
      "pass that blocked the shared asyncio loop on every recall); " +
      "comma-separated, unset means the image's baked `en`, set e.g. `en,es` to " +
      "restore i18n parsing; and " +
      "HINDSIGHT_API_TEMPORAL_MAX_QUERY_CHARS — the max chars of query text " +
      "dateparser.search_dates() is handed during temporal analysis (0 = " +
      "unlimited), made live by switchroom's temporal-offload image patch " +
      "(which moved the synchronous extraction off the shared asyncio loop onto " +
      "a single-worker thread and bounds its input, ending multi-second loop " +
      "stalls on multi-KB consolidation queries); unset means the image's baked " +
      "2000, set 0 to restore an unbounded full scan), plus the " +
      "embedded-PostgreSQL (pg0) sizing keys switchroom manages in " +
      "src/setup/hindsight-pg-defaults.ts (`HINDSIGHT_PG_ENV_KEYS`: " +
      "SWITCHROOM_HINDSIGHT_PG_EFFECTIVE_CACHE_SIZE, " +
      "SWITCHROOM_HINDSIGHT_PG_SHARED_BUFFERS — a postgres size string such " +
      "as `4GB`, or the sentinel `off` to leave pg0's own default for that " +
      "one knob). A value set here " +
      "REPLACES switchroom's default and is emitted even when the gating " +
      "capability is absent, so an operator can always force a knob. Other " +
      "`HINDSIGHT_API_*` keys are deliberately IGNORED — a blanket " +
      "passthrough would collide with the vars startHindsight() derives " +
      "itself (HINDSIGHT_API_PORT, the retain token/deadline budget).",
    ),
});

/**
 * Top-level microsoft_workspace config block — RFC #1873 (Microsoft 365
 * integration). Centralizes Microsoft OAuth client credentials and the
 * org-mode opt-in.
 *
 * Block is optional — when omitted, the broker simply doesn't register
 * the Microsoft provider, and any agent with `microsoft_workspace:` config
 * gets a clear "MS not configured" error.
 *
 * The OAuth app is a single multi-tenant Entra registration with
 * `signInAudience: AzureADandPersonalMicrosoftAccount` — one operator
 * registration covers both personal MSA and M365 work accounts via the
 * `/common` authority endpoint (per RFC §4.1).
 */
export const MicrosoftWorkspaceConfigSchema = z
  .object({
    microsoft_client_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Microsoft OAuth application (client) ID from Entra portal " +
        "(literal string or vault reference e.g. " +
        "'vault:microsoft-oauth-client-id'). OPTIONAL — omit it to use " +
        "switchroom's shipped default Microsoft app (zero-config). " +
        "Set it only to bring your own Entra app (BYO)."
      ),
    microsoft_client_secret: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Microsoft OAuth client secret. Optional — public-client apps " +
        "(Mobile + Desktop platform with 'Allow public client flows' " +
        "enabled) work without a secret; confidential clients pass " +
        "one. Either literal or vault reference e.g. " +
        "'vault:microsoft-oauth-client-secret'."
      ),
    authority: z
      .string()
      .url()
      .optional()
      .describe(
        "Microsoft authority endpoint. Defaults to " +
        "'https://login.microsoftonline.com/common' which accepts both " +
        "personal MSA and work/school tenants. Override only for " +
        "single-tenant deployments."
      ),
    org_mode: z
      .boolean()
      .optional()
      .describe(
        "Opt-in to Teams + SharePoint surfaces (RFC §6.4). When true, " +
        "the v1 scope set adds Sites.ReadWrite.All AND the launcher " +
        "spawns softeria with --org-mode. Defaults to false — personal " +
        "MSA + standard work surfaces only. Flipping for an existing " +
        "consented account requires re-running 'auth microsoft account " +
        "add --replace' to consent the additional scope."
      ),
  })
  .optional();

/**
 * Top-level notion_workspace config block — RFC reference/rfcs/notion-integration.md.
 *
 * Centralizes the Notion internal-integration token, the friendly-name →
 * database UUID map, and the global rate-limit bucket size. Block is
 * optional — when omitted, no agent gets a notion MCP entry regardless of
 * per-agent config (the per-agent block is meaningless without the
 * top-level one).
 *
 * Unlike google_workspace/microsoft_workspace which use OAuth-flow
 * accounts, Notion uses a single long-lived integration token. There is
 * no per-account concept; there is no `notion_accounts:` analog. The
 * twin-key ACL is (1) broker ACL on the vault key, (2) per-agent
 * `databases:` filter in AgentNotionWorkspaceConfigSchema.
 *
 * UUID regex is lenient (32 hex with optional dashes) — Notion's wire
 * format always normalizes to the dashed form on responses but accepts
 * either on requests, and the operator may paste either.
 */
export const NotionWorkspaceConfigSchema = z
  .object({
    vault_key: z
      .string()
      .min(1)
      .default("notion/integration-token")
      .describe(
        "Vault key holding the Notion internal-integration token. Default " +
        "`notion/integration-token`. Override only for non-standard vault " +
        "layouts. The broker's --allow ACL on this key is the authoritative " +
        "list of which agents may receive the token."
      ),
    databases: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, {
          message:
            "notion_workspace.databases friendly names must match " +
            "/^[a-z0-9][a-z0-9_-]{0,62}$/ — lowercase letters, digits, " +
            "hyphens, underscores. Got: '%s'.",
        }),
        z.string().regex(
          /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
          {
            message:
              "notion_workspace.databases values must be Notion database " +
              "UUIDs (32 hex characters, optional dashes).",
          }
        ),
      )
      .default({})
      .describe(
        "Friendly-name → Notion database UUID map. Operator-managed; agents " +
        "reference databases by friendly name only — they never see or type " +
        "UUIDs. Populate via `switchroom notion list-dbs` (PR 4) after " +
        "vault-putting the integration token and sharing DBs with the " +
        "integration in Notion's UI."
      ),
    mcp_version: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional pin for the upstream `@notionhq/notion-mcp-server` npm " +
        "package version. Default is the build-time `NOTION_MCP_PINNED_VERSION` " +
        "constant. Override only when reproducing operator-specific bugs."
      ),
    rate_limit_rps: z
      .number()
      .int()
      .positive()
      .max(10)
      .optional()
      .describe(
        "Optional global rate-limit budget in requests per second across all " +
        "switchroom agents sharing this integration token. Defaults to 3 " +
        "(Notion's documented public-API limit). Lower it if you also use " +
        "the integration token from outside switchroom and need to share " +
        "budget. Higher than 10 is rejected — if you think you need it, " +
        "your usage probably needs a workspace-tier upgrade with Notion."
      ),
  })
  .optional();

export type NotionWorkspaceConfig = z.infer<typeof NotionWorkspaceConfigSchema>;

/**
 * Per-agent google_workspace override. Currently just narrows the approver
 * set + lets the agent pick a tier different from the top-level default.
 * google_client_id/secret are not per-agent — those live at the top level
 * (one OAuth client per switchroom install).
 */
export const AgentGoogleWorkspaceConfigSchema = z
  .object({
    account: z
      .string()
      .regex(/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/, {
        message:
          "google_workspace.account must be a Google account email like " +
          "'alice@example.com' (colons not allowed)",
      })
      .transform((v) => v.trim().toLowerCase())
      .optional()
      .describe(
        "RFC G: the Google account this agent uses for the Workspace MCP. " +
        "Must be a key in top-level `google_accounts:` with this agent " +
        "listed in its `enabled_for[]`. Read by the auth-broker " +
        "(get-credentials, provider=google) and by the scaffold to decide " +
        "whether to emit the `gdrive` MCP entry. Normalized to lowercase " +
        "so it matches the google_accounts key (which is also normalized)."
      ),
    approvers: z
      .array(ApproverIdSchema)
      .min(1)
      .optional()
      .describe(
        "Per-agent approver override. When set, replaces (does not extend) " +
        "the top-level drive.approvers list for this agent's onboarding card."
      ),
    tier: GoogleWorkspaceTierSchema.optional().describe(
      "Per-agent tier override (RFC G Phase 1). When set, replaces the " +
      "top-level google_workspace.tier for this agent. Common case: most " +
      "agents on `core`, one specialist on `extended` for Slides access."
    ),
  })
  .optional();

/**
 * Per-agent microsoft_workspace override — RFC #1873.
 * Pins which Microsoft account this agent uses for the M365 MCP surface.
 * `microsoft_client_id/secret` are not per-agent (one app reg per
 * switchroom install).
 */
const MicrosoftAccountEmailSchema = z
  .string()
  .regex(/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/, {
    message:
      "microsoft_workspace.account must be a Microsoft account email like " +
      "'alice@outlook.com' or 'alice@contoso.com' (colons not allowed)",
  })
  .transform((v) => v.trim().toLowerCase());

/**
 * A single per-account tool-allowlist token. These are forwarded verbatim
 * to softeria as `--enabled-tools <tokens joined by |>` and evaluated by
 * softeria as an UNANCHORED, case-insensitive regex against each tool alias.
 *
 * Restricting the token charset to `[a-z0-9-]+` (review 2026-07-17, Finding
 * 4) is a defense-in-depth guard: an unescaped regex metacharacter in a
 * token (`(`, `[`, `\`, `*`, …) would otherwise reach softeria's `new
 * RegExp(...)` and can throw on startup — crashing the launcher child into a
 * restart loop. Softeria tool aliases are all lowercase kebab-case
 * (`send-mail`, `list-calendar-events`), so this charset loses no legitimate
 * matching power while making a malformed-regex crash impossible.
 */
const MicrosoftToolTokenSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, {
    message:
      "microsoft_workspace tools[] tokens are forwarded to softeria's " +
      "--enabled-tools regex; each must be lowercase kebab-case " +
      "([a-z0-9-]+, e.g. 'mail', 'calendar', 'send-mail') so an unescaped " +
      "regex metacharacter can't crash the launcher",
  });

/**
 * A single Microsoft account binding in the plural `accounts[]` form
 * (multi-account-per-agent RFC). Each binding pins one account, an
 * optional per-account tool allowlist (→ softeria `--enabled-tools`),
 * and an optional per-binding org_mode override.
 */
export const MicrosoftAccountBindingSchema = z.object({
  account: MicrosoftAccountEmailSchema.describe(
    "The Microsoft account this binding uses. Must be a key in top-level " +
    "`microsoft_accounts:` with this agent in its `enabled_for[]`."
  ),
  tools: z
    .array(MicrosoftToolTokenSchema)
    .min(1)
    .optional()
    .describe(
      "Per-account tool allowlist → softeria `--enabled-tools <regex>` " +
      "(tokens joined with `|`). Omitted = all tools exposed for this account."
    ),
  org_mode: z
    .boolean()
    .optional()
    .describe("Per-binding org_mode override (RFC #1873 §6.4)."),
});

export const AgentMicrosoftWorkspaceConfigSchema = z
  .object({
    account: MicrosoftAccountEmailSchema.optional().describe(
      "RFC #1873: the Microsoft account this agent uses for the M365 MCP. " +
      "Must be a key in top-level `microsoft_accounts:` with this agent " +
      "listed in its `enabled_for[]`. Read by the auth-broker " +
      "(get-credentials, provider=microsoft) and by the scaffold to " +
      "decide whether to emit the `ms-365` MCP entry. Normalized to " +
      "lowercase so it matches the microsoft_accounts key (which is " +
      "also normalized). Mutually exclusive with `accounts` (plural)."
    ),
    tools: z
      .array(MicrosoftToolTokenSchema)
      .min(1)
      .optional()
      .describe(
        "Per-account tool allowlist for the SINGULAR `account` form → " +
        "softeria `--enabled-tools <regex>`. Omitted = all tools. Only " +
        "valid with the singular `account`; using it together with the " +
        "plural `accounts` (which carries per-binding `tools`) is an error."
      ),
    org_mode: z
      .boolean()
      .optional()
      .describe(
        "Per-agent org_mode override (RFC #1873 §6.4). When set, replaces " +
        "the top-level microsoft_workspace.org_mode for this agent. " +
        "Defaults to top-level value (which defaults to false)."
      ),
    accounts: z
      .array(MicrosoftAccountBindingSchema)
      .min(1)
      .optional()
      .describe(
        "Plural multi-account form: bind MULTIPLE Microsoft accounts to " +
        "this agent, each with its own tool scope. Mutually exclusive with " +
        "the singular `account`. Each account gets its own `ms-365-<slug>` " +
        "MCP server."
      ),
  })
  .superRefine((v, ctx) => {
    const hasSingular = v.account !== undefined;
    const hasPlural = v.accounts !== undefined;
    if (hasSingular && hasPlural) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "microsoft_workspace: use EITHER `account` (singular) OR " +
          "`accounts` (plural array), not both",
        path: ["accounts"],
      });
    }
    if (hasPlural && v.tools !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "microsoft_workspace: block-level `tools` applies to the singular " +
          "`account` only; with `accounts` put `tools` inside each binding",
        path: ["tools"],
      });
    }
    if (hasPlural) {
      const seen = new Set<string>();
      for (const b of v.accounts!) {
        if (seen.has(b.account)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `microsoft_workspace: duplicate account '${b.account}' in accounts[]`,
            path: ["accounts"],
          });
        }
        seen.add(b.account);
      }
    }
  })
  .optional();

/**
 * Per-agent notion_workspace override — RFC reference/rfcs/notion-integration.md.
 *
 * Presence of the block opts the agent IN to Notion access (the launcher
 * is scaffolded, the `.mcp.json` entry is emitted, the broker grants the
 * integration token). Absence opts out.
 *
 * The optional `databases:` filter narrows which DBs this agent may
 * read/write. Names must resolve in the top-level
 * `notion_workspace.databases` map (cross-validated at load time by
 * `validateNotionWorkspaceConfig`). Empty list `[]` is rejected — same as
 * "no notion_workspace at all", and the operator's intent is ambiguous;
 * fail loudly instead of silently denying every tool call.
 *
 * Cascade: per-agent `databases` list REPLACES the parent (profile)
 * list, never concatenates — see RFC §6.5.
 */
export const AgentNotionWorkspaceConfigSchema = z
  .object({
    databases: z
      .array(
        z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, {
          message:
            "notion_workspace.databases entries must be friendly names " +
            "matching /^[a-z0-9][a-z0-9_-]{0,62}$/ — these must appear as " +
            "keys in top-level notion_workspace.databases.",
        }),
      )
      .min(1, {
        message:
          "notion_workspace.databases must list at least one friendly " +
          "name. An empty list rejects every Notion tool call — if you " +
          "want to remove this agent's Notion access, delete the entire " +
          "notion_workspace block instead.",
      })
      .optional()
      .describe(
        "Optional per-agent allowlist of database friendly names this " +
        "agent may read/write. Each name must exist as a key in top-level " +
        "notion_workspace.databases. Omit the field (or leave it undefined) " +
        "to grant access to every DB the upstream integration can see — " +
        "appropriate for an admin/orchestrator agent. Set the list to " +
        "narrow access for specialist agents."
      ),
  })
  .optional();

export type AgentNotionWorkspaceConfig =
  z.infer<typeof AgentNotionWorkspaceConfigSchema>;

/**
 * Legacy alias for back-compat with RFC D shipped config. Identical shape
 * (tier added is fully optional). New code should prefer
 * `AgentGoogleWorkspaceConfigSchema`.
 */
export const AgentDriveConfigSchema = AgentGoogleWorkspaceConfigSchema;

/**
 * Reaction-trigger configuration — controls when an emoji reaction on a
 * bot message is forwarded to the agent as a synthetic inbound turn
 * (`<channel source="reaction">`). See `docs/configuration.md` and
 * `telegram-plugin/gateway/reaction-trigger.ts`.
 *
 * The reaction-persistence path (`recordReaction` → user_reaction column)
 * is independent of this config — reactions are always persisted regardless
 * of trigger outcome. This block only governs the synthetic-inbound path.
 *
 * Cascade modes:
 *   - enabled / debounce_ms / per_hour_cap / group_admin_only: override.
 *     Simple scalars; agent wins, defaults fall through when unset.
 *   - trigger_emojis: replace (NOT union). Operators must be able to
 *     narrow the allowlist — including to `[]` to disable triggering
 *     without flipping `enabled: false`. A union mode would silently
 *     keep defaults visible, defeating the per-agent narrowing case.
 */
export const ReactionsSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Master switch for the reaction-trigger path. When false, " +
        "reactions are still persisted via recordReaction but never " +
        "dispatched to the agent as synthetic inbound turns. Default true.",
      ),
    trigger_emojis: z
      .array(z.string())
      .optional()
      .describe(
        "Emoji allowlist that triggers a synthetic inbound when reacted " +
        "to a bot message. Default ['👎', '❌', '👍', '✅']. Cascade " +
        "mode: REPLACE (not union) — setting this at a layer replaces " +
        "lower layers entirely, so an operator can narrow to [] to " +
        "disable triggering without flipping `enabled`.",
      ),
    debounce_ms: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Per-chat debounce window in ms. A qualifying reaction holds for " +
        "this long; a second qualifying reaction within the window " +
        "collapses both into a single batched synthetic turn. Default 30000.",
      ),
    per_hour_cap: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Max reaction-triggered synthetic turns per chat per rolling hour. " +
        "Refusals are stderr-logged but not surfaced to the agent. " +
        "Default 10. Set to 0 to disable triggering via the cap path.",
      ),
    group_admin_only: z
      .boolean()
      .optional()
      .describe(
        "In groups/supergroups (negative chat_id), only trigger a synthetic " +
        "turn when the reacter is a chat admin (creator or administrator). " +
        "Failing the lookup is treated as non-admin (fail-closed). " +
        "DMs are never affected by this flag — the reacter IS the user. " +
        "Default true.",
      ),
  })
  .optional();

/**
 * Reaction-dispatch configuration (#2291) — controls whether an emoji
 * reaction on ANY message is forwarded to the agent as an event-driven
 * inbound channel turn shaped like a button callback:
 *
 *   <channel source="switchroom-telegram" event="reaction"
 *            emoji="👨‍💻" message_id="..." chat_id="..." user="...">
 *   <reacted message text>
 *   </channel>
 *
 * Distinct from `reactions` (ReactionsSchema, #1074), which only forwards
 * reactions on the BOT's own messages (debounced/hour-capped feedback,
 * default ON). This block is for reaction-driven workflows (e.g. react
 * 👨‍💻 to capture a message to Linear) and replaces wasteful cron polling
 * of get_recent_messages. See `telegram-plugin/gateway/reaction-dispatch.ts`
 * and `docs/configuration.md`.
 *
 * Default OFF: with no `reaction_dispatch` block (or an empty `emojis`
 * allowlist) NO reaction turns fire. Only additions/changes matching the
 * allowlist dispatch — removals never do.
 *
 * Cascade modes:
 *   - enabled: override (simple scalar; agent wins).
 *   - emojis: replace (NOT union) — operators narrow the allowlist
 *     per-agent; setting `[]` disables dispatch without flipping `enabled`.
 */
export const ReactionDispatchSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Master switch for the reaction-dispatch path. Default false — " +
        "with no reaction_dispatch block, reactions are persisted (and may " +
        "feed the `reactions` feedback path) but are NEVER dispatched as " +
        "event-driven inbound turns.",
      ),
    emojis: z
      .array(z.string())
      .optional()
      .describe(
        "Emoji allowlist that triggers a `<channel event=\"reaction\">` " +
        "inbound turn when reacted to any message. Default [] (nothing " +
        "fires). Cascade mode: REPLACE (not union) — a layer's list " +
        "replaces lower layers entirely so an operator can narrow per-agent.",
      ),
  })
  .optional();

/**
 * Release-channel pin / pointer for the update flow.
 *
 * Either `channel` (track a moving pointer — dev / rc / latest) OR
 * `pin` (lock to a specific build identifier — `sha-<7-40 hex>` or
 * `v<semver>`). The two are mutually exclusive: a pin overrides any
 * channel implication and a channel implies "follow the pointer."
 *
 * Allowed at the root (fleet default) and per-agent (override).
 * Per-agent `release` REPLACES the root entirely — it is NOT field-
 * merged (a pinned agent should not silently inherit a channel from
 * the root, and vice versa).
 */
const releaseBlockFields = {
  channel: z.enum(["dev", "rc", "latest"]).optional(),
  pin: z
    .string()
    .regex(/^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/)
    .optional(),
};

export const ReleaseBlock = z
  .object(releaseBlockFields)
  .strict()
  .refine((r) => !(r.channel && r.pin), {
    message: "release.channel and release.pin are mutually exclusive",
  });

/**
 * Root-only release block (KEN-131, stage 3 of KEN-128): the shared
 * channel/pin fields PLUS the opt-in `auto_update` flag. Root-only on
 * purpose — auto-update is a FLEET property consumed by hostd's release
 * watcher; a per-agent `auto_update` would be meaningless (the staggered
 * canary rollout always rolls the fleet), so the per-agent / profile-level
 * `release` blocks stay on the plain ReleaseBlock and reject the key via
 * `.strict()`.
 */
export const RootReleaseBlock = z
  .object({
    ...releaseBlockFields,
    auto_update: z
      .boolean()
      .optional()
      .describe(
        "Opt-in unattended fleet auto-update (KEN-131). When true, hostd's " +
        "release watcher polls the published release version and, on a new " +
        "release, drives the EXISTING staggered canary rollout " +
        "(`switchroom rollout --pin vX.Y.Z`) unattended: canary-first, " +
        "per-agent version assert, durable pin persisted only after the " +
        "canary is green, abort + operator alert card on canary failure, " +
        "and compose rollback on a failed apply. Default false — with it " +
        "unset/false, behaviour is unchanged.",
      ),
  })
  .strict()
  .refine((r) => !(r.channel && r.pin), {
    message: "release.channel and release.pin are mutually exclusive",
  });

/**
 * sec WS6-F1 (#1390) / feature #1413. Shared so it cascades through
 * BOTH profileFields (defaults + profile levels) AND AgentSchema
 * (per-agent) with one source of truth. Override cascade (agent →
 * profile → defaults); unset ⇒ "host" (the pre-#1413 default).
 */
export const NetworkIsolationSchema = z
  .enum(["host", "strict"])
  .optional()
  .describe(
    "Container network mode (sec WS6-F1 #1390 / feature #1413). " +
    "'host' (DEFAULT when unset): `network_mode: host` — the agent " +
    "shares the host network stack; hindsight 127.0.0.1:18888 and " +
    "operator-LAN devices are reachable, but there is NO network " +
    "isolation from sibling agents or host services (the documented, " +
    "deliberate shared-host tradeoff). 'strict': the agent joins its " +
    "OWN dedicated docker bridge network instead — it cannot reach " +
    "sibling agents; host services are reached via " +
    "`host.docker.internal`. OPT-IN: validate hindsight / operator-" +
    "LAN / cron / boot-self-test paths for your deployment before " +
    "adopting fleet-wide (default-flip is deferred to that validation " +
    "cycle, #1413). Cascades override (agent → profile → defaults).",
  );

// First-class users (RFC reference/rfcs/user-concept.md — memory-routing
// phase). `serves` / `knows` reference entries in the top-level `users:`
// block and are resolved (unioned) into the recall maps by resolveUsers().
// Defined once and mirrored into profileFields (defaults/profiles) and
// AgentSchema (per-agent), like every other agent field.
const servesField = z
  .array(z.string())
  .optional()
  .describe(
    "Users (keys in the top-level `users:` block) this agent works for. When " +
    "a served user messages this agent, their profile_bank is recalled " +
    "(speaker routing → memory.recall.sender_banks). Unions with any explicit " +
    "memory.recall.sender_banks. NOTE: this does not yet generate access " +
    "(allowFrom) — pair agent access as today; allowFrom generation is a " +
    "later phase.",
  );
const knowsField = z
  .array(z.string())
  .optional()
  .describe(
    "Users or banks this agent always knows as subjects — recalled and " +
    "recall-ranked even when that person is not the speaker (→ " +
    "memory.recall.additional_banks). A `users:` key resolves to that user's " +
    "profile_bank; any other string is used as a raw bank name (e.g. a `kids` " +
    "profile bank with no Telegram identity). Unions with any explicit " +
    "memory.recall.additional_banks.",
  );

const profileFields = {
  extends: z.string().optional(),
  serves: servesField,
  knows: knowsField,
  bot_token: z.string().optional(),
  release: ReleaseBlock.optional().describe(
    "Release-channel pin / pointer. Either `channel` (dev|rc|latest) or " +
    "`pin` (sha-<hex>|v<semver>) — mutually exclusive. Per-agent value " +
    "REPLACES the root entirely (no field merge).",
  ),
  timezone: z
    .string()
    .regex(
      TIMEZONE_REGEX,
      "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC' " +
      "(three-letter aliases like EST/PST and bare offsets like UTC+10 are not accepted)",
    )
    .optional()
    .describe(
      "IANA timezone name (e.g. 'Australia/Melbourne', 'America/New_York', " +
      "'UTC'). Used to generate the per-turn local-time hint the agent's " +
      "UserPromptSubmit timezone hook emits, and baked into the agent " +
      "container's `environment.TZ` in compose so subprocess `date`/" +
      "`Date.now()` are correct. If unset at every cascade layer, switchroom " +
      "auto-detects from /etc/timezone and warns on `reconcile` when the " +
      "detected zone is UTC.",
    ),
  soul: z
    .object({
      name: z.string().optional(),
      style: z.string().optional(),
      creature: z.string().optional(),
      vibe: z.string().optional(),
      expertise: z.string().optional(),
      emoji: z.string().optional(),
      boundaries: z.string().optional(),
      // No .default() here: a profile/defaults layer fills in fields the
      // per-agent soul omits, so `shape` stays optional. The "generalist"
      // default lives on AgentSoulSchema (per-agent). See merge.ts soul
      // cascade for how a defaulted per-agent "generalist" is treated as
      // the neutral shape so it does not stomp an explicit profile shape.
      shape: z
        .enum(["executive-assistant", "developer", "coach", "generalist"])
        .optional(),
    })
    .optional(),
  tools: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  memory: z
    .object({
      collection: z.string().optional(),
      auto_recall: z.boolean().optional(),
      // Mirror of AgentMemorySchema.file — accepted at the defaults/profile tier
      // too, so `defaults.memory.file: false` makes the whole fleet (and future
      // agents) hindsight-native by default, with per-agent `file: true` opt-in.
      file: z.boolean().optional(),
      isolation: z.enum(["default", "strict"]).optional(),
      // Mirror of AgentMemorySchema.profile — accepted at the defaults/profile
      // tier too, so `defaults.memory.profile: coding` (or a profile setting it)
      // cascades like every other memory field, with per-agent override.
      profile: z.string().optional(),
      // Mirror of AgentMemorySchema.directive_capture_nudge — accepted at the
      // defaults/profile tier too, so `defaults.memory.directive_capture_nudge:
      // false` can disable the #2848 nudge fleet-wide (per-agent `true` opt-in).
      directive_capture_nudge: z.boolean().optional(),
      // Mirror of AgentMemorySchema.anti_confabulation_directive — accepted at
      // the defaults/profile tier too, so `defaults.memory.
      // anti_confabulation_directive: false` opts a whole fleet out of the
      // seeded guardrail (or pins one house text for every agent), with
      // per-agent override.
      anti_confabulation_directive: AntiConfabulationDirectiveSchema,
      // Mirror of AgentMemorySchema.observation_scopes — accepted at the
      // defaults/profile tier too, so `defaults.memory.observation_scopes:
      // shared` pins a whole fleet's observations to one scope. A per-agent
      // value OVERRIDES that pin with another enum member; because the schema
      // is `z.enum().optional()` with no clear sentinel, `undefined` inherits
      // the fleet pin (it cannot cancel it). To decline the pool, an agent
      // sets `observation_scopes: combined` — the member that restores the
      // pre-feature engine default (see ObservationScopesSchema above).
      observation_scopes: ObservationScopesSchema,
      // Mirror of AgentMemorySchema.observation_scope_strategy — accepted at
      // the defaults/profile tier too, so `defaults.memory.
      // observation_scope_strategy: combined` opts a whole fleet out of the
      // curated default with per-agent opt-in.
      observation_scope_strategy: ObservationScopeStrategySchema,
      recall: z
        .object({
          max_memories: z.number().int().min(0).optional(),
          cache_ttl_secs: z.number().int().min(0).optional(),
          // Mirrors of AgentMemorySchema.recall.* — accepted at the
          // defaults/profile tier too, so the recall latency envelope can be
          // tuned fleet-wide with per-agent overrides.
          hook_timeout_seconds: z.number().int().min(1).optional(),
          parallel_deadline_seconds: z.number().int().min(1).optional(),
          query_max_tokens: z.number().int().min(0).optional(),
          query_stop_terms: z.array(z.string().min(1).regex(/^[\w./-]+$/)).optional(),
          request_timeout_seconds: z.number().int().min(1).optional(),
          own_bank_min_slots: z.number().int().min(0).optional(),
          additional_bank_min_slots: z.number().int().min(0).optional(),
          min_score: z.number().min(0).optional(),
          min_score_scope: z.enum(["degraded", "all"]).optional(),
          // #3841 passthrough knobs. Mirrored here so a fleet-wide
          // `defaults.memory.recall.budget` (etc.) cascades like its siblings;
          // the descriptions live on AgentMemorySchema.recall above.
          budget: z.enum(["low", "mid", "high"]).optional(),
          max_tokens: z.number().int().min(1).optional(),
          prefer_observations: z.boolean().optional(),
          context_turns: z.number().int().min(1).optional(),
          roles: z.array(z.string().min(1)).min(1).optional(),
          prompt_preamble: z.string().min(1).optional(),
          tags: z.array(z.string().min(1)).optional(),
          tags_match: z.enum(["any", "all", "any_strict", "all_strict"]).optional(),
          tag_groups: z
            .union([
              z.array(z.array(z.string().min(1))),
              z.record(z.string(), z.array(z.string().min(1))),
            ])
            .optional(),
          tag_weights: z.record(z.string(), z.number().min(0)).optional(),
          additional_bank_filters: z
            .record(
              z.string(),
              z
                .object({
                  tags: z.array(z.string().min(1)).optional(),
                  tags_match: z.enum(["any", "all", "any_strict", "all_strict"]).optional(),
                  tag_groups: z
                    .union([
                      z.array(z.array(z.string().min(1))),
                      z.record(z.string(), z.array(z.string().min(1))),
                    ])
                    .optional(),
                })
                .strict(),
            )
            .optional(),
          transcript_fallback: z.boolean().optional(),
          transcript_tail_bytes: z.number().int().min(0).optional(),
          max_query_chars: z.number().int().min(1).optional(),
          parallel: z.boolean().optional(),
          additional_banks: z.array(z.string()).optional(),
          sender_banks: z.record(z.string(), z.string()).optional(),
          // Mirrors of AgentMemorySchema.recall.{types,skip_trivial,
          // topic_filter_mode} (#3779) — accepted at the defaults/profile tier
          // too so they cascade fleet-wide like their siblings. Without these
          // the keys were stripped at parse (unknown key) — the #3773 silent
          // no-op class. Descriptions live on AgentMemorySchema.recall above.
          types: z.array(z.string()).optional(),
          skip_trivial: z.boolean().optional(),
          topic_filter_mode: z.enum(["soft-preamble", "hard-filter"]).optional(),
        })
        .optional(),
      // Mirror of AgentMemorySchema.retain (#3909) — accepted at the
      // defaults/profile tier too so the auto-retain cadence can be tuned
      // fleet-wide with per-agent overrides. merge.ts one-level-deep merges
      // this per-key exactly like `recall`; without the mirror the keys were
      // stripped at parse AND the merge clause was a silent no-op. Descriptions
      // live on AgentMemorySchema.retain.
      retain: z
        .object({
          every_n_turns: z.number().int().min(1).optional(),
          overlap_turns: z.number().int().min(0).optional(),
        })
        .optional(),
      // Mirrors of AgentMemorySchema.{bank_mission,reflect_mission,
      // reflect_budget,reflect_max_tokens,retain_mission,observations_mission,
      // disposition} — accepted at the defaults/profile tier too so a bank's
      // mission framing, reflect budget/token caps and disposition cascade
      // fleet-wide (per-key merge for `disposition`, override for the scalars).
      // Without the reflect_budget/reflect_max_tokens mirror the keys were
      // stripped at parse (the #3773 silent-no-op class). mental_models is
      // DELIBERATELY not mirrored: it is per-agent only by design (see
      // AgentMemorySchema.mental_models) so a model can never be fleet-seeded.
      // Descriptions live on AgentMemorySchema.
      bank_mission: z.string().optional(),
      reflect_mission: z.string().optional(),
      reflect_budget: z.enum(["low", "mid", "high"]).optional(),
      reflect_max_tokens: z.number().int().positive().max(8192).optional(),
      retain_mission: z.string().optional(),
      observations_mission: z.string().optional(),
      disposition: z
        .object({
          skepticism: z.number().int().min(1).max(5).optional(),
          literalism: z.number().int().min(1).max(5).optional(),
          empathy: z.number().int().min(1).max(5).optional(),
        })
        .optional(),
    })
    .optional(),
  schedule: z.array(ScheduleEntrySchema).optional(),
  secrets: z
    .array(
      z
        .string()
        .regex(
          /^[a-zA-Z0-9_\-/]+$/,
          "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes",
        ),
    )
    .optional()
    .describe(
      "Operator-granted STANDING vault keys this agent may read via the " +
      "broker — independent of any cron or MCP server. Use when an agent " +
      "needs a credential both interactively and in its own (agent-managed) " +
      "schedules, so the grant lives with the agent rather than welded to a " +
      "specific cron's `secrets[]`. OPERATOR-SET ONLY: agents cannot edit " +
      "switchroom.yaml or self-grant (reference/vision.md outcome 2 — 'you " +
      "hold the leash; only your tap grants it'). Exact key names. Cascades " +
      "UNION across defaults -> profile -> agent (see docs/configuration.md).",
    ),
  reactions: ReactionsSchema,
  reaction_dispatch: ReactionDispatchSchema,
  model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Model name must be alphanumeric with ._-/[]: only",
    )
    .optional(),
  thinking_effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Adaptive-thinking effort level passed as --effort to the claude CLI. " +
      "lower = faster/cheaper, higher = more reasoning. Omit to use Claude's default.",
    ),
  permission_mode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional()
    .describe(
      "Permission mode passed as --permission-mode to the claude CLI. " +
      "Omit to use Claude's default (acceptEdits for switchroom agents). " +
      "Warning: bypassPermissions and dontAsk skip all safety checks — use only in trusted sandboxes.",
    ),
  fallback_model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Fallback model name must be alphanumeric with ._-/[]: only",
    )
    .optional()
    .describe(
      "Fallback model passed as --fallback-model to the claude CLI. " +
      "Used when the primary model is overloaded. Note: only functional in --print (non-interactive) mode per Claude CLI docs; silently no-ops in interactive sessions.",
    ),
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
  hooks: AgentHooksSchema,
  env: z.record(z.string(), z.string()).optional(),
  litellm: LiteLLMConfigSchema,
  system_prompt_append: z.string().optional(),
  skills: z.array(z.string()).optional(),
  bundled_skills: z
    .record(z.string(), z.boolean())
    .optional()
    .describe(
      "Opt-out map for switchroom's bundled-default skills " +
      "(e.g. skill-creator, mcp-builder, webapp-testing, pdf, docx, " +
      "xlsx, pptx, switchroom-cli, switchroom-status, switchroom-health). " +
      "Set a key to `false` to suppress that default for this agent. " +
      "Cascades from defaults.bundled_skills.",
    ),
  subagents: z
    .record(z.string(), SubagentSchema)
    .optional()
    .describe("Named sub-agent definitions rendered to .claude/agents/<name>.md"),
  session: SessionSchema,
  session_continuity: SessionContinuitySchema,
  channels: ChannelsSchema,
  network_isolation: NetworkIsolationSchema,
  dangerous_mode: z.boolean().optional(),
  settings_raw: z.record(z.string(), z.unknown()).optional(),
  claude_md_raw: z.string().optional(),
  cli_args: z.array(z.string()).optional(),
  extra_stable_files: z
    .array(z.string())
    .optional()
    .describe(
      "Extra filenames (relative to the agent's workspace directory) to append " +
      "to the stable bootstrap render. Loaded once at session start via " +
      "`--append-system-prompt`. Missing files are silently skipped. " +
      "Example: ['BRIEF.md', 'CONTEXT.md'].",
    ),
  resources: z
    .object({
      memory: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "memory must be a Docker size string like '6g', '512m', '1.5g'",
        )
        .optional()
        .describe(
          "Hard memory cap (Docker `mem_limit` → cgroup memory.max). When the " +
          "container exceeds this, the kernel OOM-kills processes in the cgroup. " +
          "Format: '6g', '1.5g', '512m'. When unset at every cascade layer the " +
          "compose generator falls back to the hard-coded per-profile defaults " +
          "in src/agents/compose.ts (klanker 6g, coding 2g, conversational 1.5g, " +
          "lightweight 1g, default 1.5g).",
        ),
      memory_reservation: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "memory_reservation must be a Docker size string like '4g', '256m'",
        )
        .optional()
        .describe(
          "Soft memory floor (Docker `mem_reservation` → cgroup memory.low). " +
          "Under host-wide memory pressure, the kernel protects at least this " +
          "much from being reclaimed from the cgroup. Must be ≤ memory. Use to " +
          "keep an agent RAM-resident when the host has other tenants that " +
          "might push the box (Coolify apps, build jobs). Default: unset.",
        ),
      pids_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max processes the cgroup can spawn (cgroup pids.max). Prevents " +
          "fork bombs and runaway test runners. Counts every process in the " +
          "cgroup including bash subprocesses, claude itself, sidecars, and " +
          "any test/build worker. A typical agent at idle uses ~30 PIDs; " +
          "`npm test`-style workloads can spike to 200+. Set generously " +
          "(2000 is a comfortable cap for test-running agents). Default: " +
          "unset (no cgroup pid cap).",
        ),
      cpus: z
        .number()
        .positive()
        .optional()
        .describe(
          "CPU quota (Docker `cpus`). Fractional values OK (e.g. 0.5, 2.0). " +
          "When unset at every cascade layer the compose generator falls " +
          "back to the per-profile default (klanker/coding 2.0, default 1.0, " +
          "lightweight 0.5).",
        ),
      tmp_size: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "tmp_size must be a Docker size string like '1g', '4g', '512m'",
        )
        // Zero is syntactically a valid size string but semantically a
        // foot-gun the other resource fields don't have: `mem_limit: 0`
        // means "unlimited" to Docker, whereas a `size=0` tmpfs mounts a
        // ZERO-byte /tmp and every write in the container fails.
        .refine((v) => parseFloat(v) > 0, "tmp_size must be greater than zero")
        .optional()
        .describe(
          "Size of the agent container's RAM-backed `/tmp` (Docker " +
          "`tmpfs: - /tmp:size=<this>,mode=1777`). The container root FS is " +
          "read-only, so /tmp is the only scratch space the agent and its " +
          "sub-agents get for repo clones and toolchain caches (bunx/npx/pip) " +
          "— a fan-out of several sub-agents exhausts the 1g default. A tmpfs " +
          "only consumes host RAM for the pages actually written, so raising " +
          "the ceiling costs nothing until it is used; those pages are still " +
          "charged to the container's `memory` cap, so raise both together. " +
          "Format: '1g', '4g', '512m'. Default when unset at every cascade " +
          "layer: '1g'.",
        ),
    })
    .optional()
    .describe(
      "Per-agent resource limits. Cascades through defaults → profile → " +
      "per-agent with per-field merge (agent wins on each field independently). " +
      "Any field left unset at every layer falls back to the hard-coded " +
      "per-profile defaults in src/agents/compose.ts.",
    ),
  experimental: z
    .object({
      legacy_pty: z
        .boolean()
        .optional()
        .describe(
          "Opt out of the default tmux supervisor (#725) and run the agent under " +
          "the legacy PTY supervisor instead. Default: false (tmux is the default).",
        ),
      legacy_autoaccept_expect: z
        .boolean()
        .optional()
        .describe(
          "Opt the autoaccept gateway back into the legacy expect-script behaviour " +
          "instead of the tmux send-keys path. Default: false.",
        ),
    })
    .optional()
    .describe(
      "Opt-in flags for experimental / legacy behaviours. Cascades through " +
      "defaults → profile → per-agent.",
    ),
  // Mirror of AgentSchema.allowed_tools / disallowed_tools — repeated
  // here (AgentSchema does not spread profileFields, same as
  // `resources`) so the fields are accepted at the defaults + profile
  // levels and cascade to agents via mergeAgentConfig. Without these,
  // `defaults.allowed_tools` was stripped at parse (unknown key) AND
  // dropped at merge — a silent double no-op. See #199 + the
  // allowed_tools/disallowed_tools cascade clause in merge.ts.
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool allowlist passed verbatim to Claude Code's --allowedTools " +
      "flag. Cascades defaults → profile → per-agent (union, dedup). Supports " +
      "patterns like 'Bash(git *)' or 'mcp__perplexity__*' that the coarse " +
      "`tools.allow` field can't express. See #199."
    ),
  disallowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool denylist passed verbatim to Claude Code's --disallowedTools " +
      "flag. Cascades defaults → profile → per-agent (union, dedup). Same pattern " +
      "syntax as allowed_tools (e.g. 'Bash(rm *)'). See #199."
    ),
};

/**
 * Profiles are named partial configs that agents inherit from via
 * `extends: <name>`. See `profileFields` above for the full shape.
 */
export const ProfileSchema = z.object(profileFields);

/**
 * AgentDefaultsSchema is the implicit profile applied to every agent
 * before their own per-agent config and their `extends:` target. It
 * has the same shape as a profile but doesn't itself support
 * `extends:` (the defaults block IS the bottom of the cascade).
 */
const { extends: _omitExtends, ...defaultsFields } = profileFields;
export const AgentDefaultsSchema = z.object(defaultsFields).optional();

/**
 * Name of the implicit filesystem profile used when no `extends:`
 * field is declared and no inline profile matches. Corresponds to the
 * `profiles/default/` directory bundled with switchroom.
 */
export const DEFAULT_PROFILE = "default";

/**
 * Resolve the **memory** profile an agent's curated memory defaults key off
 * (disposition + observations_mission in `PROFILE_MEMORY_DEFAULTS`), decoupled
 * from `extends` (the filesystem *persona* profile).
 *
 * Precedence: explicit `memory.profile` → `extends` → {@link DEFAULT_PROFILE}.
 * When `memory.profile` is unset this is byte-identical to the historical
 * `agentConfig.extends ?? DEFAULT_PROFILE`, so unopted agents see zero change.
 *
 * Structurally typed so it accepts a full `AgentConfig` or any `{ extends?,
 * memory? }` shape (e.g. the doctor's bank-entry config). Takes the merged
 * config — the cascade has already layered defaults/profile/agent memory.
 */
export function resolveMemoryProfile(
  agentConfig:
    | { extends?: string; memory?: { profile?: string } }
    | undefined,
): string {
  return agentConfig?.memory?.profile ?? agentConfig?.extends ?? DEFAULT_PROFILE;
}

export const AgentSchema = z.object({
  extends: z
    .string()
    .optional()
    .describe(
      "Name of a profile to inherit from (e.g., 'coding', 'health-coach'). " +
      "Profiles may be defined inline under switchroom.yaml `profiles:` or as a " +
      "filesystem directory `profiles/<name>/`. Defaults to DEFAULT_PROFILE " +
      "('default') when unset.",
    ),
  serves: servesField,
  knows: knowsField,
  bot_token: z
    .string()
    .optional()
    .describe("Per-agent Telegram bot token or vault reference (overrides global telegram.bot_token)"),
  release: ReleaseBlock.optional().describe(
    "Per-agent release-channel pin / pointer. REPLACES the root " +
    "`release` block entirely (no field merge) — a pinned agent does " +
    "not inherit the fleet channel, and vice versa.",
  ),
  bot_username: z
    .string()
    .optional()
    .describe(
      "Per-agent Telegram bot username (without leading @) when it doesn't " +
      "contain the agent slug. Replaces the default 'username includes slug' " +
      "preflight check with an exact (case-insensitive) match. Use when an " +
      "agent and its bot have intentionally divergent names (e.g. agent " +
      "'lawgpt' paired with bot '@meken_law_bot').",
    ),
  timezone: z
    .string()
    .regex(
      TIMEZONE_REGEX,
      "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC' " +
      "(three-letter aliases like EST/PST and bare offsets like UTC+10 are not accepted)",
    )
    .optional()
    .describe(
      "Per-agent IANA timezone override. Wins over any profile/defaults " +
      "value and over the top-level switchroom.timezone global. Controls " +
      "the UserPromptSubmit timezone hook's emitted local time and the " +
      "agent container's `environment.TZ` in compose.",
    ),
  auth: z
    .object({
      override: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Per-agent override of the fleet-wide `auth.active`. Edge-case use only — " +
          "this agent talks to the named account regardless of fleet active. See RFC H §4.5.",
        ),
      strict: z
        .boolean()
        .optional()
        .describe(
          "Requires `override`. When true, the pin is a hard binding, not a " +
          "routing preference: the broker NEVER serves this agent from any " +
          "other account — no failover to `auth.fallback_order` while the " +
          "pinned account is quota-walled or exhausted. The agent rides out " +
          "the wall on its own account (surfacing the normal 429/quota " +
          "cards) instead of silently borrowing fleet quota. Use for " +
          "accounts that must never cross a billing/compliance boundary " +
          "(e.g. an employer-provided subscription).",
        ),
      exclusive: z
        .boolean()
        .optional()
        .describe(
          "Requires `override`. When true, the pinned account belongs to " +
          "THIS agent alone: the broker refuses to serve it to any other " +
          "agent or consumer, refuses `auth use <label>` (set-active) onto " +
          "it, and refuses pinning another agent to it. Config that routes " +
          "others to the account (`auth.active`, `auth.fallback_order`, " +
          "another agent's `override`, a consumer pin) is rejected at load. " +
          "Usually paired with `strict: true` for full two-way isolation.",
        ),
    })
    .optional()
    .describe(
      "Account routing for switchroom-auth-broker. RFC H schema uses " +
      "fleet-wide `auth.active` plus per-agent `override:` for edge cases, " +
      "with optional `strict:` (never borrow another account) and " +
      "`exclusive:` (no one else may use the pinned account) hardening. " +
      "Pre-RFC-H `auth.accounts: [..]` and `auth_label:` are migrated in-place " +
      "on first apply (see src/auth/migrate-schema.ts).",
    ),
  dm_only: z
    .boolean()
    .optional()
    .describe(
      "Mark this agent as a DM-only bot — has its own bot_token and lives " +
      "exclusively in a private chat with the operator. Suppresses " +
      "scaffolding's default behavior of inheriting the global " +
      "telegram.forum_chat_id into the agent's access.json `groups` entry " +
      "(the forum chat the bot isn't a member of, which would otherwise " +
      "trigger a 'boot-probe-failed: 400 chat not found' warning every " +
      "restart). topic_name is still schema-required but unused — set it " +
      "to a display label like 'DM' for /switchroom status output.",
    ),
  topic_name: z.string().describe("Telegram forum topic display name"),
  topic_emoji: z
    .string()
    .optional()
    .describe("Emoji for the topic (e.g., '🏋️')"),
  purpose: z
    .string()
    .max(140)
    .optional()
    .describe(
      "One-line description of what this agent does (≤140 chars). Shown to " +
      "peer agents when they call the agent-config MCP `peers_list` tool, so " +
      "every agent on the instance can answer 'is there an agent that does X' " +
      "without baking the fleet into prompts. Sourced live from " +
      "switchroom.yaml — never memorized into Hindsight. Falls back to " +
      "`topic_name` when absent.",
    ),
  role: z
    .enum(["assistant", "foreman"])
    .optional()
    .describe(
      "Agent role. Default (omitted) is `assistant` — a fleet agent doing " +
      "user-facing tasks. `foreman` opts the agent in to switchroom's bundled " +
      "operator skills (switchroom-architecture / cli / health / install / manage " +
      "/ status), auto-symlinked into the agent's .claude/skills/ on scaffold and " +
      "reconcile. Fleet agents (assistant role) get no operator skills; reconcile " +
      "actively retracts them if the role flips back. See docs/skills.md for the model.",
    ),
  topic_id: z
    .number()
    .optional()
    .describe("Telegram topic thread ID (auto-populated by switchroom topics sync)"),
  // ─── Deprecated locations (#596) — read but migrate ──────────────────────
  // These three fields originally lived at the per-agent root. They've
  // moved under `channels.telegram.*` to inherit the cascade like every
  // other adjacent feature. The root locations stay for backwards-compat
  // but the resolved-config layer (mergeAgentConfig) folds them into the
  // canonical channels.telegram.* spot and logs a deprecation warning.
  // Remove these fields once no live switchroom.yaml uses them.
  webhook_sources: z
    .array(z.enum(["github", "generic", "linear"]))
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.webhook_sources in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning. " +
      "See channels.telegram.webhook_sources for the canonical spot."
    ),
  voice_in: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(["openai"]).optional(),
      language: z.string().optional(),
    })
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.voice_in in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning."
    ),
  telegraph: z
    .object({
      enabled: z.boolean().optional(),
      threshold: z.number().int().positive().optional(),
      short_name: z.string().optional(),
      author_name: z.string().optional(),
    })
    .optional()
    .describe(
      "[DEPRECATED — moved to channels.telegram.telegraph in #596] " +
      "Old per-agent location. Still read but logs a deprecation warning."
    ),
  soul: AgentSoulSchema,
  tools: AgentToolsSchema,
  memory: AgentMemorySchema,
  schedule: z.array(ScheduleEntrySchema).default([]),
  // Mirror of profileFields.secrets — must be repeated here because
  // AgentSchema does not spread profileFields (same pattern as `resources`
  // below). Operator-set STANDING vault grant; see profileFields.secrets
  // for the full doc + the broker enforcement in src/vault/broker/acl.ts.
  secrets: z
    .array(
      z
        .string()
        .regex(
          /^[a-zA-Z0-9_\-/]+$/,
          "Secret key names must contain only alphanumeric characters, underscores, hyphens, and forward slashes",
        ),
    )
    .optional(),
  reactions: ReactionsSchema,
  reaction_dispatch: ReactionDispatchSchema,
  model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Model name must be alphanumeric with ._-/[]: only (no spaces or shell specials)",
    )
    .optional()
    .describe("Claude model override (e.g., 'claude-sonnet-5')"),
  thinking_effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe(
      "Adaptive-thinking effort level passed as --effort to the claude CLI. " +
      "Per-agent override wins over defaults.thinking_effort. " +
      "lower = faster/cheaper, higher = more reasoning. Omit to use Claude's default.",
    ),
  permission_mode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional()
    .describe(
      "Permission mode passed as --permission-mode to the claude CLI. " +
      "Per-agent override wins over defaults.permission_mode. " +
      "Warning: bypassPermissions and dontAsk skip all safety checks — use only in trusted sandboxes.",
    ),
  fallback_model: z
    .string()
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._\-/\[\]:]*$/,
      "Fallback model name must be alphanumeric with ._-/[]: only",
    )
    .optional()
    .describe(
      "Fallback model passed as --fallback-model to the claude CLI. " +
      "Per-agent override wins over defaults.fallback_model. " +
      "Used when the primary model is overloaded. Note: only functional in --print (non-interactive) mode per Claude CLI docs; silently no-ops in interactive sessions.",
    ),
  mcp_servers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional MCP server configurations"),
  hooks: AgentHooksSchema.describe(
    "Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, Stop, etc). " +
    "Written to settings.json.hooks in Claude Code's native shape.",
  ),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables exported in start.sh before claude runs"),
  litellm: LiteLLMConfigSchema.describe(
    "Per-agent LiteLLM routing override. Presence with `enabled: true` opts " +
    "this agent IN to per-agent virtual-key auto-provisioning + routing env " +
    "(falls back to the top-level `litellm:` block for base_url/admin_key/" +
    "team/small_fast_model). Deep-merges one level over defaults/profile; " +
    "`tags` merge per-key, agent wins. Default OFF.",
  ),
  system_prompt_append: z
    .string()
    .optional()
    .describe(
      "Text passed via claude's --append-system-prompt flag. " +
      "Appended to the default or CLAUDE.md-derived system prompt.",
    ),
  skills: z
    .array(z.string())
    .optional()
    .describe(
      "Names of skills from switchroom.skills_dir to symlink into this " +
      "agent's skills/ directory. Unioned with defaults.skills.",
    ),
  bundled_skills: z
    .record(z.string(), z.boolean())
    .optional()
    .describe(
      "Per-agent override of switchroom's bundled-default skills " +
      "(skill-creator, mcp-builder, webapp-testing, pdf, docx, xlsx, " +
      "pptx, switchroom-cli/status/health). Set a key to `false` to " +
      "opt out for this agent. Per-agent value wins over defaults.bundled_skills.",
    ),
  humanizer_voice_file: z
    .string()
    .optional()
    .describe(
      "Optional path to a voice-calibration template (markdown). " +
      "When set, exported as HUMANIZER_VOICE_FILE so the bundled " +
      "humanizer skill matches the user's writing style instead of " +
      "applying generic 'human' rules. Generate one with the " +
      "humanizer-calibrate skill, or hand-write it. Resolved relative " +
      "to the agent's directory if not absolute.",
    ),
  subagents: z
    .record(z.string(), SubagentSchema)
    .optional()
    .describe(
      "Sub-agent definitions rendered to .claude/agents/<name>.md. " +
      "Each sub-agent is a specialized worker the main agent can " +
      "delegate to. Merged with defaults/profile sub-agents by name.",
    ),
  session: SessionSchema.describe(
    "Session lifecycle policy. Controls --continue vs fresh start on " +
    "agent restart based on idle time and turn count thresholds.",
  ),
  session_continuity: SessionContinuitySchema.describe(
    "Handoff-briefing settings. When enabled (default), a Stop hook " +
    "summarizes each session at shutdown and start.sh injects that " +
    "briefing into the next session via --append-system-prompt.",
  ),
  channels: ChannelsSchema.describe(
    "Per-channel configuration. Today only `telegram` is defined; the " +
    "shape is designed to expand to other channels (Slack, Discord, " +
    "Matrix, Email) as they're added.",
  ),
  dangerous_mode: z
    .boolean()
    .optional()
    .describe("If true, include --dangerously-skip-permissions in start.sh"),
  network_isolation: NetworkIsolationSchema,
  admin: z
    .boolean()
    .optional()
    .describe(
      "If true, the agent's Telegram gateway intercepts admin slash commands " +
      "(/agents, /logs, /restart, /delete, /update, /auth, /reconcile, etc.) " +
      "locally before forwarding to Claude. Commands are handled silently — " +
      "Claude never sees them. Requires the agent to use the switchroom-telegram " +
      "plugin. When false or absent, all messages pass through to Claude unchanged.",
    ),
  root: z
    .boolean()
    .optional()
    .describe(
      "If true, this is a ROOT-tier debugging agent: a root-privileged " +
      "container (runs as uid 0, mounts /var/run/docker.sock, the whole " +
      "~/.switchroom tree, and the host root filesystem at /host) so you " +
      "can DM it to debug the whole fleet — read any agent's logs, " +
      "docker exec into peers, edit host files — instead of SSHing into " +
      "the host as root. Implies admin: true (all admin slash commands). " +
      "Standing root power, audited via the agent's own session transcript " +
      "and shell history; there is no per-action approval tap. Per-agent " +
      "only (never set at defaults/profile layers). Grant to exactly one " +
      "trusted operator-private agent — it ingests other agents' output, " +
      "which is attacker-influenced text. See docs/root-agent.md.",
    ),
  settings_raw: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Escape hatch: raw object deep-merged into the generated " +
      "settings.json as the final step. Use for Claude Code settings " +
      "keys switchroom doesn't wrap directly (e.g. effort, apiKeyHelper). " +
      "Power-user-only — prefer the typed fields when they exist."
    ),
  claude_md_raw: z
    .string()
    .optional()
    .describe(
      "Escape hatch: markdown text appended verbatim to CLAUDE.md on " +
      "initial scaffold. Not re-applied on reconcile (CLAUDE.md is " +
      "user-protected). Use for one-off persona tuning that isn't " +
      "worth a template."
    ),
  cli_args: z
    .array(z.string())
    .optional()
    .describe(
      "Escape hatch: extra arguments appended to the `exec claude` " +
      "invocation in start.sh. Use for Claude Code CLI flags switchroom " +
      "doesn't expose directly (e.g. --effort high, " +
      "--exclude-dynamic-system-prompt-sections)."
    ),
  add_dirs: z
    .array(z.string())
    .optional()
    .describe(
      "Additional filesystem paths the agent's tools can access. Passed " +
      "as repeated --add-dir <path> on the claude invocation. Use to grant " +
      "an agent reach into shared dirs (e.g. '/share/collab') without " +
      "scaffold hacks. Per-agent only — paths are persona-specific. See #199. " +
      "Note: this only adjusts the claude CLI's --add-dir tool-reach allowlist. " +
      "If the path is not already inside the agent's container, also declare " +
      "it in `bind_mounts:` (admin agents only) — otherwise the path doesn't " +
      "exist inside the sandbox and --add-dir is a no-op."
    ),
  bind_mounts: z
    .array(AgentBindMountSchema)
    .optional()
    .describe(
      "Extra host paths bind-mounted into this agent's container, on top of " +
      "the standard dual-mount baseline. ADMIN-ONLY: the compose generator " +
      "refuses to emit bind_mounts unless `admin: true` is also set on the " +
      "same agent. Use to dogfood / self-modify switchroom or another repo " +
      "(see issue #1164). Pair with `add_dirs:` so claude's tool-reach " +
      "allowlist also covers the mounted path. System paths (/, /etc, " +
      "/proc, /sys, /dev, /run, /var/run, /boot, /var/lib/docker, " +
      "/var/run/docker.sock) are denylisted regardless of mode."
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool allowlist passed verbatim to Claude Code's --allowedTools " +
      "flag. Supports patterns like 'Bash(git *)' or 'Edit(*.md)' that the " +
      "coarse `tools.allow` field can't express. When set, Claude Code OR-merges " +
      "with `tools.allow` (granular only when present, otherwise coarse — chosen " +
      "via #199 to keep blast radius minimal for existing operators on tools.allow). " +
      "See #199."
    ),
  disallowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Granular tool denylist passed verbatim to Claude Code's --disallowedTools " +
      "flag. Same pattern syntax as allowed_tools (e.g. 'Bash(rm *)'). See #199."
    ),
  extra_stable_files: z
    .array(z.string())
    .optional()
    .describe(
      "Extra filenames (relative to the agent's workspace directory) to append " +
      "to the stable bootstrap render. Loaded once at session start via " +
      "`--append-system-prompt`. Missing files are silently skipped. " +
      "Example: ['BRIEF.md', 'CONTEXT.md'].",
    ),
  code_repos: z
    .array(CodeRepoEntrySchema)
    .optional()
    .describe(
      "Git repositories this agent is allowed to claim worktrees from. " +
      "Each entry provides a short name alias, a source path, and an " +
      "optional concurrency cap (default 5). When code_repos is set, " +
      "claim_worktree accepts the alias as the repo argument. " +
      "Absolute paths may always be passed regardless of this list.",
    ),
  drive: AgentGoogleWorkspaceConfigSchema.describe(
    "RFC D legacy key — use `google_workspace:` instead. Per-agent " +
    "google_workspace overrides (currently approvers + tier). When set, " +
    "replaces the top-level approvers list for this agent. " +
    "google_client_id/secret are not per-agent — they live at the top level.",
  ),
  google_workspace: AgentGoogleWorkspaceConfigSchema.describe(
    "RFC G canonical key. Per-agent Google Workspace overrides — currently " +
    "approvers (replaces, does not extend the top-level list) and tier " +
    "(`core` | `extended` | `complete`, replaces top-level default). " +
    "google_client_id/secret are not per-agent — they live at the top level. " +
    "Mutually exclusive with `drive:` on the same agent (loader fails fast " +
    "if both are set).",
  ),
  microsoft_workspace: AgentMicrosoftWorkspaceConfigSchema.describe(
    "RFC #1873 (Microsoft 365 integration). Per-agent Microsoft Workspace " +
    "override — pins the Microsoft account this agent reads via the " +
    "auth-broker (must be a key in top-level `microsoft_accounts:` with " +
    "this agent in its `enabled_for[]`) and optionally overrides org_mode. " +
    "microsoft_client_id/secret are not per-agent.",
  ),
  notion_workspace: AgentNotionWorkspaceConfigSchema.describe(
    "RFC reference/rfcs/notion-integration.md. Per-agent Notion access. " +
    "Presence opts the agent IN (launcher scaffolded, MCP entry emitted, " +
    "broker grants the integration token). Optional `databases:` filter " +
    "narrows which DBs this agent may read/write — names must resolve in " +
    "top-level notion_workspace.databases. Absence opts the agent OUT.",
  ),
  repos: z
    .record(
      z.string().regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "Repo slug must be kebab-case ASCII: start with a lowercase letter or digit, contain only lowercase letters, digits, and hyphens",
      ),
      z.object({
        url: z
          .string()
          .min(1)
          .describe(
            "Git remote URL for the repo (e.g. 'git@github.com:org/repo.git' or " +
            "'https://github.com/org/repo.git'). Used verbatim for git clone.",
          ),
        branch_default: z
          .string()
          .optional()
          .describe(
            "Default branch to track (defaults to the remote's HEAD, typically 'main'). " +
            "The per-agent branch 'agent/<agentName>/main' fast-forwards to this branch " +
            "when the worktree is clean on session start.",
          ),
      }),
    )
    .optional()
    .describe(
      "Repos this agent operates on. Switchroom provisions a dedicated worktree for each " +
      "repo at <agentDir>/work/<slug>/ on branch agent/<agentName>/main, backed by a " +
      "shared bare clone at ~/.switchroom/repos/<slug>.git. The worktree path is injected " +
      "into the agent's environment as SWITCHROOM_REPO_<SLUG_UPPER>. " +
      "Agents without this field continue to work unchanged.",
    ),
  experimental: z
    .object({
      legacy_pty: z
        .boolean()
        .optional()
        .describe(
          "Opt out of the default tmux supervisor (#725) and run the agent " +
          "under the legacy PTY supervisor instead. Default: false.",
        ),
      legacy_autoaccept_expect: z
        .boolean()
        .optional()
        .describe(
          "Opt the autoaccept gateway back into the legacy expect-script " +
          "behaviour instead of the tmux send-keys path. Default: false.",
        ),
    })
    .optional()
    .describe(
      "Opt-in flags for experimental / legacy behaviours. Cascades through " +
      "defaults → profile → per-agent.",
    ),
  // Mirror of profileFields.resources — must be repeated here because
  // AgentSchema does not spread profileFields. Without this, the
  // inferred AgentConfig type lacks `resources` and typed reads in
  // compose.ts / merge.ts fail tsc (runtime works because zod doesn't
  // strip unknown keys by default). See profileFields.resources at
  // schema.ts above for the full description; keep the two in sync.
  resources: z
    .object({
      memory: z
        .string()
        .regex(/^\d+(\.\d+)?[kmgKMG]?$/)
        .optional(),
      memory_reservation: z
        .string()
        .regex(/^\d+(\.\d+)?[kmgKMG]?$/)
        .optional(),
      pids_limit: z.number().int().positive().optional(),
      cpus: z.number().positive().optional(),
      tmp_size: z
        .string()
        .regex(
          /^\d+(\.\d+)?[kmgKMG]?$/,
          "tmp_size must be a Docker size string like '1g', '4g', '512m'",
        )
        .refine((v) => parseFloat(v) > 0, "tmp_size must be greater than zero")
        .optional(),
    })
    .optional(),
}).superRefine((agent, ctx) => {
  // `strict` / `exclusive` are modifiers of a pin — without `override`
  // there is no account for them to bind to, so their presence is an
  // authoring error (likely a mis-indented yaml block), not a no-op.
  if (agent.auth && !agent.auth.override) {
    for (const flag of ["strict", "exclusive"] as const) {
      if (agent.auth[flag]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `\`auth.${flag}: true\` requires \`auth.override: <account>\` — there is no pinned account for it to apply to.`,
          path: ["auth", flag],
        });
      }
    }
  }
  // Supergroup-mode exclusion: dm_only agents have their own bot+chat
  // and don't participate in forum-topic routing. The three modes
  // (fleet-shared, dm_only, supergroup-owned) are mutually exclusive.
  // See reference/rfcs/supergroup-mode.md.
  if (agent.dm_only !== true) return;
  const tg = agent.channels?.telegram;
  if (tg == null) return;
  if (tg.chat_id != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`dm_only: true` forbids `channels.telegram.chat_id` — DM-only agents have their own private chat, not a supergroup.",
      path: ["channels", "telegram", "chat_id"],
    });
  }
  if (tg.default_topic_id != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`dm_only: true` forbids `channels.telegram.default_topic_id` — DMs don't have forum topics.",
      path: ["channels", "telegram", "default_topic_id"],
    });
  }
  if (tg.topic_aliases != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`dm_only: true` forbids `channels.telegram.topic_aliases` — DMs don't have forum topics.",
      path: ["channels", "telegram", "topic_aliases"],
    });
  }
});

export const TelegramConfigSchema = z.object({
  bot_token: z
    .string()
    .describe(
      "Telegram bot token or vault reference (e.g., 'vault:telegram-bot-token')"
    ),
  forum_chat_id: z
    .string()
    .describe("Telegram forum group chat ID (negative number as string)"),
});

export const MemoryBackendConfigSchema = z.object({
  backend: z
    .enum(["hindsight", "none"])
    .default("hindsight")
    .describe("Memory backend to use"),
  shared_collection: z
    .string()
    .default("shared")
    .describe("Collection name for cross-agent shared memories"),
  config: z
    .object({
      provider: z
        .string()
        .default("ollama")
        .describe("Embedding provider (ollama, openai, anthropic)"),
      model: z
        .string()
        .optional()
        .describe("Embedding model (e.g., 'nomic-embed-text')"),
      llm_model: z
        .string()
        .optional()
        .describe(
          "LiteLLM model name for Hindsight's LLM ops (retain/reflect/" +
          "consolidation) when the top-level `litellm.enabled` carve-out is " +
          "on. Defaults to a cheap OpenRouter model (routed via LiteLLM's " +
          "model-mapped path, not the Anthropic OAuth pass-through) to keep " +
          "background memory-op cost off the Claude subscription quota. Set " +
          "to a `claude-*` model name to route it back through the OAuth " +
          "pass-through instead. Has no effect when litellm is disabled.",
        ),
      api_key: z
        .string()
        .optional()
        .describe("API key or vault reference for embedding provider"),
      docker_service: z
        .boolean()
        .default(true)
        .describe("Whether to include Hindsight in docker-compose"),
      url: z
        .string()
        .url("Hindsight URL must be a valid URL (no shell-special characters)")
        .optional()
        .describe("Hindsight MCP endpoint URL (e.g., http://localhost:18888/mcp/). Defaults to http://localhost:8888/mcp/."),
      mcp_transport: z
        .enum(["shim", "http"])
        .optional()
        .describe(
          "How agents reach Hindsight's MCP surface. Default (unset or " +
          "'shim'): the lazy-connect stdio proxy `switchroom " +
          "hindsight-mcp-shim`, which always registers at session start " +
          "even when the hindsight container is down and reconnects " +
          "per-call. 'http' is the escape hatch that restores the legacy " +
          "direct Streamable-HTTP entry (session-fatal if the backend is " +
          "down when the agent session boots).",
        ),
    })
    .optional(),
});

export const VaultConfigSchema = z.object({
  path: z
    .string()
    .default("~/.switchroom/vault/vault.enc")
    .describe(
      "Path to encrypted vault file. v0.7.12+ canonical default is " +
      "`~/.switchroom/vault/vault.enc` (parent-dir bind-mount enables " +
      "atomic-rename writes from the broker container). Older installs " +
      "with `~/.switchroom/vault.enc` are auto-migrated on `switchroom " +
      "apply`; the legacy path becomes a symlink for v0.7.10/.11 CLI " +
      "compatibility (sunset in v0.7.14).",
    ),
  broker: z
    .object({
      socket: z
        .string()
        .default("~/.switchroom/vault-broker.sock")
        .describe("Unix domain socket path for the vault-broker daemon"),
      enabled: z
        .boolean()
        .default(true)
        .describe("Whether to start the vault-broker daemon on agent launch"),
      autoUnlock: z.boolean().default(false).describe(
        "Auto-unlock the vault at broker start using a machine-bound " +
        "encrypted blob. Off by default. When enabled, the broker reads " +
        "the configured blob path, derives the AES key from /etc/machine-id, " +
        "decrypts the passphrase, and unlocks the vault — no sudo, no " +
        "systemd-creds, no TPM. Run `switchroom vault broker " +
        "enable-auto-unlock` once to write the blob."
      ),
      autoUnlockCredentialPath: z.string().default("~/.switchroom/vault-auto-unlock").describe(
        "Path to the machine-bound auto-unlock blob (see " +
        "src/vault/auto-unlock.ts for the format). Default lives under " +
        "~/.switchroom so it can be bind-mounted into the vault-broker " +
        "container by docker compose. Tilde-expansion happens " +
        "at read time."
      ),
      approvalAuth: z
        .enum(["passphrase", "telegram-id"])
        .default("passphrase")
        .describe(
          "Posture for tap-to-Approve on vault grant cards. `passphrase` " +
          "(default) prompts the operator to type the vault passphrase on " +
          "every Approve — two-factor (Telegram ID + passphrase). " +
          "`telegram-id` mints immediately on Approve with no passphrase " +
          "prompt — single-factor (Telegram ID only); REQUIRES " +
          "`autoUnlock: true` so the broker already holds the passphrase. " +
          "Trades a factor of security for smoother UX; opt-in only."
        ),
      postureMintAgents: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Per-agent opt-in for posture-attested broker calls (`mint_grant` / " +
          "`list_grants` / `put` with `attest_via_posture: true`). Only agents " +
          "whose names are in this list can use the silent-mint path under " +
          "`approvalAuth: telegram-id`. Default `[]` — no agent can self-mint " +
          "until the operator explicitly opts it in. The request's `agent` " +
          "field must also equal the calling peer's resolved agent name " +
          "(broker rejects cross-agent posture mints). When `approvalAuth` is " +
          "`passphrase` this list is ignored — passphrase attestation still " +
          "works as before. Each entry is an agent slug exactly as it appears " +
          "under `agents:` in this config."
        ),
      adminOnlyKeys: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Vault keys held to a higher approval bar: only the admin operator " +
          "(`access.allowFrom[0]`) may approve a grant for them, and they can " +
          "NEVER be minted via posture attestation — granting one requires the " +
          "operator passphrase (so an agent, even one on `postureMintAgents`, " +
          "cannot self-grant it). Entries are exact key names or `*` globs, " +
          "e.g. `stripe/*`, `*/oauth-token`, `microsoft/ken-tokens` (`*` matches " +
          "any run of characters incl. `/`; case-sensitive). Default `[]` — no " +
          "key is admin-only. Posture may RETAIN an admin-only key across a " +
          "union re-mint but never ADD one. Takes effect on broker + gateway " +
          "restart (broker has no ACL hot-reload)."
        ),
      auditFailClosed: z
        .boolean()
        .default(false)
        .describe(
          "sec WS10-F3 (#1420) — fail-CLOSED on an audit-append failure. When " +
          "`false` (default, backward-compatible) the broker fails OPEN: if a " +
          "vault-audit.log append fails it logs to stderr, bumps the durable " +
          "fail-open counter, and STILL releases the secret. When `true`, a " +
          "failed audit append DENIES the secret release with " +
          "`AUDIT_UNAVAILABLE` — no secret leaves the broker without a durable " +
          "audit row. The env var `SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED` " +
          "(`1`/`true` or `0`/`false`) overrides this at runtime. Either way " +
          "the fail-open counter is surfaced by `switchroom doctor`. Takes " +
          "effect on broker restart."
        ),
    })
    .default({})
    .superRefine((broker, ctx) => {
      if (broker.approvalAuth === "telegram-id" && broker.autoUnlock !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "`vault.broker.approvalAuth: telegram-id` requires `autoUnlock: true` — single-factor approval needs the broker already unlocked at startup.",
          path: ["approvalAuth"],
        });
      }
    })
    .describe(
      "Vault-broker daemon configuration. The broker holds the decrypted vault " +
      "in memory and serves secrets to cron scripts via a Unix socket, so the " +
      "vault passphrase is entered once at startup rather than per-cron invocation.",
    ),
  backup: z
    .object({
      destination: z
        .string()
        .optional()
        .describe(
          "Destination directory for `switchroom vault backup`. " +
          "When unset, the CLI defaults to " +
          "`~/.switchroom-config/vault-backups/` if that operator config " +
          "repo exists, else `~/.switchroom/vault-backups/`. " +
          "Path is tilde-expanded at read time. " +
          "MUST NOT be `~/.switchroom/vault/` (the broker bind-mount dir, " +
          "validated by `switchroom apply` against an artifact allowlist)."
        ),
      retain: z
        .number()
        .int()
        .nonnegative()
        .default(30)
        .describe(
          "How many of the most-recent backups to keep in the destination dir. " +
          "Older ones are pruned after each new backup is written. Default 30 " +
          "= roughly a month at daily cadence."
        ),
    })
    .optional()
    .describe(
      "Configuration for `switchroom vault backup`. Optional — the CLI works " +
      "with built-in defaults if this block is absent. The backed-up file is " +
      "the AES-256-GCM-encrypted vault envelope; the operator passphrase " +
      "remains the gate, so committing backups to a private git repo extends " +
      "durability without weakening encryption (provided the auto-unlock " +
      "blob is NEVER co-located — `vault backup` refuses to write into a " +
      "directory that contains an auto-unlock-shaped sibling)."
    ),
});

/**
 * Optional spend budgets used by the session greeting to render a
 * Quota row ("wk $12 / $50 (24%) · mo $103 / $200 (52%)"). Values are
 * in USD and compared against `ccusage` local usage totals at runtime
 * inside the greeting shell script — no network call, no subscription
 * API (Anthropic exposes none). When a budget is unset, the greeting
 * falls back to raw usage without a ratio.
 */
export const QuotaConfigSchema = z.object({
  weekly_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Weekly USD spend budget. If unset, the greeting shows raw usage only."),
  monthly_budget_usd: z
    .number()
    .positive()
    .optional()
    .describe("Monthly USD spend budget. If unset, the greeting shows raw usage only."),
});

/**
 * Host-control daemon (`switchroom-hostd`) — default-on since RFC C
 * Phase 2 (#1338); see `reference/rfcs/host-control-daemon.md`. The daemon
 * is the `switchroom-hostd` Docker container, running in its own
 * compose project (separate from the agent fleet's project). When
 * enabled (the default), the compose generator emits per-agent UDS
 * bind mounts for admin agents so the daemon can dispatch a closed
 * set of operator verbs reached from inside the containers.
 */
/**
 * Pull-based release-triggered fleet restart (#1743).
 *
 * Closes the deployment-lag gap: hostd polls the remote image tag on
 * a fixed interval, and when the remote digest diverges from the
 * deployed digest it runs `switchroom update` then `switchroom
 * restart all` (graceful — drains in-flight turns).
 */
export const AutoReleaseCheckSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "When true, hostd polls the remote release tag every " +
      "`interval_minutes` and applies + restarts the fleet when a new " +
      "release is detected. Default false — opt-in.",
    ),
  interval_minutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .default(5)
    .describe(
      "Poll interval in minutes. Floor of 5m matches the agent-config " +
      "cron rate limit; ceiling of 1440m (24h) is a sanity cap.",
    ),
  apply_on_detect: z
    .boolean()
    .default(true)
    .describe(
      "When false, hostd logs `release_detected` but does NOT call " +
      "update_apply / restart all. Useful for dogfooding the detector " +
      "without rolling the fleet.",
    ),
  notify_on_detect: z
    .boolean()
    .default(false)
    .describe(
      "KEN-129 — operator-in-the-loop update prompt. Only consulted " +
      "when apply_on_detect is false (auto-apply supersedes notify): " +
      "a newly detected release posts ONE operator approval card " +
      "('fleet is behind — tap to apply') via an admin agent's " +
      "gateway; Approve runs hostd's update_apply path (fleet-" +
      "mutation-locked, durable status rows, get_status-pollable). " +
      "Dedup on release id: the last-notified id persists in " +
      "~/.switchroom/release-notify-state.json, so a card that " +
      "reached the operator is never re-posted for the same release.",
    ),
  image_ref: z
    .string()
    .default("ghcr.io/switchroom/switchroom-agent:latest")
    .describe(
      "Image reference whose remote digest is compared to the local " +
      "image digest. Defaults to the agent image's :latest tag, which " +
      "is the canonical signal that a release has been promoted.",
    ),
});

export const HostControlConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .describe(
      "Whether the host-control daemon is in use. Default: true (since " +
      "RFC C Phase 2 default-flip — the gateway's /restart, /new, /reset, " +
      "and /update apply slash-commands all dispatch through hostd, and " +
      "without it those verbs fail on docker-mode installs because the " +
      "agent container has no docker binary/socket). " +
      "When true, the compose generator emits per-agent bind mounts " +
      "at `~/.switchroom/hostd/<name>/sock` for every admin-flagged " +
      "agent. Install the daemon with `switchroom hostd install` — " +
      "it runs as a docker container in its own compose project " +
      "(`switchroom-hostd`), separate from the agent fleet's compose " +
      "project so `up -d --remove-orphans` cycles of the fleet " +
      "can't recreate the daemon mid-RPC. See RFC C §5.1. " +
      "Set enabled: false only on legacy systemd-mode installs that " +
      "still rely on the in-container `spawnSwitchroomDetached` " +
      "shellout (removal is tracked as RFC C Phase 3).",
    ),
  auto_release_check: AutoReleaseCheckSchema.default({}).describe(
    "Pull-based release-triggered fleet restart (#1743). hostd polls " +
    "the remote release tag on a fixed interval and applies + " +
    "restarts the fleet (graceful) when a new release is detected. " +
    "Opt-in: default enabled=false.",
  ),
});

/**
 * Web-service (dashboard + GitHub-webhook receiver) container config.
 * Phase 3 of the webhook Docker-native migration: the web server used
 * to run as a systemd unit straight off the shared source checkout;
 * `switchroom webd install` packages it as an image-pinned container in
 * its own compose project (`switchroom-web`).
 */
export const WebServiceConfigSchema = z.object({
  managed: z
    .boolean()
    .default(false)
    .describe(
      "Whether `switchroom update` refreshes the web-service container " +
      "(dashboard + GitHub-webhook receiver) via `switchroom webd " +
      "install`. Default: false — existing installs run the web server " +
      "as the legacy `switchroom-web.service` systemd unit and must not " +
      "be surprised by a container takeover of host loopback 127.0.0.1:" +
      "8080 mid-update. Set true ONLY after cutting over to the " +
      "container (stop+disable the systemd unit, `switchroom webd " +
      "install`). The container runs in its own compose project " +
      "(`switchroom-web`), separate from the agent fleet, with " +
      "network_mode: host so it keeps owning loopback:8080 for the " +
      "cloudflared tunnel + tailscale serve consumers.",
    ),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8080)
    .describe(
      "Host loopback port the web server listens on (127.0.0.1:<port>). " +
      "Default: 8080. Set this when another service owns 8080 on the " +
      "host (e.g. UniFi OS Server) — `switchroom webd install` and the " +
      "`switchroom update` refresh-web step both honor it, so a custom " +
      "port survives updates instead of being silently reverted to " +
      "8080 by the regenerated compose file. Remember to point the " +
      "host-side consumers (cloudflared tunnel, `tailscale serve`) at " +
      "the same port.",
    ),
});

/**
 * Fleet Health — the operator-facing, job-spec-anchored issue tracker
 * (`reference/rfcs/fleet-health.md`; serves `fleet-stays-healthy`). The
 * owner agent runs the nightly model-free sensor + weekly budgeted deep-dive
 * that populate `~/.switchroom/fleet-health/ledger.json`, which the admin
 * "Fleet Health" page reads. Top-level + operator-owned (never
 * agent-writable): the operator assigns WHICH agent owns the work so every
 * scan and deep-dive is attributable and on-leash.
 */
export const FleetHealthConfigSchema = z.object({
  owner_agent: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,50}$/, {
      message: "owner_agent must match the standard agent-name pattern",
    })
    .optional()
    .describe(
      "The admin agent that runs the Fleet Health sensor + deep-dive crons " +
      "(RFC fleet-health.md). Default unset → the feature is inert: no crons " +
      "are scheduled and the admin page renders its empty state. The named " +
      "agent must be admin: true. A dedicated owner (not any admin) keeps " +
      "the fleet-health work attributable, its memory scoped, and its token " +
      "spend accountable. The detection runs ONLY as operator-set schedules " +
      "on this agent — never a self-authored loop (on-leash, " +
      "no-self-escalation).",
    ),
});

/**
 * hostd verb-level knobs (separate from `host_control:` which gates
 * the daemon itself).
 *
 * Introduced by `reference/rfcs/admin-agent-config-edit.md` §3 / §4 to opt
 * in the new `config_propose_edit` verb and bound its per-agent
 * rate. The verb is the approval-gated path for admin agents to edit
 * `switchroom.yaml` without operator copy-paste (RFC §1). Default
 * `config_edit_enabled: false` is deliberate — the verb is a security-
 * critical surface (RFC §2.2, §5) and ships off until the operator
 * explicitly opts in.
 *
 * `config_propose_edit` is shipped (validate → operator approval → apply
 * → reconcile). `config_edit_rate_per_hour` is configurable but the rate
 * limiter is not yet enforced.
 */
export const HostdConfigSchema = z.object({
  config_edit_enabled: z
    .boolean()
    .default(false)
    .describe(
      "Opt-in toggle for the `config_propose_edit` hostd verb (RFC " +
      "admin-agent-config-edit §3). Default false — the verb returns " +
      "`E_CONFIG_EDIT_DISABLED` until the operator explicitly flips " +
      "this to true. When true, admin agents can propose unified-diff " +
      "patches against " +
      "`/state/config/switchroom.yaml`, gated by an operator approval " +
      "card in the primary chat. Same trust posture as `update_apply` " +
      "and `agent_restart`: the human-in-the-loop tap is the security " +
      "boundary, not the agent's judgement.",
    ),
  config_edit_rate_per_hour: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe(
      "Per-requesting-agent rate cap for `config_propose_edit` cards " +
      "(RFC admin-agent-config-edit §5). Default 3 cards/hour; min 1, " +
      "max 20. ENFORCED server-side: a caller exceeding this in a sliding " +
      "1-hour window is rejected with `E_RATE_LIMITED` (carrying a " +
      "`retry_after` fix) instead of posting another operator approval " +
      "card — so a looping agent is throttled rather than spamming the chat.",
    ),
  // ── Operator-attest 2nd factor (#1841, RFC host-control-daemon.md §5.4) ──
  operator_attest_enabled: z
    .boolean()
    .default(false)
    .describe(
      "Opt-in toggle for the operator-passphrase 2nd factor on hostd's " +
      "mutating verbs (#1841, RFC host-control-daemon.md §5.4). Default " +
      "false — attestation is ACCEPTED-and-audited whenever present, but " +
      "no verb REQUIRES it (behaviour is byte-identical to today, so " +
      "existing fleets and the Telegram approval-card flow are unchanged). " +
      "When true, the verbs in `operator_attest_required_verbs` demand a " +
      "valid operator-passphrase attestation IN ADDITION to admin: hostd " +
      "forwards the passphrase to the vault broker over its own admin-client " +
      "connection (`/run/switchroom/broker/hostd/sock`) and treats a broker " +
      "DENIED as a gate failure. hostd never holds the passphrase. Leave " +
      "this off until BOTH the gateway passphrase-forward and the " +
      "cross-compose broker socket are deployed, or gated verbs will fail.",
    ),
  operator_attest_required_verbs: z
    .array(z.string().min(1))
    .default(["update_apply", "apply", "rollout"])
    .describe(
      "Which mutating hostd verbs REQUIRE a valid operator-passphrase " +
      "attestation when `operator_attest_enabled` is true (#1841). Default " +
      "is the RFC §5.4 fleet-mutation set (`update_apply`, `apply`, " +
      "`rollout`). Verbs NOT in this list still accept-and-audit an " +
      "attestation when one is supplied, but never require it. Ignored " +
      "entirely when `operator_attest_enabled` is false.",
    ),
});

// Cheap-cron operator config — reference/rfcs/cheap-cron-sessions.md §6.1.
// The egress allowlist + secret→host bindings are the SSRF/exfil fence for
// Tier-0 http-diff polls. Top-level + operator-owned (never agent-writable):
// an agent can propose a poll, but the host it may reach and the secret it
// may carry are decided HERE, at operator-commit time.
export const CronEgressSchema = z.object({
  allowed_hosts: z
    .array(z.string().min(1))
    .default([])
    .describe("Hosts a poll may reach (exact, https-only). loopback/private/IP-literal are always rejected."),
  secret_bindings: z
    .record(z.string(), z.string().min(1))
    .default({})
    .describe("secretName → the single host it may be sent to. A poll carrying a secret to any other host is rejected."),
});

export const CronConfigSchema = z.object({
  egress: CronEgressSchema.optional().describe("SSRF/exfil fence for http-diff polls."),
});

/**
 * A first-class user — a trusted person the fleet serves, identified by their
 * Telegram account and carrying their own memory profile bank. RFC
 * reference/rfcs/user-concept.md. The operator's own trusted people
 * (single-tenant), assigned to agents via `serves` / `knows`.
 */
export const UserSchema = z.object({
  name: z.string().optional().describe("Display name for the user."),
  telegram_ids: z
    .array(z.string())
    .min(1)
    .describe(
      "Telegram username(s) and/or numeric user id(s) identifying this user " +
      "(a leading @ is optional). Matched against the message sender for " +
      "per-speaker memory routing.",
    ),
  profile_bank: z
    .string()
    .describe(
      "Hindsight bank holding this user's memory profile (author via " +
      "`switchroom memory profile add <bank> ...`).",
    ),
  person_id: z
    .string()
    .optional()
    .describe(
      "Free-text display name projected into the inbound `<channel>` " +
      "tag's `user` attribute (e.g. \"Lisa\") so an agent can greet by " +
      "name instead of only seeing the raw Telegram id/username. NOT a " +
      "stable identity system — just a label. Resolution is boot-time-only " +
      "(no hot-reload; a config change needs an agent restart) and " +
      "chat-scoped (a resolved name is only shown in a chat/group the " +
      "person is actually a member of, per that chat's access.json " +
      "membership — never broadcast into every chat the agent operates " +
      "in). Keep this broadly safe to show, the same discipline as " +
      "picking a `profile_bank` name: there is no automated enforcement " +
      "that a `person_id` stays safe if a group's membership changes " +
      "later — see docs/configuration.md.",
    ),
});
export type User = z.infer<typeof UserSchema>;

/**
 * Config-repo change control (`config_repo:`) — the operator's private
 * `~/.switchroom-config` git repo as a first-class, product-managed backup +
 * change-control target. Sibling of `vault:`.
 *
 * Historically the repo was fed by a hand-written `sync.sh` (copy live → repo,
 * `git commit`, no push, no schedule, no secret scan). `switchroom config-repo
 * sync` ports that natively and closes the gaps `sync.sh` left open:
 *   - a `flock` so a manual run and a scheduled tick can never interleave;
 *   - a symlink-target guard replacing `cp -L` (never follow a workspace
 *     symlink out to `credentials/*.env` or any path outside the agent tree);
 *   - a commit-time secret scan (the same `scanBundleForSecrets` engine that
 *     gates the personal-skill write path) so a secret that arrived by a
 *     direct rw-mount write — bypassing the in-container scan — is still caught
 *     before it is committed;
 *   - force-adding each `agents/<name>/personal-skills/` slice so the 84
 *     mirrored personal skills that `.gitignore`'s blanket `agents/` leaves
 *     untracked are finally captured (GAP A);
 *   - a `require_private` push gate: refuse to auto-push unless the GitHub API
 *     confirms the remote is private.
 *
 * The block is OPTIONAL and OFF by default — nothing changes for operators who
 * do not set it. Push auth rides the operator's existing `gh` credential
 * helper; no new secret is created and nothing moves into a container.
 */
export const ConfigRepoConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe(
      "Master switch for config-repo change control. Default false (opt-in). " +
      "When false the `config-repo sync` verb still runs on demand but the " +
      "doctor check and (later) the scheduled tick treat the feature as off.",
    ),
  path: z
    .string()
    .regex(
      /^[a-zA-Z0-9~._\-/]+$/,
      "config_repo.path must not contain shell-special characters ($, `, \", ', \\, etc.)",
    )
    .default("~/.switchroom-config")
    .describe(
      "Filesystem path to the operator's private config repo. Must be a git " +
      "repo (else `switchroom doctor` FAILs). Tilde-expanded at read time.",
    ),
  push: z
    .boolean()
    .default(true)
    .describe(
      "When true, `config-repo sync` pushes after committing (subject to the " +
      "`require_private` gate). When false, it commits locally only — useful " +
      "for offline hosts or a review-before-push workflow.",
    ),
  remote: z
    .string()
    .min(1)
    .default("origin")
    .describe("Git remote name to push to. Default `origin`."),
  require_private: z
    .boolean()
    .default(true)
    .describe(
      "Refuse to PUSH unless the GitHub API confirms the remote repo is " +
      "private. On a public remote — or when the API is unreachable — the " +
      "push is skipped (commits still land locally) and a WARN is emitted. " +
      "Fail-safe against exfiltrating memory files / workspace state to a " +
      "repo that has been flipped public. Default true.",
    ),
  interval_minutes: z
    .number()
    .int()
    .min(5)
    .max(59)
    .default(30)
    .describe(
      "Cadence (minutes) of the scheduled `config-repo sync` tick installed " +
      "by `switchroom config-repo --install-cron`. Rendered as a cron " +
      "`*/N * * * *` minute field, so it must be 5..59 (the 5-min floor " +
      "matches the rest of the fleet's cron floor). Default 30 (Ken's " +
      "approved cadence). Changing it takes effect on the next " +
      "`--install-cron` / `switchroom update` reconcile.",
    ),
  include_vault_backup: z
    .enum(["off", "daily", "every_tick"])
    .default("daily")
    .describe(
      "Whether the scheduled tick also runs `switchroom vault backup` " +
      "(an encrypted vault/memory snapshot into <path>/vault-backups/) " +
      "before the sync. `off`: sync only. `daily`: an extra once-per-day " +
      "cron leg runs `vault backup && config-repo sync` (the 30-min legs " +
      "stay sync-only). `every_tick`: every tick runs the backup first. " +
      "Default `daily` — the first automated vault backup on this host.",
    ),
});
export type ConfigRepoConfig = z.infer<typeof ConfigRepoConfigSchema>;

export const SwitchroomConfigSchema = z.object({
  switchroom: z.object({
    version: z.literal(1).describe("Config schema version"),
    agents_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "agents_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.switchroom/agents")
      .describe("Base directory for agent installations"),
    skills_dir: z
      .string()
      .regex(
        /^[a-zA-Z0-9~._\-/]+$/,
        "skills_dir must not contain shell-special characters ($, `, \", ', \\, etc.)",
      )
      .default("~/.switchroom/skills")
      .describe(
        "Shared skills pool. Each subdirectory is a named skill " +
        "(matching a switchroom.yaml `skills:` entry). Scaffold symlinks " +
        "selected skills into each agent's skills/ directory."
      ),
    timezone: z
      .string()
      .regex(
        TIMEZONE_REGEX,
        "timezone must be an IANA zone name like 'Australia/Melbourne' or 'UTC'",
      )
      .optional()
      .describe(
        "Global default IANA timezone applied to every agent unless the " +
        "agent (or its profile) declares its own. See the per-agent " +
        "timezone field for the full cascade and auto-detection fallback.",
      ),
  }),
  telegram: TelegramConfigSchema,
  release: RootReleaseBlock.optional().describe(
    "Fleet-wide default release-channel pin / pointer for the update " +
    "flow. Either `channel` (dev|rc|latest) or `pin` (sha-<hex>|v<semver>) " +
    "— mutually exclusive. Per-agent `release` REPLACES this entirely " +
    "(except `auto_update`, which is root-only — a fleet property read by " +
    "hostd's release watcher, never per-agent).",
  ),
  memory: MemoryBackendConfigSchema.optional(),
  hindsight: HindsightConfigSchema.optional().describe(
    "Fleet-singleton Hindsight (memory backend) configuration. Currently " +
    "just the LLM knob (provider + model) used for retain/reflect/" +
    "consolidation. Both fields optional; when unset the container falls " +
    "back to provider=claude-code + the hard-coded HINDSIGHT_DEFAULT_MODEL " +
    "so nothing changes for operators who don't set it. Read at container " +
    "launch by startHindsight() (src/setup/hindsight.ts) — takes effect on " +
    "the next `switchroom apply` / `memory setup --recreate`.",
  ),
  vault: VaultConfigSchema.optional(),
  config_repo: ConfigRepoConfigSchema.optional().describe(
    "Change control for the operator's private ~/.switchroom-config git repo " +
    "(backup + audit trail of live host config, agent workspace state, and " +
    "mirrored personal skills). Consumed by `switchroom config-repo sync` and " +
    "the `config repo` doctor check. Optional and OFF by default.",
  ),
  auth: z
    .object({
      active: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Fleet-wide active Anthropic account label. Every agent without " +
          "an explicit `agent.auth.override` uses this account. See " +
          "docs/auth.md for the full model. Set by `switchroom auth use <label>`.",
        ),
      fallback_order: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Ordered list of account labels for `switchroom auth rotate` to cycle " +
          "through when the active account hits a quota event. First entry is " +
          "normally the same as `auth.active`. When unset, `rotate` is a no-op.",
        ),
      consumers: z
        .array(
          z.object({
            name: z
              .string()
              .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
                message:
                  "Consumer name must be a path-safe slug (letters, digits, underscore, hyphen)",
              })
              .describe("Socket-path identity; binds at /run/switchroom/auth-broker/<name>/sock"),
            account: z
              .string()
              .min(1)
              .optional()
              .describe(
                "Optional pinned account label for this consumer. When set, " +
                "`get-credentials` serves this account (with automatic failover " +
                "while it is quota-exhausted) and `mark-exhausted` from this " +
                "consumer attributes to it — use a pin for quota isolation. " +
                "When omitted, the consumer follows the fleet `auth.active` " +
                "exactly like an agent: same account swaps, same failover.",
              ),
            uid: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe(
                "Optional UID to chown the consumer socket to (defaults to 0 = root, " +
                "suitable for sibling containers running as root).",
              ),
            mirror_dir: z
              .string()
              .optional()
              .describe(
                "Optional host-side directory path. When set, the broker actively " +
                "writes the consumer's effective-account `.credentials.json` mirror " +
                "here — in addition to serving creds on demand via `get-credentials`. " +
                "Use this to eliminate the pull-latency gap: without a mirror the " +
                "consumer only gets failover creds at its next scheduled re-fetch " +
                "(up to 30 min). With a mirror the broker pushes failover creds " +
                "immediately when it detects exhaustion (consumer-quota-sensor tick, " +
                "or a mark-exhausted RPC on the pinned account). The directory must " +
                "be accessible to the broker container (bind-mounted from the host) " +
                "and to the consumer container; the broker writes " +
                "`<mirror_dir>/.credentials.json` atomically. Chown is attempted to " +
                "`uid` (default 0) — swallowed when CAP_CHOWN is absent.",
              ),
          }),
        )
        .optional()
        .describe(
          "Non-agent peers that hold a broker socket (RFC H §4.8). Each gets " +
          "its own `/run/switchroom/auth-broker/<name>/sock` chowned to its UID. " +
          "Consumers cannot be admins; a consumer name that collides with an " +
          "agent (whether that agent has `admin: true` or not) is a config " +
          "error caught at schema validation.",
        ),
      proactive_failover_pct: z
        .number()
        .min(1)
        .max(99)
        .optional()
        .describe(
          "Soft-avoid threshold (percent) for proactive auth failover (#3031). " +
          "When set (e.g. 95), an account whose fresh 7-day utilization is at/" +
          "above this value — or whose 5h utilization is at/above min(pct+3, " +
          "98) — enters the SOFT-AVOID preference tier: the broker prefers a " +
          "fully-eligible fallback account on the serving path, without ever " +
          "blocking the account (the hard wall stays 99.5). Enter/exit uses " +
          "hysteresis (exit below pct-5 or on window reset) so the preference " +
          "does not flap between probe ticks. Accounts serving past the wall " +
          "via `allow_overage_accounts` are never soft-avoided. UNSET (the " +
          "default) disables the tier entirely — behavior is identical to a " +
          "fleet without this field.",
        ),
      allow_overage_accounts: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Opt-in list of account labels (bare strings matching `auth.active` / " +
          "`auth.fallback_order` entries) that may be served PAST the weekly " +
          "utilization wall when Anthropic overage billing is available for the " +
          "account (`overageStatus === 'allowed'`). Overage is REAL MONEY — " +
          "default is empty (no account gets this). An account in this list is " +
          "only kept eligible when its fresh quota snapshot reports " +
          "`overageStatus: 'allowed'` AND `overageDisabledReason` is NOT " +
          "'out_of_credits' (i.e. the overage credit has not been exhausted). " +
          "As soon as `overageDisabledReason` becomes 'out_of_credits', the " +
          "account is blocked immediately regardless of this flag. Overage lifts " +
          "ONLY the utilization wall — it cannot lift an active exhaustion mark " +
          "written by a real 429 (`mark-exhausted`).",
        ),
    })
    .optional()
    .describe(
      "Switchroom-auth-broker configuration (RFC H). Fleet-wide active account, " +
      "fallback order, admin-agent ACL, and ephemeral-consumer surface. " +
      "Required from the v0.8+ schema onwards; pre-v0.8 fleets are migrated " +
      "in-place by `switchroom apply` (see src/auth/migrate-schema.ts).",
    ),
  drive: GoogleWorkspaceConfigSchema.describe(
    "RFC D legacy key — use `google_workspace:` instead. Optional Google " +
    "Workspace onboarding configuration. When set, supplies Google OAuth " +
    "client credentials, the approver allowlist for `switchroom drive " +
    "connect`, and the optional tier knob. Env vars " +
    "(SWITCHROOM_GOOGLE_CLIENT_ID, SWITCHROOM_GOOGLE_CLIENT_SECRET, " +
    "SWITCHROOM_APPROVER_USER_ID) take precedence over this block when " +
    "set, preserving back-compat with the env-only flow shipped in #766.",
  ),
  google_workspace: GoogleWorkspaceConfigSchema.describe(
    "RFC G canonical key. Top-level Google Workspace configuration — " +
    "OAuth client credentials, approver allowlist, and tier knob (`core` " +
    "| `extended` | `complete`, default `core`). Mutually exclusive with " +
    "`drive:` at the top level (loader fails fast if both are set).",
  ),
  litellm: LiteLLMConfigSchema.describe(
    "Top-level LiteLLM routing infra — global base_url, admin_key (the " +
    "LiteLLM master key, supports a `vault:` ref), team alias, and " +
    "small_fast_model shared by every agent that opts in. Set `enabled: " +
    "true` here to default the whole fleet on (each agent can still set " +
    "`litellm.enabled: false` to opt out). Default OFF.",
  ),
  microsoft_workspace: MicrosoftWorkspaceConfigSchema.describe(
    "RFC #1873 (Microsoft 365 integration). Top-level Microsoft Workspace " +
    "configuration — OAuth client credentials (Entra app), authority " +
    "endpoint (defaults to /common for personal MSA + work), and the " +
    "org_mode opt-in for Teams/SharePoint surfaces. Block is optional; " +
    "when omitted the broker does not register the Microsoft provider.",
  ),
  notion_workspace: NotionWorkspaceConfigSchema.describe(
    "RFC reference/rfcs/notion-integration.md. Top-level Notion integration " +
    "config — vault key for the integration token, friendly-name → " +
    "database UUID map, optional MCP-package version pin, and optional " +
    "global rate-limit override (default 3 rps, Notion's documented " +
    "public-API limit). Block is optional; when omitted no agent gets a " +
    "Notion MCP entry regardless of per-agent config.",
  ),
  quota: QuotaConfigSchema.optional().describe(
    "Optional weekly/monthly USD spend budgets rendered in the session " +
    "greeting. Usage is read from ccusage at runtime; no network calls.",
  ),
  host_control: HostControlConfigSchema.default({}).describe(
    "Host-control daemon configuration. Defaults to enabled=true since " +
    "RFC C Phase 2 (reference/rfcs/host-control-daemon.md). Omit the block " +
    "to accept defaults; set `enabled: false` only on legacy systemd-" +
    "mode installs (removal tracked as RFC C Phase 3).",
  ),
  hostd: HostdConfigSchema.default({}).describe(
    "hostd verb-level knobs (RFC admin-agent-config-edit). Distinct " +
    "from `host_control:` which governs whether the daemon runs at " +
    "all. Scopes the opt-in flag and rate cap for the " +
    "`config_propose_edit` verb (disabled by default).",
  ),
  fleet_health: FleetHealthConfigSchema.default({}).describe(
    "Fleet Health — job-spec-anchored, operator-facing issue tracker (RFC " +
    "fleet-health.md, serves fleet-stays-healthy). Assigns the owner agent " +
    "that runs the nightly model-free sensor + weekly deep-dive. Default " +
    "unset owner_agent → inert; the admin page renders an empty state.",
  ),
  web_service: WebServiceConfigSchema.default({}).describe(
    "Web-service container (dashboard + GitHub-webhook receiver) config. " +
    "Defaults to managed=false so existing systemd-mode installs are " +
    "untouched. Set managed: true after cutting over to the " +
    "`switchroom-web` container — then `switchroom update` keeps it " +
    "refreshed. See `switchroom webd install`.",
  ),
  google_accounts: z
    .record(
      // Google account email — case-insensitive on Google's side, so we
      // normalize via z.string().toLowerCase().trim() so the schema-level
      // key matches the lowercase form vault slots are written under.
      // Without this, a config key `Alice@Example.com` would write its
      // slot at `google:alice@example.com:refresh_token` per
      // normalizeGoogleAccount() but the broker's google_accounts[]
      // lookup would miss (broker normalizes the slot-key side, not the
      // config-key side). Schema-level normalization closes that gap.
      //
      // Validation: must contain @ + dot, must NOT contain `:` (the
      // broker's slot-key parser uses `:` as the field separator —
      // a colon in the local-part would write a slot the broker can't
      // reverse-parse, silently rendering it unreachable). Strict email
      // validation (RFC 5321 etc.) belongs at the CLI layer where we
      // can give an actionable error; this is the load-bearing minimum.
      z.string()
        .regex(/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/, {
          message: "Account key must be a Google account email like 'alice@example.com' (colons not allowed)",
        })
        .transform((v) => v.trim().toLowerCase()),
      z.object({
        enabled_for: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,50}$/, {
            message: "Agent name must match the standard agent-name pattern",
          }))
          .describe(
            "Agent slugs that may read this account's vault slots " +
            "(`google:<account>:refresh_token` etc). Per-agent ACL is " +
            "enforced at the broker, not at the agent identity layer — " +
            "the agent still authenticates via socket-path-as-identity " +
            "per RFC D §4.1, broker just gates the cross-agent token share."
          ),
        readonly: z
          .boolean()
          .optional()
          .describe(
            "Per-account read-only selection (v1 scope model). true → the " +
            "token minted by `auth google account add` carries ONLY " +
            ".readonly scope variants (zero write scopes), and the gdrive " +
            "MCP launcher passes upstream `--read-only` so write tools are " +
            "not exposed. Written by `account add --readonly`; re-read on " +
            "`--replace` so a re-consent cannot silently re-widen. Omitted " +
            "= legacy behaviour (tier-tied read-write document scopes)."
          ),
        services: z
          .array(GoogleServiceTokenSchema)
          .min(1)
          .optional()
          .describe(
            "Per-account service selection (v1 scope model). Which Google " +
            "services the minted token covers AND the gdrive MCP exposes " +
            "(upstream `--tools`): cal, drive, docs, sheets, slides. " +
            "Written by `account add --services`; re-read on `--replace`. " +
            "Omitted = the tier's default services (drive,docs,sheets; " +
            "+slides at extended/complete)."
          ),
      }),
    )
    .optional()
    .describe(
      "RFC G Phase 2: per-Google-account ACL for vault slots holding " +
      "OAuth refresh tokens. Maps account email → list of agents " +
      "permitted to read that account's slots. Written by `switchroom " +
      "auth google enable|disable` (Phase 3); read by the broker on " +
      "every Google slot access. Replaces RFC D's per-agent vault slot " +
      "scope (which can't express 'two agents share one Google account')."
    ),
  microsoft_accounts: z
    .record(
      z.string()
        .regex(/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/, {
          message: "Account key must be a Microsoft account email like 'alice@outlook.com' or 'alice@contoso.com' (colons not allowed)",
        })
        .transform((v) => v.trim().toLowerCase()),
      z.object({
        enabled_for: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,50}$/, {
            message: "Agent name must match the standard agent-name pattern",
          }))
          .describe(
            "Agent slugs that may read this Microsoft account's broker " +
            "credentials. Per-agent ACL enforced at the broker; agents " +
            "still authenticate via socket-path-as-identity, broker just " +
            "gates the cross-agent token share. Mirrors google_accounts."
          ),
      }),
    )
    .optional()
    .describe(
      "RFC #1873: per-Microsoft-account ACL. Maps account email → list of " +
      "agents permitted to use that account's broker credentials. Written " +
      "by `switchroom auth microsoft enable|disable`; read by the broker " +
      "on get-credentials with provider=microsoft."
    ),
  defaults: AgentDefaultsSchema.describe(
    "Implicit bottom-of-cascade profile applied to every agent before " +
    "per-agent config and `extends:` resolution. Tools, mcp_servers, and " +
    "schedule are unioned/concatenated; scalars and nested objects are " +
    "shallow-merged with per-agent values winning.",
  ),
  profiles: z
    .record(z.string(), ProfileSchema)
    .optional()
    .describe(
      "Named profile definitions. Agents reference via `extends: <name>`. " +
      "Inline profiles declared here take priority over filesystem " +
      "profiles/<name>/ directories when both exist.",
    ),
  users: z
    .record(z.string(), UserSchema)
    .optional()
    .describe(
      "Trusted users the fleet serves — each a Telegram identity plus a " +
      "memory profile bank. Assigned to agents via `serves` / `knows`. The " +
      "operator's own trusted people (single-tenant), not multi-tenant. See " +
      "reference/rfcs/user-concept.md.",
    ),
  agents: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,50}$/, {
        message: "Agent name must start with a letter/digit, contain only lowercase letters/digits/hyphens/underscores, and be at most 51 characters (Telegram callback_data byte limit)",
      }),
      AgentSchema,
    )
    .describe("Map of agent name to agent configuration"),
  cron: CronConfigSchema.optional().describe(
    "Cheap-cron settings (reference/rfcs/cheap-cron-sessions.md). Operator-owned " +
    "egress allowlist + host-pinned secret bindings for Tier-0 http-diff " +
    "polls (§6.1). Required to enable any http-diff poll; not agent-writable.",
  ),
}).superRefine((cfg, ctx) => {
  // Every `serves` entry must name a user defined in the top-level `users:`
  // block (a typo would silently route nothing). `knows` is permissive — an
  // entry may be a user OR a raw bank name, so it is not checked here.
  const userKeys = new Set(Object.keys(cfg.users ?? {}));
  const checkServes = (
    serves: readonly string[] | undefined,
    path: (string | number)[],
  ) => {
    (serves ?? []).forEach((s, i) => {
      if (!userKeys.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `serves references unknown user "${s}" — add it to the top-level ` +
            "`users:` block (or did you mean `knows` for a raw bank name?)",
          path: [...path, i],
        });
      }
    });
  };
  checkServes(cfg.defaults?.serves, ["defaults", "serves"]);
  for (const [name, p] of Object.entries(cfg.profiles ?? {})) {
    checkServes((p as { serves?: string[] }).serves, ["profiles", name, "serves"]);
  }
  for (const [name, a] of Object.entries(cfg.agents ?? {})) {
    checkServes((a as { serves?: string[] }).serves, ["agents", name, "serves"]);
  }

  // Multi-account-per-agent: for the PLURAL `microsoft_workspace.accounts`
  // form, EVERY bound account must list this agent in
  // `microsoft_accounts.<account>.enabled_for[]` — the twin-key gate,
  // applied per account. A missing pair is a loud load-time error (mirrors
  // the broker's FORBIDDEN hint) rather than a silently-missing tool
  // namespace. The singular `account` form keeps its lenient
  // emit-iff-enabled behavior (no hard error) for back-compat.
  //
  // DECISION (review 2026-07-17, Finding 3): the fleet-wide hard-fail is
  // DELIBERATE and asymmetric with the singular form by design. Zod parse is
  // all-or-nothing — there is no per-agent scoping at this layer — and a
  // multi-account misconfig is an operator authoring error that should be
  // caught at `switchroom apply`/load time, not silently drop one agent's
  // M365 surface (which is much harder to notice than a failed load). The
  // singular form stays lenient ONLY for back-compat with configs authored
  // before the twin-key gate existed; new plural authors opt into the strict
  // gate. Per-agent-scoped degradation (load the rest of the fleet, disable
  // just the offending agent's M365) is tracked as a follow-up — it needs
  // loader-level support, not a schema tweak.
  // Exclusive account pins: an account marked `exclusive` on one agent's
  // pin must not be routable to anyone else. Every config path that would
  // serve it elsewhere — fleet active, fallback_order, another agent's
  // override, a consumer pin — is a load-time error. The broker enforces
  // the same invariant at runtime for hot-mutated config (set-active /
  // set-override); this check catches the authored yaml before it loads.
  for (const [name, a] of Object.entries(cfg.agents ?? {})) {
    const agentAuth = (a as { auth?: { override?: string; exclusive?: boolean } }).auth;
    if (!agentAuth?.exclusive || !agentAuth.override) continue;
    const acct = agentAuth.override;
    if (cfg.auth?.active === acct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `account '${acct}' is exclusive to agent '${name}' ` +
          `(agents.${name}.auth.exclusive) — it cannot be the fleet \`auth.active\``,
        path: ["auth", "active"],
      });
    }
    const fbIdx = (cfg.auth?.fallback_order ?? []).indexOf(acct);
    if (fbIdx !== -1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `account '${acct}' is exclusive to agent '${name}' ` +
          `(agents.${name}.auth.exclusive) — it cannot appear in \`auth.fallback_order\``,
        path: ["auth", "fallback_order", fbIdx],
      });
    }
    for (const [other, oa] of Object.entries(cfg.agents ?? {})) {
      if (other === name) continue;
      const otherOverride = (oa as { auth?: { override?: string } }).auth?.override;
      if (otherOverride === acct) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `account '${acct}' is exclusive to agent '${name}' ` +
            `(agents.${name}.auth.exclusive) — agent '${other}' cannot pin it`,
          path: ["agents", other, "auth", "override"],
        });
      }
    }
    (cfg.auth?.consumers ?? []).forEach((c, i) => {
      if (c.account === acct) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `account '${acct}' is exclusive to agent '${name}' ` +
            `(agents.${name}.auth.exclusive) — consumer '${c.name}' cannot pin it`,
          path: ["auth", "consumers", i, "account"],
        });
      }
    });
  }

  const microsoftAccounts = (cfg as {
    microsoft_accounts?: Record<string, { enabled_for?: string[] } | undefined>;
  }).microsoft_accounts;
  for (const [name, a] of Object.entries(cfg.agents ?? {})) {
    const mw = (a as { microsoft_workspace?: { accounts?: Array<{ account?: string }> } })
      .microsoft_workspace;
    const accounts = mw?.accounts;
    if (!accounts) continue;
    accounts.forEach((b, i) => {
      const acct = b?.account?.trim().toLowerCase();
      if (!acct) return;
      const enabledFor = microsoftAccounts?.[acct]?.enabled_for ?? [];
      if (!enabledFor.includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `agent '${name}' binds Microsoft account '${acct}' but is not in ` +
            `microsoft_accounts['${acct}'].enabled_for[] — operator must run ` +
            `\`switchroom auth microsoft enable ${acct} ${name}\``,
          path: ["agents", name, "microsoft_workspace", "accounts", i, "account"],
        });
      }
    });
  }
});

export type SwitchroomConfig = z.infer<typeof SwitchroomConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type AgentHooks = z.infer<typeof AgentHooksSchema>;
export type HookEntry = z.infer<typeof HookEntrySchema>;
export type Channels = z.infer<typeof ChannelsSchema>;
export type TelegramChannel = z.infer<typeof TelegramChannelSchema>;
export type BuzzChannel = z.infer<typeof BuzzChannelSchema>;
export type AgentSoul = z.infer<typeof AgentSoulSchema>;
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type PollSpec = z.infer<typeof PollSpecSchema>;
export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type MemoryBackendConfig = z.infer<typeof MemoryBackendConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;
export type DriveConfig = z.infer<typeof DriveConfigSchema>;
export type LiteLLMConfig = z.infer<typeof LiteLLMConfigSchema>;
export type HindsightConfig = z.infer<typeof HindsightConfigSchema>;
export type AgentDriveConfig = z.infer<typeof AgentDriveConfigSchema>;
export type VaultBrokerConfig = z.infer<typeof VaultConfigSchema>["broker"];
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;
export type HostControlConfig = z.infer<typeof HostControlConfigSchema>;
export type AutoReleaseCheck = z.infer<typeof AutoReleaseCheckSchema>;
export type HostdConfig = z.infer<typeof HostdConfigSchema>;
export type AuthConfig = NonNullable<z.infer<typeof SwitchroomConfigSchema>["auth"]>;
export type AuthConsumer = NonNullable<AuthConfig["consumers"]>[number];
export type CodeRepoEntry = z.infer<typeof CodeRepoEntrySchema>;
export type AgentBindMount = z.infer<typeof AgentBindMountSchema>;
export type AgentRepoEntry = NonNullable<z.infer<typeof AgentSchema>["repos"]>[string];
