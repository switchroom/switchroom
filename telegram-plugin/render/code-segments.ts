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
