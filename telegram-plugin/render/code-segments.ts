// Shared CommonMark-correct code-span / fenced-block splitter for the outbound
// formatting guards (#3252). Every guard that neutralises accidental Telegram
// markdown typesetting (dollar-math, emphasis, line-start block constructs,
// inline pairs) must skip content inside code spans and fenced code blocks
// verbatim. Rather than each guard forking its own copy of the splitter (the
// dollar guard shipped one, the emphasis + line-start guards each duplicated
// it), this is the ONE source of truth they all import.

/** A contiguous slice of rendered markdown, tagged as code (verbatim, never
 *  transformed) or prose (eligible for a guard's rewrite). */
export interface Segment {
  code: boolean;
  text: string;
}

/** From index `from` (just past an opening run of `runLen` backticks), find the
 *  index immediately AFTER the matching closing run of exactly `runLen`
 *  backticks. Returns -1 when there is no matching close (a stray backtick), in
 *  which case the opener is treated as literal prose. Equal-length matching is
 *  the CommonMark rule for code spans and matches the balanced fences the
 *  renderer emits for code blocks. */
export function findClosingBackticks(text: string, from: number, runLen: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === "`") {
      let j = i;
      while (j < text.length && text[j] === "`") j++;
      if (j - i === runLen) return j;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

/** Split rendered markdown into alternating prose / code segments so a guard can
 *  skip code spans and fenced code blocks entirely. */
export function splitCodeSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      let j = i;
      while (j < text.length && text[j] === "`") j++;
      const runLen = j - i;
      const close = findClosingBackticks(text, j, runLen);
      if (close !== -1) {
        if (plainStart < i) out.push({ code: false, text: text.slice(plainStart, i) });
        out.push({ code: true, text: text.slice(i, close) });
        i = close;
        plainStart = close;
        continue;
      }
    }
    i++;
  }
  if (plainStart < text.length) out.push({ code: false, text: text.slice(plainStart) });
  return out;
}

// ---------------------------------------------------------------------------
// Link / autolink / table protection (#3252 — link-aware guards)
// ---------------------------------------------------------------------------
//
// The four accidental-formatting guards must NOT escape inside content where
// the trigger chars (`_ * ~ = | $`) are STRUCTURAL rather than prose:
//   • markdown link destinations — the `(url)` (and `(url "title")`) target of
//     a `[label](url)` link. Underscores / tildes / `==` in a URL path or query
//     are part of the address; a backslash there can 404 the link. The link
//     LABEL (`[...]`) is rendered prose and stays guarded.
//   • bare autolinked URLs — `http(s)://…` and `www.…` runs Telegram auto-links.
//   • GFM table rows — a table's structural pipes / empty cells (`|a||b|`) must
//     survive; escaping inside a real table row corrupts the table.
//   • inline-math `$…$` spans — Telegram's rich GFM parser typesets a `$…$`
//     pair as a real mathematical_expression node (wire-verified 2026-08-13).
//     A COMPACT span (whitespace-free inner run that is not a bare currency
//     amount, e.g. `$x^2+y^2$`) is intentional math and must reach the wire
//     byte-identical: no guard may escape its `$`, `^`, `_`, `*`, or `+`.
//     Currency-shaped inners (`$5M-$`) are NOT protected, so the dollar-math
//     guard still breaks accidental `$5M … $10M` currency pairs (#3252).
// Everything else is prose and stays fully guarded. This is the sibling of the
// code-span skip: a PROTECTED segment (`code: true`) is emitted verbatim.
//
// Deterministic and linear-time: one left-to-right char scan per prose chunk
// plus one line pre-pass for tables; no backtracking regexes.

/** A GFM table delimiter row: only pipes / colons / dashes / spaces, with at
 *  least one dash AND at least one pipe (a bare `---` is a thematic break, not a
 *  table). This is what distinguishes a real table from prose that merely starts
 *  with `|`. */
function isTableDelimiterRow(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && /^[\s|:-]+$/.test(t) && t.includes("-") && t.includes("|");
}

/** A candidate table line: after optional leading spaces it begins with `|`. */
function isTableCandidateLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

/** A compact `$…$` inline-math pair: opening `$`, a whitespace-free inner run
 *  with no nested `$`, closing `$`. Anchored — tested at the scanner's current
 *  position only. */
const COMPACT_MATH_PAIR = /^\$([^\s$]+)\$/;

/** A currency-shaped inner run: digits plus amount punctuation and magnitude
 *  suffix letters only (`5M-`, `0.5`, `10,000`, `5+`). Such a run between two
 *  `$` is a pair of ADJACENT currency amounts (`$5M-$10M`), not math — it must
 *  stay guardable so the dollar-math guard can break the accidental pair. A
 *  run containing any other character (`x^2+y^2`, `\alpha`, `a_b`) is treated
 *  as intentional math and protected. */
const CURRENCY_SHAPED_INNER = /^[0-9.,+\-kKmMbB]+$/;

/** Find the [start, end) char ranges (relative to `text`) of GFM table blocks —
 *  maximal runs of 2+ consecutive `|`-leading lines that contain a delimiter
 *  row. Each returned range spans whole lines INCLUDING their trailing newline,
 *  so a table becomes ONE protected segment. A lone `|a||b|` line with no
 *  delimiter row is NOT a real table → not protected → still guarded. */
function findTableRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = text.split("\n");
  let offset = 0;
  let runStart = -1;
  let runEnd = -1;
  let runHasDelim = false;
  let runLineCount = 0;
  const flush = () => {
    if (runStart !== -1 && runLineCount >= 2 && runHasDelim) {
      ranges.push([runStart, runEnd]);
    }
    runStart = -1;
    runEnd = -1;
    runHasDelim = false;
    runLineCount = 0;
  };
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    // char length of this line including its trailing newline (except the last).
    const lineLen = line.length + (k < lines.length - 1 ? 1 : 0);
    if (isTableCandidateLine(line)) {
      if (runStart === -1) runStart = offset;
      runEnd = offset + lineLen;
      runLineCount += 1;
      if (isTableDelimiterRow(line)) runHasDelim = true;
    } else {
      flush();
    }
    offset += lineLen;
  }
  flush();
  return ranges;
}

/** Protect links / autolinks / table rows within a single PROSE chunk, returning
 *  alternating prose / protected segments. */
function splitProseProtected(text: string): Segment[] {
  const out: Segment[] = [];
  const tables = findTableRanges(text);
  let tIdx = 0;
  let i = 0;
  let plainStart = 0;
  const pushProtected = (from: number, to: number) => {
    if (plainStart < from) out.push({ code: false, text: text.slice(plainStart, from) });
    out.push({ code: true, text: text.slice(from, to) });
    plainStart = to;
  };
  while (i < text.length) {
    // Advance the table pointer past any range we've already scanned past.
    while (tIdx < tables.length && tables[tIdx][1] <= i) tIdx++;
    // 1. Table block — protect whole lines verbatim.
    if (tIdx < tables.length && tables[tIdx][0] === i) {
      const [, end] = tables[tIdx];
      pushProtected(i, end);
      i = end;
      continue;
    }
    const ch = text[i];
    // 2. Markdown link destination: `[label](dest)` — protect only `(dest)`.
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const destClose = text.indexOf(")", close + 2);
        if (destClose !== -1) {
          // Protect the `(dest)` span; the `[label]` before it stays prose.
          pushProtected(close + 1, destClose + 1);
          i = destClose + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    // 3. Bare autolink: `http(s)://…` or `www.…`, left-flanked by a boundary.
    if (
      (ch === "h" || ch === "w") &&
      (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]))
    ) {
      const m = /^(?:https?:\/\/|www\.)[^\s<>()\[\]]+/.exec(text.slice(i));
      if (m) {
        const end = i + m[0].length;
        pushProtected(i, end);
        i = end;
        continue;
      }
    }
    // 4. Compact inline-math pair `$…$` — a supported Telegram construct
    //    (mathematical_expression, wire-verified 2026-08-13) that must reach
    //    the wire verbatim. Currency-shaped inners are NOT math (they are two
    //    adjacent amounts like `$5M-$10M`) and stay guardable.
    if (ch === "$") {
      const m = COMPACT_MATH_PAIR.exec(text.slice(i));
      if (m && !CURRENCY_SHAPED_INNER.test(m[1])) {
        const end = i + m[0].length;
        pushProtected(i, end);
        i = end;
        continue;
      }
    }
    i++;
  }
  if (plainStart < text.length) out.push({ code: false, text: text.slice(plainStart) });
  return out;
}

/** Split rendered markdown into prose / protected segments where a PROTECTED
 *  (`code: true`) segment is any content a guard must emit verbatim: code spans,
 *  fenced code blocks, markdown link destinations, bare autolinks, GFM table
 *  rows, and compact `$…$` inline-math spans. This is the link/table/math-aware
 *  superset of `splitCodeSegments` that all the #3252 guards route through.
 *  Prose segments (`code: false`) remain guardable (including a link's
 *  `[label]` text). Deterministic, linear-time. */
export function splitProtectedSegments(text: string): Segment[] {
  const out: Segment[] = [];
  for (const seg of splitCodeSegments(text)) {
    if (seg.code) {
      out.push(seg);
      continue;
    }
    for (const sub of splitProseProtected(seg.text)) out.push(sub);
  }
  return out;
}
