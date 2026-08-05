/**
 * PreToolUse hook — RFC "native-by-default skill authoring", Phase 1.
 *
 * Fires on Write / Edit / MultiEdit / Bash. When the target path is inside an
 * agent's own `.claude/skills/<slug>/` tree it lints the write against
 * the same skill-shape rules the (deprecated) `skill_*` MCP tools
 * enforced — but **advisory only**: it never blocks a malformed skill,
 * it returns `additionalContext` so the model self-corrects. The one
 * hard stop is the per-skill byte cap (`MAX_SKILL_BYTES`), the only
 * rule with real blast radius (a runaway write filling the agent's
 * persistent volume).
 *
 * Why a hook and not a CLI: agent-scope skills live in the agent's own
 * writable, persistent, reconcile-safe dir — the native authoring path
 * is plain Write/Edit. The shared validators in `skill-common.ts` are
 * the single source of truth; this hook calls them directly (bundled
 * to a self-contained .mjs at build time, like drive-write-pretool).
 *
 * Claude Code PreToolUse protocol (v1), mirrors drive-write-pretool:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow.
 *           exit 0 + {"decision":"block","reason":...}  → block.
 *           exit 0 + {"hookSpecificOutput":{...,additionalContext}}
 *                                                       → allow + nudge.
 *
 * Fail-OPEN everywhere (stdin parse error, fs error, unknown shape):
 * a lint hook must never be the reason a legitimate write fails. The
 * only non-allow outcome is the explicit oversize block.
 */

import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  MAX_SKILL_BYTES,
  validateSkillName,
  validateRelPath,
  validateSkillMd,
} from "./skill-common.js";
import { selfImproveEnabled } from "../self-improve/config.js";

const SKILLS_SEGMENT = "/.claude/skills/";
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** The one bundle file that is machine-managed under self-improvement. */
const EVALS_JSON_REL = "evals/evals.json";

/** An ABSOLUTE path that is a skill bundle's machine-managed evals.json
 *  (`<...>/.claude/skills/<slug>/evals/evals.json`). Used by the Bash-command
 *  scan after lexical canonicalization. */
const ABS_SKILL_EVALS_RE =
  /\/\.claude\/skills\/[^/]+\/evals\/evals\.json$/;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  const safe = String(reason)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  process.stdout.write(JSON.stringify({ decision: "block", reason: safe }));
  process.exit(0);
}

function nudge(lines: string[]): never {
  const context =
    "skill-lint (advisory — the write was allowed):\n" +
    lines.map((l) => `  • ${l}`).join("\n") +
    "\nThese are the same rules the deprecated skill_* MCP tools " +
    "enforced. Fix them so the skill is well-formed and discoverable " +
    "on your next turn.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

/** Total bytes of regular files under `dir` (recursive, symlink-safe,
 *  best-effort). Returns 0 on any error — fail-open. */
function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) total += dirBytes(p);
      else if (st.isFile()) total += st.size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

function fileSize(p: string): number {
  try {
    const st = lstatSync(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

// ── Bash-command scan (MAJOR 2 — close the Bash-write hole) ──────────
//
// The Write/Edit/MultiEdit block above cannot see a `bash -c '… >
// .../evals/evals.json'`: a Bash tool call never carries a `file_path`, so a
// shell redirect (or `tee`/`cp`/`mv`/…) into a machine-managed evals.json used
// to slip past BOTH the PII/secret scan and the operator's one-tap approval.
// This scan closes the demonstrated vectors deterministically. It is a
// command-string heuristic, NOT a perfect shell parser (false negatives are
// possible — e.g. an exotic writer or an eval-built path), so it is paired with
// the honest Stop-hook sweep (eval-cases.ts sweepEvalIntegrity), which refuses
// to adopt un-sanctioned evals.json bytes as a trusted baseline. Between the
// two, no path (Write/Edit/MultiEdit/Bash) lands un-scanned, un-tapped bytes
// that later become a trusted baseline.

/** Utilities that WRITE their path argument(s) (parity with the redirect
 *  detector — a Bash redirect is the primary vector, these are secondary). */
const BASH_WRITERS = new Set([
  "tee", "cp", "mv", "dd", "install", "truncate", "rsync",
]);

/** Does a raw command token (after stripping surrounding quotes) lexically
 *  resolve to a skill bundle's machine-managed evals.json? `resolve()` is
 *  lexical (no fs / symlink touch) and collapses `..` / `.` / redundant
 *  separators — the SAME canonicalization the Write path now uses, so a
 *  crafted `.../evals/../evals/evals.json` is caught identically. */
function tokenIsSkillEvalsJson(token: string): boolean {
  const t = token.replace(/^['"]+/, "").replace(/['"]+$/, "");
  if (!t.includes(".claude/skills/")) return false;
  // Anchor at root so a relative fragment (`.claude/skills/…`) still resolves;
  // an absolute token is unchanged by resolve("/", abs).
  return ABS_SKILL_EVALS_RE.test(resolve("/", t));
}

/** An output redirect (`>` / `>>`, not a `2>&1`-style fd-dup) whose TARGET is a
 *  skill's evals.json — the primary Bash vector (`echo … > …/evals.json`). */
function redirectWritesEvals(command: string): boolean {
  const re = /(?:^|[^0-9<>&])>>?\s*(['"]?)([^\s'"|;&()<>]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    if (m[2] && tokenIsSkillEvalsJson(m[2])) return true;
  }
  return false;
}

/** A writer utility (or `sed -i`) whose path argument is a skill's evals.json.
 *  Segmented on shell separators so a read in one segment can't be blamed on a
 *  writer verb in another. */
function writerVerbWritesEvals(command: string): boolean {
  for (const seg of command.split(/&&|\|\||[;|\n]/g)) {
    const tokens = seg.trim().split(/\s+/).filter((s) => s.length > 0);
    if (tokens.length === 0) continue;
    const verb = tokens[0]!.replace(/^['"]+/, "");
    const rest = tokens.slice(1);
    if (BASH_WRITERS.has(verb)) {
      for (const tok of rest) {
        const p = tok.startsWith("of=") ? tok.slice(3) : tok; // `dd of=<path>`
        if (tokenIsSkillEvalsJson(p)) return true;
      }
    }
    if (verb === "sed" && rest.some((r) => r === "-i" || r.startsWith("-i"))) {
      for (const tok of rest) if (tokenIsSkillEvalsJson(tok)) return true;
    }
  }
  return false;
}

/** Detect a Bash command that WRITES a machine-managed evals.json. Returns a
 *  short human label for the block message, or null. */
function detectBashEvalsWrite(command: string): string | null {
  if (redirectWritesEvals(command)) return "a shell redirect into";
  if (writerVerbWritesEvals(command)) return "a shell write into";
  return null;
}

/** Handle a Bash tool call: block a write to a machine-managed evals.json.
 *  Gated on self-improvement (same escape hatch as the Write path). */
function handleBash(event: { tool_input?: unknown }): never {
  if (!selfImproveEnabled()) allow();
  const input =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as Record<string, unknown>)
      : {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) allow();
  const how = detectBashEvalsWrite(command);
  if (how) {
    block(
      `evals/evals.json is machine-managed under self-improvement — ${how} it ` +
        `via Bash bypasses the PII/secret scan and the operator's one-tap ` +
        `approval. Add a case with: switchroom self-improve add-eval-case ` +
        `--skill <slug> --prompt "<the correction, as a test prompt>". ` +
        `(To hand-author evals via skill-creator instead, set ` +
        `SWITCHROOM_SELF_IMPROVE=0.)`,
    );
  }
  allow();
}

function main(): void {
  const raw = readStdin().trim();
  if (!raw) allow();

  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // Claude protocol error — not ours to police.
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (toolName === "Bash") handleBash(event);
  if (!EDIT_TOOLS.has(toolName)) allow();

  const input =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as Record<string, unknown>)
      : {};
  const rawFilePath =
    typeof input.file_path === "string" ? input.file_path : "";
  if (!rawFilePath) allow();

  // Canonicalize BEFORE any path matching so `..` / `.` / redundant separators
  // can't disguise the target (MAJOR 1: `.../evals/../evals/evals.json` must
  // hit the same machine-managed block as the plain path). This mirrors
  // apply-guard's resolve()-based `skillTargetEscapes`, so the always-on hook
  // and the review-scoped guard treat crafted paths identically. resolve() is
  // lexical (no fs / symlink touch), matching the guard.
  const filePath = resolve(rawFilePath);

  const segIdx = filePath.indexOf(SKILLS_SEGMENT);
  if (segIdx < 0) allow(); // not a skill write

  const afterSkills = filePath.slice(segIdx + SKILLS_SEGMENT.length);
  const segs = afterSkills.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) allow(); // writing the skills root or a bare slug dir

  const slug = segs[0]!;
  const relPath = segs.slice(1).join("/");
  const skillDir = filePath.slice(0, segIdx + SKILLS_SEGMENT.length) + slug;

  // Self-improve eval-case sink (RFC amendment §"corrections as eval cases",
  // review blocker BL1). Under self-improvement, a skill's evals/evals.json is
  // MACHINE-MANAGED: the only sanctioned way to add a case is
  //   switchroom self-improve add-eval-case  →  one-tap card  →  deterministic
  //   `apply-eval-case` applier (which writes via fs, NOT the Write tool, so it
  //   never reaches this hook).
  // A raw model Write/Edit to evals.json would bypass BOTH the deterministic
  // PII/secret scan AND the operator's one-tap approval, so it is hard-blocked
  // on EVERY turn — this is the ALWAYS-ON hook, not the review-scoped
  // apply-guard (which no-ops on a normal turn: BL1). Gated behind
  // `selfImproveEnabled()` so an operator can still hand-author evals with the
  // skill-creator flow by setting SWITCHROOM_SELF_IMPROVE=0 (the escape hatch;
  // the skill-creator ⇆ machine-managed tension is a filed follow-up).
  if (selfImproveEnabled() && relPath === EVALS_JSON_REL) {
    block(
      `evals/evals.json is machine-managed under self-improvement — a direct ` +
        `write bypasses the PII/secret scan and the operator's one-tap ` +
        `approval. Add a case with: switchroom self-improve add-eval-case ` +
        `--skill ${slug} --prompt "<the correction, as a test prompt>". ` +
        `(To hand-author evals via skill-creator instead, set ` +
        `SWITCHROOM_SELF_IMPROVE=0.)`,
    );
  }

  const warnings: string[] = [];
  if (!validateSkillName(slug)) {
    warnings.push(
      `skill slug "${slug}" is invalid — must match ` +
        `[a-z0-9][a-z0-9_-]{0,62}. Claude won't discover a skill at an ` +
        `invalid slug.`,
    );
  }
  if (!validateRelPath(relPath)) {
    warnings.push(
      `"${relPath}" is outside the skill path allowlist ` +
        `(SKILL.md, README.md, scripts/*.{sh,py}, assets/*, ` +
        `reference/*.md, max depth 3). The file will be written but ` +
        `won't be part of a well-formed skill bundle.`,
    );
  }
  if (
    relPath === "SKILL.md" &&
    toolName === "Write" &&
    typeof input.content === "string"
  ) {
    const r = validateSkillMd(input.content, slug);
    if ("ok" in r && r.ok === false) {
      warnings.push(`SKILL.md frontmatter: ${r.message}`);
    }
  }

  // Hard cap — the only blocking rule. Project the new total when we
  // can (Write carries full content); for Edit/MultiEdit we only have
  // the current on-disk total, so we block solely if already over.
  try {
    const existingTotal = dirBytes(skillDir);
    let projected = existingTotal;
    if (toolName === "Write" && typeof input.content === "string") {
      projected =
        existingTotal -
        fileSize(filePath) +
        Buffer.byteLength(input.content, "utf8");
    }
    if (projected > MAX_SKILL_BYTES) {
      block(
        `skill "${slug}" would be ${projected} bytes, over the ` +
          `${MAX_SKILL_BYTES}-byte per-skill cap. Trim the skill ` +
          `(split large assets out, or shorten SKILL.md) and retry.`,
      );
    }
  } catch {
    /* fail-open: a sizing error must not block a write */
  }

  if (warnings.length > 0) nudge(warnings);
  allow();
}

main();
