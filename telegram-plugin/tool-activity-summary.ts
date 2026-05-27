/**
 * Tool-activity summary — Claude Code-style natural-language progress
 * line that batches tool_use events for a turn into a single Telegram
 * message that updates in place.
 *
 * Replaces the per-tool intent surface (#1924). The screenshot from
 * Claude Code's own UI shows lines like:
 *
 *   "Ran 5 commands, read a file"
 *   "Edited a file, read a file, ran a command"
 *
 * Past tense, comma-joined, singular/plural-aware. One message per
 * "phase" (turn start → first reply), progressively edited as tools
 * accumulate. NOT raw tool calls — descriptions of what the agent has
 * been doing.
 *
 * Why this beats per-tool labels:
 *   - One Telegram message per phase (low signal-to-noise vs N
 *     messages on a heavy turn)
 *   - The user sees ACCUMULATED work in a glanceable form, not a flood
 *   - Plays nicely with the existing answer-lane stream that handles
 *     the actual reply text
 *
 * Tracking shape: per-turn counters keyed by `verb` (the action class
 * derived from tool name). One counter per verb so the summary line
 * collapses neatly regardless of which specific Read/Bash/WebSearch
 * the model chose. `register()` increments the counter; `formatSummary()`
 * renders the current state.
 */

const READ_VERBS = new Set(["read"]);
const WRITE_VERBS = new Set(["wrote", "created", "edited"]);

export type ActivityVerb =
  | "read"
  | "edited"
  | "created"
  | "ran"
  | "searched"
  | "fetched"
  | "dispatched"
  | "noted"
  | "used"; // generic fallback

/** Object form so `register()` can mutate; pure functions inside the
 *  module work against this shape (easier to unit-test than a Map). */
export interface ActivityState {
  counts: Partial<Record<ActivityVerb, number>>;
  /** Order verbs were first observed this turn. The summary renders in
   *  this order so the line reads as a chronological natural-language
   *  account: "edited a file, read a file, ran a command" matches the
   *  agent's actual sequence of actions. Stable — once a verb is added
   *  to this list, it never moves. */
  order: ActivityVerb[];
  /** First non-trivial tool name observed this turn (for telemetry / future
   *  "what kicked this off" forensic). Not used in the rendered summary. */
  firstToolName: string | null;
}

export function makeEmptyActivityState(): ActivityState {
  return { counts: {}, order: [], firstToolName: null };
}

/** Map a tool name → verb. Mirrors the existing `tool-intent-surface.ts`
 *  verb table but in past tense. Tools that don't map (or surface tools
 *  like reply/stream_reply) return null — the caller skips them. */
export function verbForTool(toolName: string): ActivityVerb | null {
  if (!toolName) return null;
  const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(toolName);
  // Skip user-facing Telegram-plugin tools entirely — those ARE the
  // surface, never to be summarised.
  if (mcpMatch && mcpMatch[1] === "switchroom-telegram") return null;
  const suffix = (mcpMatch ? mcpMatch[2] : toolName).toLowerCase();
  switch (suffix) {
    case "read":
      return "read";
    case "write":
      return "created";
    case "edit":
    case "multiedit":
    case "notebookedit":
      return "edited";
    case "bash":
    case "bashoutput":
    case "killshell":
      return "ran";
    case "websearch":
    case "grep":
    case "glob":
      return "searched";
    case "webfetch":
      return "fetched";
    case "task":
    case "agent":
      return "dispatched";
    case "todowrite":
    case "todoread":
      return "noted";
    default:
      return "used";
  }
}

/** Mutates `state` to record one tool_use of `toolName`. Returns true
 *  iff the activity state changed (so the caller knows to refresh the
 *  rendered summary). */
export function register(state: ActivityState, toolName: string): boolean {
  const verb = verbForTool(toolName);
  if (!verb) return false;
  if (state.firstToolName == null) state.firstToolName = toolName;
  const prior = state.counts[verb] ?? 0;
  if (prior === 0) state.order.push(verb);
  state.counts[verb] = prior + 1;
  return true;
}

interface VerbPhrase {
  singular: string;
  plural: string;
}

const VERB_PHRASE: Record<ActivityVerb, VerbPhrase> = {
  read: { singular: "read a file", plural: "read $N files" },
  edited: { singular: "edited a file", plural: "edited $N files" },
  created: { singular: "created a file", plural: "created $N files" },
  ran: { singular: "ran a command", plural: "ran $N commands" },
  searched: { singular: "ran a search", plural: "ran $N searches" },
  fetched: { singular: "fetched a URL", plural: "fetched $N URLs" },
  dispatched: { singular: "dispatched a sub-agent", plural: "dispatched $N sub-agents" },
  noted: { singular: "updated the todo list", plural: "updated the todo list ($N edits)" },
  used: { singular: "used a tool", plural: "used $N tools" },
};

/** Render the activity state as a single natural-language line.
 *  Verbs are rendered in `state.order` — first-occurrence order — so
 *  the line reads chronologically ("edited a file, read a file, ran
 *  a command" mirrors the agent's actual action sequence). Returns
 *  null when the state is empty (nothing to show yet). */
export function formatSummary(state: ActivityState): string | null {
  const phrases: string[] = [];
  for (const verb of state.order) {
    const n = state.counts[verb] ?? 0;
    if (n <= 0) continue;
    const p = VERB_PHRASE[verb];
    phrases.push(n === 1 ? p.singular : p.plural.replace("$N", String(n)));
  }
  if (phrases.length === 0) return null;
  // Capitalize first letter so the sentence reads as a statement.
  const sentence = phrases.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Convenience: ergonomic full pipeline for callers that just want
 *  "given the new tool name and prior state, give me the updated rendered
 *  text or null if nothing changed". Returns null when the tool is a
 *  surface tool / no-op (so the caller can skip the Telegram edit). */
export function registerAndRender(
  state: ActivityState,
  toolName: string,
): string | null {
  const changed = register(state, toolName);
  if (!changed) return null;
  return formatSummary(state);
}
