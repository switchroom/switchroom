/**
 * Shared model-alias tables and the ONE expansion every switchroom-side model
 * token flows through.
 *
 * This is the single source of truth consumed by BOTH sites that turn a
 * user/operator-supplied model token into a canonical `claude --model` value:
 *
 *   - the gateway `/model` command (`telegram-plugin/gateway/model-command.ts`,
 *     which re-exports these for its existing public API), and
 *   - config-default resolution at scaffold time
 *     (`resolveMainModel` / `normalizeModelAlias` in `scaffold.ts`).
 *
 * Before this module existed the two sites carried DIVERGENT alias tables:
 * scaffold expanded only `claude-fable-5 → fable`, so a config
 * `model: opus48` (a shortcut the gateway `/model` path happily expands to
 * `claude-opus-4-8`) was launched VERBATIM as `opus48` — a token the claude CLI
 * cannot resolve. Sharing one table kills that divergence class: every alias
 * the gateway accepts now resolves identically in scaffold.
 */

/**
 * Short SWITCHROOM-side spellings for pinned **Anthropic** model ids. These are
 * expanded to the full `claude-*` id on the `/model` path BEFORE any
 * Claude-vs-external classification runs, so what reaches the `.session-model`
 * carrier (and therefore `claude --model`) is always the canonical id — the CLI
 * never sees the short spelling.
 *
 * Deliberately NOT `SR_MODEL_ALIASES`: that map means "external / OpenRouter /
 * the Anthropic OAuth header is NOT forwarded". These targets are Anthropic
 * OAuth-passthrough models, so putting them there would flip the
 * header-forwarding + external-billing classification and surface them under the
 * "🌐 External models" keyboard page with an `srFriendlyLabel`.
 *
 * Also NOT `MODEL_ALIASES`: that list is the aliases the claude CLI resolves
 * *itself*, and its members double as FAMILY tokens in `modelFamilyToken` /
 * `canonicalClaudeToken` / `servedModelMatchesRequested`. A pinned-id shortcut
 * is neither.
 *
 * NB the repo prefers family aliases over pinned ids (an alias tracks the
 * current flagship, a pinned id goes stale) — these exist because an operator
 * sometimes wants a specific pinned Opus, and typing `claude-opus-4-8` on a
 * phone is hostile. Keys are matched case-insensitively.
 */
export const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus48: 'claude-opus-4-8',
  'opus-4-8': 'claude-opus-4-8',
}

/**
 * Short text-command aliases for sr-* models. These let the operator type
 * `/model flash`, `/model codex`, etc. instead of the full `sr-*` id.
 * Expanded in handleModelCommand before injection; the full sr-* id is what
 * reaches the agent session and LiteLLM.
 */
export const SR_MODEL_ALIASES: Record<string, string> = {
  flash: 'sr-gemini-2.5-flash',
  gemini: 'sr-gemini-2.5-pro',
  deepseek: 'sr-deepseek-v3',
  r1: 'sr-deepseek-r1',
  glm: 'sr-glm-5',
  codex: 'sr-codex-5.5',
  // Flagship keyboard buttons for the three providers added 2026-07-19. Each
  // points at that provider's top tier; the cheaper tiers (grok-4.3,
  // kimi-k2.7-code, gpt-5.6-terra/luna) stay typeable via `/model sr-<id>` and
  // keep a friendly label above, matching the "labels are a superset of buttons"
  // design (SR_MODEL_LABELS doc comment).
  grok: 'sr-grok-4.5',
  kimi: 'sr-kimi-k3',
  gpt: 'sr-gpt-5.6-sol',
  // Per-tier buttons for the GPT-5.6 line so each is a one-word shortcut
  // (`gpt` stays the flagship-Sol default). Added 2026-07-19.
  sol: 'sr-gpt-5.6-sol',
  terra: 'sr-gpt-5.6-terra',
  luna: 'sr-gpt-5.6-luna',
}

/** Expand a short alias (case-insensitive) to its full sr-* id, or return the original. */
export function expandSrAlias(arg: string): string {
  return SR_MODEL_ALIASES[arg.toLowerCase()] ?? arg
}

/** Expand a short pinned-Claude spelling (case-insensitive) to its full `claude-*` id. */
export function expandClaudeAlias(arg: string): string {
  return CLAUDE_MODEL_ALIASES[arg.trim().toLowerCase()] ?? arg
}

/**
 * The ONE canonical form of a model token — what `claude --model` is handed and
 * what every downstream gate compares against.
 *
 * Two normalizations, both narrow:
 *   - **trim** — unconditional. `unvalidatedIdCaveat` already trimmed while
 *     expansion did not, so the two disagreed on a padded token.
 *   - **lowercase, `claude-*` ONLY.** Every real Anthropic model id is lowercase
 *     and a phone autocapitalizes, so `/model Claude-Opus-4-8` used to be launched
 *     VERBATIM as an unvalidated id while the caveat exemption (which lowercases)
 *     suppressed the warning — a clean green ack for a token the caveat was
 *     written for. Non-`claude-` tokens are left alone: `sr-*` ids are matched
 *     case-insensitively by their own maps, and rewriting an arbitrary external
 *     id's case is not ours to do.
 *
 * Applied by `expandModelAlias`, so canonicalization happens on every `/model`
 * path (typed apply, mid-turn queue, menu tap, queued-across-restart persist)
 * whether or not the token hit a shortcut map — one canonical form flows to
 * `claude --model`, and `unvalidatedIdCaveat` sees exactly that form.
 */
export function canonicalModelToken(arg: string): string {
  const trimmed = arg.trim()
  const lower = trimmed.toLowerCase()
  return lower.startsWith('claude-') ? lower : trimmed
}

/**
 * The ONE expansion every `/model` argument goes through, on every path that
 * consumes a user-supplied token (typed apply, mid-turn queue, menu tap,
 * queued-across-restart persist). Claude shortcuts resolve first, then sr-*
 * shortcuts; the two key sets are disjoint by construction (a Claude shortcut
 * never expands to an `sr-*` id and vice versa), so order only documents intent.
 * The result is `canonicalModelToken`-normalized, so a miss can no longer emit a
 * verbatim mixed-case `claude-*` id that the caveat exemption then mis-matches.
 *
 * Expanding HERE — before `isClaudeModel` / `isSrModel` / `externalModelNames`
 * ever see the token — is what keeps a pinned-Claude shortcut on the Anthropic
 * OAuth passthrough instead of being misread as an external route.
 */
export function expandModelAlias(arg: string): string {
  return canonicalModelToken(expandSrAlias(expandClaudeAlias(arg)))
}
