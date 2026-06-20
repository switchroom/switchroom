/**
 * Agent self-improvement — the GATE (RFC §"Solution Space" / "Be
 * gate-first"). A cheap, DETERMINISTIC per-turn triage that decides
 * whether the expensive forked review runs at all.
 *
 * This is the load-bearing cost guarantee: a turn with no learning
 * signal must incur ~no extra work — the gate is pure, allocation-light,
 * and returns immediately on a clean turn (`Cost × idle turn` UAT in the
 * job spec). NO model call, NO IO. Slice 1 detects three signal classes:
 *
 *   1. operator-correction — the operator's last messages contain a
 *      correction pattern ("no, that's wrong", "I told you …", "stop
 *      doing X", "that's not what I asked"). Repetition = the operator
 *      had to say it more than once.
 *   2. repeated-manual-fix — the same fix (an identical Edit old→new, or
 *      an identical Bash remediation) recurs within the turn window.
 *   3. directive-not-bound — the operator restates a standing rule
 *      ("always …", "every time …", "remember to …") they have already
 *      stated, i.e. it didn't bind.
 *
 * Repetition threshold = 2 by default ("correct once, never again"): the
 * SECOND occurrence trips. No signal → `{tripped:false, signals:[]}`.
 */

import type {
  GateResult,
  LearningSignal,
  LearningSignalKind,
  TurnMessage,
} from "./types.js";
import { resolveSelfImproveConfig } from "./config.js";

/** Cap on evidence excerpt length stored in a signal. */
const EVIDENCE_MAX = 160;

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EVIDENCE_MAX ? t.slice(0, EVIDENCE_MAX - 1) + "…" : t;
}

/**
 * Correction phrases the operator uses to push back on the agent.
 * Anchored to whole words to avoid matching substrings ("not" inside
 * "note"). Case-insensitive, applied to user-role text only.
 */
const CORRECTION_PATTERNS: RegExp[] = [
  /\bno,? that'?s (?:not right|wrong|incorrect|not what)\b/i,
  /\bthat'?s (?:not right|wrong|incorrect)\b/i,
  /\bthat'?s not what i (?:asked|wanted|meant|said)\b/i,
  /\bi (?:already )?told you\b/i,
  /\bi keep telling you\b/i,
  /\b(?:stop|don'?t) (?:doing|do) (?:that|this)\b/i,
  /\bwhy did you\b.*\b(?:again|still)\b/i,
  /\byou (?:keep|always) (?:doing|getting)\b/i,
  /\bnot again\b/i,
  /\byou got it wrong\b/i,
];

/**
 * "Standing rule" phrases — the operator stating a durable directive.
 * The directive-not-bound signal fires when the SAME rule is restated
 * (an "always do X" that evidently didn't bind, so they're saying it
 * again).
 */
const DIRECTIVE_PATTERNS: RegExp[] = [
  /\b(?:always|never|every time|from now on|going forward|remember to|make sure (?:to|you))\b/i,
];

/** Stopwords removed when normalising a directive for dup-detection. */
const DIRECTIVE_STOPWORDS = new Set([
  "always",
  "never",
  "every",
  "time",
  "from",
  "now",
  "on",
  "going",
  "forward",
  "remember",
  "to",
  "make",
  "sure",
  "you",
  "the",
  "a",
  "an",
  "please",
  "and",
  "do",
  "don't",
  "dont",
  "that",
  "this",
  "is",
  "be",
  "i",
  "your",
  "my",
]);

/**
 * Content-word set of a directive sentence: lowercase, strip the
 * directive cue + stopwords. Two restatements of the same rule —
 * "always dedupe the email recipients" vs "remember to dedupe the
 * recipients" — share most of these words.
 */
function directiveContentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !DIRECTIVE_STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two word sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Two directives are "the same rule restated" when their content-word
 *  sets overlap at least this much. Tolerant of re-wording, strict
 *  enough that two unrelated rules don't cluster. */
const DIRECTIVE_SIM_THRESHOLD = 0.5;

interface DirectiveStatement {
  words: Set<string>;
  sample: string;
}

/** Extract directive-bearing sentence(s) from a user message. */
function directiveStatements(text: string): DirectiveStatement[] {
  const out: DirectiveStatement[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (DIRECTIVE_PATTERNS.some((re) => re.test(sentence))) {
      const words = directiveContentWords(sentence);
      if (words.size > 0) out.push({ words, sample: sentence.trim() });
    }
  }
  return out;
}

/**
 * Pull a normalised "fix fingerprint" from an assistant tool-bearing
 * message text. The Stop hook flattens tool calls into the message
 * text; we look for repeated Edit/Write/Bash remediations by fingerprint.
 *
 * We intentionally only fingerprint Edit (old→new) and Bash, the two
 * shapes that signal "the agent had to redo the same fix". The
 * fingerprint is the normalised concatenation; collisions across turns
 * mean the same fix recurred.
 */
const FIX_PATTERNS: RegExp[] = [
  // Tool-label flattened forms (see telegram-plugin/tool-labels.ts and
  // the transcript flattening in the Stop hook): "Edit(<path>)", with a
  // following diff body, or a "Bash(<cmd>)".
  /\bEdit\(([^)]+)\)/g,
  /\bBash\(([^)]+)\)/g,
];

function fixFingerprints(text: string): string[] {
  const out: string[] = [];
  for (const re of FIX_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const inner = (m[1] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (inner.length >= 3) out.push(`${m[0].split("(")[0]}::${inner}`);
    }
  }
  return out;
}

/**
 * Run the gate over a finished turn's messages.
 *
 * `messages` is the bounded transcript tail the Stop hook hands us
 * (user + assistant, newest last). The gate is O(messages × patterns)
 * with no IO — on a clean turn it walks the messages once and returns
 * `tripped:false`.
 */
export function runGate(
  messages: TurnMessage[],
  cfg = resolveSelfImproveConfig(),
): GateResult {
  const threshold = cfg.repetitionThreshold;
  const signals: LearningSignal[] = [];

  // Fast path: nothing to look at.
  if (!messages || messages.length === 0) {
    return { tripped: false, signals };
  }

  // --- 1. operator-correction: count correction-bearing user messages.
  let correctionCount = 0;
  let lastCorrection = "";
  // --- 3. directive-not-bound: cluster restatements of the same rule by
  //         content-word similarity (tolerant of re-wording).
  const directiveClusters: { words: Set<string>; count: number; sample: string }[] = [];
  // --- 2. repeated-manual-fix: count identical fix fingerprints.
  const fixCounts = new Map<string, number>();

  for (const m of messages) {
    const text = typeof m.text === "string" ? m.text : "";
    if (text.length === 0) continue;

    if (m.role === "user") {
      if (CORRECTION_PATTERNS.some((re) => re.test(text))) {
        correctionCount += 1;
        lastCorrection = text;
      }
      for (const stmt of directiveStatements(text)) {
        const hit = directiveClusters.find(
          (c) => jaccard(c.words, stmt.words) >= DIRECTIVE_SIM_THRESHOLD,
        );
        if (hit) {
          hit.count += 1;
          // Keep the longest sample as the most descriptive evidence.
          if (stmt.sample.length > hit.sample.length) hit.sample = stmt.sample;
        } else {
          directiveClusters.push({ words: stmt.words, count: 1, sample: stmt.sample });
        }
      }
    } else if (m.role === "assistant") {
      for (const fp of fixFingerprints(text)) {
        fixCounts.set(fp, (fixCounts.get(fp) ?? 0) + 1);
      }
    }
  }

  if (correctionCount >= threshold) {
    signals.push(
      buildSignal(
        "operator-correction",
        `Operator pushed back ${correctionCount}× this turn — the same correction recurred`,
        correctionCount,
        lastCorrection,
      ),
    );
  }

  for (const { count, sample } of directiveClusters) {
    if (count >= threshold) {
      signals.push(
        buildSignal(
          "directive-not-bound",
          `A standing rule was restated ${count}× — it isn't binding where the action runs`,
          count,
          sample,
        ),
      );
    }
  }

  for (const [fp, count] of fixCounts) {
    if (count >= threshold) {
      signals.push(
        buildSignal(
          "repeated-manual-fix",
          `The same manual fix was applied ${count}× — codify it so it stops recurring`,
          count,
          fp,
        ),
      );
    }
  }

  return { tripped: signals.length > 0, signals };
}

function buildSignal(
  kind: LearningSignalKind,
  reason: string,
  occurrences: number,
  evidence: string,
): LearningSignal {
  return { kind, reason, occurrences, evidence: excerpt(evidence) };
}
