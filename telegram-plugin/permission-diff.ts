/**
 * Pure (no-I/O) helpers for the durable "🔁 Always allow" flow (#1977).
 *
 * The Telegram permission card's "Always allow" button used to shell
 * `switchroom agent grant <agent> <rule>` which writes
 * `/state/config/switchroom.yaml` — but that path is bind-mounted
 * READ-ONLY into agent containers, so the write silently no-op'd.
 * Durable host-config writes only land via the host-side `hostd`
 * daemon's `config_propose_edit` flow, which takes a unified diff and
 * runs it through `git apply --recount` against the live config.
 *
 * {@link synthesizeAllowRuleDiff} builds that diff by operating on the
 * *literal* config text (never a parsed/merged object) so the diff's
 * context lines byte-match the on-disk file — a requirement for
 * `git apply` to succeed.
 *
 * {@link extractAddedAllowRule} is the inverse parse used by the
 * single-tap auto-approve correlation: it returns the single
 * `tools.allow` rule a diff adds, so the gateway can confirm that an
 * inbound `request_config_approval` corresponds to a rule IT just
 * queued (and so auto-approve without a second card), while any
 * uncorrelated / forged edit still posts a real operator card.
 *
 * No file I/O, no yaml parsing of structure — deliberately. Callers
 * read the raw config bytes and feed them in.
 */

const TARGET_HEADER_A = "--- a/switchroom.yaml";
const TARGET_HEADER_B = "+++ b/switchroom.yaml";

export interface SynthesizeAllowRuleDiffArgs {
  /** Agent whose `tools.allow` gains the rule. */
  agentName: string;
  /** The rule token (e.g. `Bash`, `Skill(mail)`, `mcp__x__y`). */
  rule: string;
  /** RAW config file bytes (LF). NOT a parsed/merged object. */
  configText: string;
}

/** Internal: a 0-based line index range describing a located block. */
interface AgentBlock {
  /** Indentation (spaces) of the `<agentName>:` key line. */
  agentIndent: number;
  /** 0-based index of the `<agentName>:` line. */
  agentLineIdx: number;
  /** 0-based index just past the agent block (exclusive). */
  agentBlockEnd: number;
}

/** Count leading spaces of a line. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** True if the line is blank or a comment (ignored for block scans). */
function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("#");
}

/**
 * Locate the `agents:` → `<agentName>:` block in raw config text.
 * Returns the agent key line index, its indentation, and the
 * exclusive end of its block (first subsequent non-blank line at an
 * indent ≤ the agent key's indent). Returns null if not found.
 */
function locateAgentBlock(
  lines: string[],
  agentName: string,
): AgentBlock | null {
  // Find a top-level `agents:` key (indent 0 by convention, but be
  // lenient: any line whose trimmed form is exactly `agents:`).
  let agentsIdx = -1;
  let agentsIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    if (line.trim() === "agents:") {
      agentsIdx = i;
      agentsIndent = indentOf(line);
      break;
    }
  }
  if (agentsIdx === -1) return null;

  // The agent keys are the first indent level deeper than `agents:`.
  // Scan within the agents block for `<agentName>:`.
  let childIndent = -1;
  for (let i = agentsIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= agentsIndent) break; // left the agents block
    if (childIndent === -1) childIndent = ind;
    if (ind !== childIndent) continue; // nested deeper — not an agent key
    const key = line.slice(ind).split(":")[0]!.trim();
    if (key === agentName) {
      // Found it. Now find the block end.
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const l2 = lines[j]!;
        if (isBlankOrComment(l2)) continue;
        if (indentOf(l2) <= ind) {
          end = j;
          break;
        }
      }
      return { agentIndent: ind, agentLineIdx: i, agentBlockEnd: end };
    }
  }
  return null;
}

/** Locate the `tools:` line within an agent block (or null). */
function locateToolsLine(
  lines: string[],
  block: AgentBlock,
): { idx: number; indent: number } | null {
  for (let i = block.agentLineIdx + 1; i < block.agentBlockEnd; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= block.agentIndent) break;
    const key = line.slice(ind).split(":")[0]!.trim();
    if (key === "tools" && ind === block.agentIndent + 2) {
      return { idx: i, indent: ind };
    }
  }
  return null;
}

/**
 * Locate the `allow:` line within a `tools:` mapping. Returns its
 * index, indent, and whether it is a flow list (`allow: [..]`) or a
 * block sequence (`allow:` then `- x` lines).
 */
function locateAllowLine(
  lines: string[],
  toolsIdx: number,
  toolsIndent: number,
  blockEnd: number,
): { idx: number; indent: number; inline: string } | null {
  for (let i = toolsIdx + 1; i < blockEnd; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= toolsIndent) break; // left the tools mapping
    const key = line.slice(ind).split(":")[0]!.trim();
    if (key === "allow" && ind === toolsIndent + 2) {
      const after = line.slice(line.indexOf(":") + 1);
      return { idx: i, indent: ind, inline: after };
    }
  }
  return null;
}

/** Internal: a located multi-line flow list (`allow:` then `[` on a
 * subsequent line, one entry per line, closing `]` on its own line — the
 * shape clerk's config uses, `switchroom.yaml:507-514`). */
interface MultilineFlowList {
  /** 0-based index of the line containing the opening `[`. */
  openIdx: number;
  /** 0-based index of the line containing the matching closing `]`. */
  closeIdx: number;
  /** Indentation to use for a newly-inserted entry line. */
  itemIndent: number;
  /** 0-based index of the last existing entry line, or -1 if the list is
   * empty (`[` immediately followed by `]`, possibly across lines). */
  lastEntryIdx: number;
}

/**
 * Scan forward from `scanStart` (the line right after `allow:` when its
 * inline remainder is empty) for a flow list whose opening `[` is on its
 * OWN subsequent line (issue #2973 — clerk's exact shape). Tracks bracket
 * depth char-by-char so a matching `]` is found even several lines down.
 * Returns null if the first non-blank/comment line doesn't open a flow
 * list, or the list is unterminated within the block.
 */
function locateMultilineFlowList(
  lines: string[],
  scanStart: number,
  blockEnd: number,
): MultilineFlowList | null {
  let i = scanStart;
  while (i < blockEnd && isBlankOrComment(lines[i]!)) i++;
  if (i >= blockEnd) return null;
  const firstLine = lines[i]!;
  if (!firstLine.trim().startsWith("[")) return null;
  const openIdx = i;

  let depth = 0;
  let closeIdx = -1;
  for (let j = openIdx; j < blockEnd && closeIdx === -1; j++) {
    const line = lines[j]!;
    for (const ch of line) {
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          closeIdx = j;
          break;
        }
      }
    }
  }
  if (closeIdx === -1) return null; // unterminated — caller falls back.

  // Entry lines: strictly between the open and close bracket lines,
  // one per line (the observed shape). Lines that carry entries AND a
  // bracket on the same line (e.g. inline `[ all,`) aren't split out
  // here — they're handled upstream by the single-line flow-list case.
  let lastEntryIdx = -1;
  for (let j = openIdx + 1; j < closeIdx; j++) {
    if (isBlankOrComment(lines[j]!)) continue;
    lastEntryIdx = j;
  }
  const itemIndent =
    lastEntryIdx !== -1 ? indentOf(lines[lastEntryIdx]!) : indentOf(firstLine) + 2;

  return { openIdx, closeIdx, itemIndent, lastEntryIdx };
}

/**
 * Build a unified-diff hunk from a contiguous slice of the original
 * file. `lines` is the whole file split on `\n`. The hunk replaces the
 * lines in `[changeStart, changeEnd)` with `replacement` (an array of
 * raw lines, no leading `+`). `contextN` context lines are copied
 * verbatim before and after. `@@` numbers are best-effort (hostd runs
 * `git apply --recount`), but context lines byte-match the source.
 */
function buildHunk(
  lines: string[],
  changeStart: number,
  changeEnd: number,
  removed: string[],
  added: string[],
  contextN = 3,
): string {
  const preStart = Math.max(0, changeStart - contextN);
  let postEnd = Math.min(lines.length, changeEnd + contextN);
  // A `configText` that ends in `\n` splits to a trailing "" element
  // that is NOT a real file line — including it as a context line
  // (` `) makes `git apply` reject the hunk ("patch does not apply").
  // Drop it from the trailing context window.
  if (postEnd === lines.length && lines.length > 0 && lines[lines.length - 1] === "") {
    postEnd -= 1;
  }
  const pre = lines.slice(preStart, changeStart);
  const post = lines.slice(changeEnd, Math.max(changeEnd, postEnd));

  const oldCount = pre.length + removed.length + post.length;
  const newCount = pre.length + added.length + post.length;
  const oldStartLine = preStart + 1;
  const newStartLine = preStart + 1;

  const out: string[] = [];
  out.push(`@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@`);
  for (const l of pre) out.push(` ${l}`);
  for (const l of removed) out.push(`-${l}`);
  for (const l of added) out.push(`+${l}`);
  for (const l of post) out.push(` ${l}`);
  return out.join("\n");
}

function wrapDiff(hunk: string): string {
  return `${TARGET_HEADER_A}\n${TARGET_HEADER_B}\n${hunk}\n`;
}

/**
 * Synthesize a git-apply-compatible unified diff that adds `rule` to
 * the target agent's `tools.allow` in raw `configText`. Returns null if
 * the agent block can't be located.
 *
 * Three structural cases:
 *   (a) flow list on one line: `allow: [ all ]` / `allow: [X, Y]`
 *       → one-line replace appending `, <rule>` before the closing `]`.
 *   (b) block sequence: `allow:\n  - Bash`
 *       → insert a new `  - <rule>` line after the last `- ` entry.
 *   (c) `tools.allow` absent: insert
 *       `    tools:\n      allow:\n        - <rule>` under the agent.
 */
export function synthesizeAllowRuleDiff(
  args: SynthesizeAllowRuleDiffArgs,
): string | null {
  const { agentName, rule, configText } = args;
  if (!agentName || !rule || !configText) return null;
  const lines = configText.split("\n");
  const block = locateAgentBlock(lines, agentName);
  if (!block) return null;

  const tools = locateToolsLine(lines, block);

  // Case (c): no tools: mapping at all → insert tools/allow/rule under
  // the agent block, indented two deeper than the agent key.
  if (!tools) {
    const baseIndent = block.agentIndent + 2;
    const insertAt = block.agentLineIdx + 1;
    const added = [
      `${" ".repeat(baseIndent)}tools:`,
      `${" ".repeat(baseIndent + 2)}allow:`,
      `${" ".repeat(baseIndent + 4)}- ${rule}`,
    ];
    const hunk = buildHunk(lines, insertAt, insertAt, [], added);
    return wrapDiff(hunk);
  }

  const allow = locateAllowLine(
    lines,
    tools.idx,
    tools.indent,
    block.agentBlockEnd,
  );

  // tools: present but no allow: key → insert an allow block under it.
  if (!allow) {
    const baseIndent = tools.indent + 2;
    const insertAt = tools.idx + 1;
    const added = [
      `${" ".repeat(baseIndent)}allow:`,
      `${" ".repeat(baseIndent + 2)}- ${rule}`,
    ];
    const hunk = buildHunk(lines, insertAt, insertAt, [], added);
    return wrapDiff(hunk);
  }

  const inlineTrimmed = allow.inline.trim();

  // Case (a): flow list on one line.
  if (inlineTrimmed.startsWith("[")) {
    const original = lines[allow.idx]!;
    const close = original.lastIndexOf("]");
    if (close === -1) return null;
    // Empty list `[]` / `[ ]` → first element, no leading comma.
    const inner = original.slice(original.indexOf("[") + 1, close).trim();
    const replacement =
      inner.length === 0
        ? `${original.slice(0, close)}${rule}${original.slice(close)}`
        : `${original.slice(0, close).replace(/\s*$/, "")}, ${rule}${original.slice(close)}`;
    const hunk = buildHunk(
      lines,
      allow.idx,
      allow.idx + 1,
      [original],
      [replacement],
    );
    return wrapDiff(hunk);
  }

  // Case (a2): multi-line flow list — `allow:` has an EMPTY inline
  // remainder, but the `[` opens on a subsequent line and entries run one
  // per line down to a closing `]` on its own line (clerk's exact shape,
  // issue #2973). Must be checked before the block-sequence fallback below
  // — that fallback would otherwise misread the `[`/entries/`]` lines as
  // block-sequence context and insert a `- <rule>` line ABOVE the `[`,
  // corrupting the YAML (`E_YAML_UNSAFE_CONSTRUCT`).
  if (inlineTrimmed.length === 0) {
    const flow = locateMultilineFlowList(lines, allow.idx + 1, block.agentBlockEnd);
    if (flow) {
      if (flow.lastEntryIdx === -1) {
        // Empty multi-line list (`[` immediately followed by `]`) — insert
        // the first entry right after the opening bracket line.
        const insertAt = flow.openIdx + 1;
        const added = [`${" ".repeat(flow.itemIndent)}${rule}`];
        const hunk = buildHunk(lines, insertAt, insertAt, [], added);
        return wrapDiff(hunk);
      }
      // Ensure the current last entry carries a trailing comma (YAML flow
      // sequences accept it, and it's required here since we're adding a
      // sibling entry on its own line), then append the new entry —
      // replacing the single last-entry line with both lines.
      const lastLine = lines[flow.lastEntryIdx]!;
      const lastTrimmedEnd = lastLine.replace(/\s+$/, "");
      const fixedLast = lastTrimmedEnd.endsWith(",")
        ? lastTrimmedEnd
        : `${lastTrimmedEnd},`;
      const itemLine = `${" ".repeat(flow.itemIndent)}${rule}`;
      const hunk = buildHunk(
        lines,
        flow.lastEntryIdx,
        flow.lastEntryIdx + 1,
        [lastLine],
        [fixedLast, itemLine],
      );
      return wrapDiff(hunk);
    }
  }

  // Case (b): block sequence. Find the last `- ` entry at indent
  // allow.indent + 2 and insert a new entry after it.
  const itemIndent = allow.indent + 2;
  let lastItemIdx = -1;
  for (let i = allow.idx + 1; i < block.agentBlockEnd; i++) {
    const line = lines[i]!;
    if (isBlankOrComment(line)) continue;
    const ind = indentOf(line);
    if (ind <= allow.indent) break; // left the allow sequence
    const t = line.slice(ind);
    if (ind === itemIndent && t.startsWith("- ")) {
      lastItemIdx = i;
    }
  }
  if (lastItemIdx === -1) {
    // `allow:` with no entries (e.g. empty seq) — insert the first one.
    const insertAt = allow.idx + 1;
    const added = [`${" ".repeat(itemIndent)}- ${rule}`];
    const hunk = buildHunk(lines, insertAt, insertAt, [], added);
    return wrapDiff(hunk);
  }
  const insertAt = lastItemIdx + 1;
  const added = [`${" ".repeat(itemIndent)}- ${rule}`];
  const hunk = buildHunk(lines, insertAt, insertAt, [], added);
  return wrapDiff(hunk);
}

/**
 * Inverse of {@link synthesizeAllowRuleDiff} for the correlation check:
 * return the single `tools.allow` rule token added by the diff, or null
 * if the diff doesn't add exactly one such rule.
 *
 * Recognises both shapes the synthesizer emits:
 *   - a block-sequence add: `+        - <rule>`
 *   - a flow-list element appended on a replaced line: the `+` line
 *     differs from the `-` line by a single trailing `, <rule>` (or a
 *     first element inside an empty `[]`).
 *
 * Deliberately strict: returns null on multi-add / structural diffs so
 * a forged edit touching arbitrary fields can never be mistaken for a
 * queued always-allow rule.
 */
export function extractAddedAllowRule(unifiedDiff: string): string | null {
  if (!unifiedDiff) return null;
  const lines = unifiedDiff.split("\n");
  const plus: string[] = [];
  const minus: string[] = [];
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("@@")) continue;
    if (l.startsWith("+")) plus.push(l.slice(1));
    else if (l.startsWith("-")) minus.push(l.slice(1));
  }

  // Block-sequence add: exactly one `+` line of the form `  - <rule>`
  // and no `-` (removal) lines, OR (case-c/no-allow insert) several
  // `+` lines where exactly one is a `- <rule>` item.
  if (minus.length === 0) {
    const items = plus
      .map((p) => {
        const ind = indentOf(p);
        const t = p.slice(ind);
        return t.startsWith("- ") ? t.slice(2).trim() : null;
      })
      .filter((x): x is string => x !== null);
    if (items.length === 1) return items[0]!;
    // Multi-line flow-list first-entry insert (list was empty): a single
    // bare `+` line with no `- ` prefix — the plain entry text itself,
    // possibly comma-suffixed.
    if (items.length === 0 && plus.length === 1) {
      const bare = plus[0]!.trim();
      const stripped = bare.endsWith(",") ? bare.slice(0, -1).trim() : bare;
      return stripped.length > 0 ? stripped : null;
    }
    return null;
  }

  // Flow-list append: one `-` line replaced by one `+` line that adds a
  // trailing element. Diff the two for the new `]`-interior token(s).
  if (minus.length === 1 && plus.length === 1) {
    const before = extractFlowItems(minus[0]!);
    const after = extractFlowItems(plus[0]!);
    if (before === null || after === null) return null;
    if (after.length !== before.length + 1) return null;
    // The new element is the one in `after` not in `before` (by
    // position — synthesizer appends, so it's the last).
    const added = after[after.length - 1]!;
    // Confirm prefix matches (defense against reordering forgery).
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) return null;
    }
    return added;
  }

  // Multi-line flow-list append: one `-` line (the previous last entry)
  // replaced by TWO `+` lines — that same entry now comma-terminated,
  // plus the new entry on its own line.
  if (minus.length === 1 && plus.length === 2) {
    const orig = minus[0]!.trim();
    const first = plus[0]!.trim();
    const second = plus[1]!.trim();
    const origStripped = orig.endsWith(",") ? orig.slice(0, -1).trim() : orig;
    const firstStripped = first.endsWith(",") ? first.slice(0, -1).trim() : first;
    if (firstStripped !== origStripped) return null;
    const added = second.endsWith(",") ? second.slice(0, -1).trim() : second;
    return added.length > 0 ? added : null;
  }

  return null;
}

/** Parse the bracketed flow-list items from a `allow: [ ... ]` line. */
function extractFlowItems(line: string): string[] | null {
  const open = line.indexOf("[");
  const close = line.lastIndexOf("]");
  if (open === -1 || close === -1 || close < open) return null;
  const inner = line.slice(open + 1, close).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
