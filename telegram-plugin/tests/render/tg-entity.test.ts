// Telegram inline `tg:` entities in mdast IMAGE position survive the whole
// outbound pipeline.
//
// Bot API grammar (https://core.telegram.org/bots/api, "Rich Markdown style"):
//
//   ![](tg://emoji?id=5368324170671202286)                    custom emoji
//   ![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)   date_time
//
// (the `date_time` MessageEntity landed in Bot API 9.5, 2026-03-01; the
// rich-message `RichTextDateTime` class in 10.1, 2026-06-11 — Bot API
// changelog.) grammy 1.44.0 speaks 10.1, so the wire has accepted this since
// #2669 — but the RENDER path escaped the brackets to literal text, so the
// syntax was dead on the streamed send path.
//
// Two DISTINCT outbound surfaces are pinned here, because they do not share a
// pipeline:
//   - the STREAMED path (stream-controller.ts:272) → `renderOutboundChunks` →
//     `parse → renderSafe`. This is the surface the escaping bug lived on.
//   - the REPLY-TOOL path (outbound-send-path.ts) → `computeReplyChunks` →
//     `richMessage()`, which NEVER runs the renderer — only the
//     accidental-formatting guards. It was already correct; these tests pin it
//     so a future guard can't silently start eating the syntax.

import { describe, it, expect } from "vitest";
import { parse } from "../../render/parse.js";
import { renderSafe, SUPPORTED_INLINE } from "../../render/render.js";
import { renderOutboundChunks } from "../../render/rich-render.js";
import { guardAccidentalFormatting, richMessage } from "../../rich-send.js";
import { computeReplyChunks } from "../../gateway/outbound-send-path.js";
import { splitMarkdownChunks, RICH_MESSAGE_MAX_CHARS } from "../../format.js";
import type { Inline } from "../../render/ir.js";

/** The doc's own date_time example, verbatim. */
const DATE_TIME = "![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)";
/** The doc's own custom-emoji example, verbatim (empty label). */
const EMOJI = "![](tg://emoji?id=5368324170671202286)";

/** parse → renderSafe, the streamed path's core. */
const roundTrip = (md: string): string => renderSafe(parse(md), md).text;

/** Flatten every inline node in the rendered IR of `md`. */
function inlines(md: string): Inline[] {
  const out: Inline[] = [];
  const walk = (n: Inline): void => {
    out.push(n);
    for (const c of (n as { children?: Inline[] }).children ?? []) walk(c);
  };
  for (const b of parse(md).blocks) {
    for (const n of (b as { children?: Inline[] }).children ?? []) walk(n);
  }
  return out;
}

describe("tg:// inline entities: parse → renderSafe round-trip", () => {
  // THE bug this PR fixes: at HEAD the image node demoted to `plain` and
  // `escapeMarkdown` backslash-escaped `[`, `]` and `=`, shipping
  // `!\[22:45 tomorrow\](tg://time?unix\=…&format\=wDT)` — literal text, no
  // entity. Byte-exact preservation is the whole contract.
  it("preserves a date_time entity byte-exact", () => {
    const body = `Meeting at ${DATE_TIME} sharp.`;
    expect(roundTrip(body)).toBe(body);
  });

  it("preserves the empty-label custom-emoji entity byte-exact", () => {
    expect(roundTrip(`hi ${EMOJI} there`)).toBe(`hi ${EMOJI} there`);
  });

  it("preserves a date_time entity with no `format` parameter", () => {
    const body = "![22:45 tomorrow](tg://time?unix=1647531900)";
    expect(roundTrip(body)).toBe(body);
  });

  it("folds the entity into a `tg-entity` IR node, not `plain`", () => {
    const node = inlines(`x ${DATE_TIME}`).find((n) => n.type === "tg-entity");
    expect(node).toMatchObject({
      type: "tg-entity",
      label: "22:45 tomorrow",
      href: "tg://time?unix=1647531900&format=wDT",
    });
  });

  it("survives inside a blockquote, a heading, a list item and a table cell", () => {
    for (const body of [
      `> when: ${DATE_TIME}`,
      `## Due ${DATE_TIME}`,
      `- due ${DATE_TIME}`,
      `| when | who |\n| --- | --- |\n| ${DATE_TIME} | me |`,
    ]) {
      expect(roundTrip(body)).toContain(DATE_TIME);
    }
  });

  it("matches the `tg:` href case-insensitively (URL schemes are)", () => {
    const body = "![t](TG://Time?unix=1647531900)";
    // Folded as an entity, and the author's ORIGINAL bytes are re-emitted —
    // the parser never rewrites the href.
    expect(inlines(body).some((n) => n.type === "tg-entity")).toBe(true);
    expect(roundTrip(body)).toBe(body);
  });

  it("lists `tg-entity` in the renderer's construct allowlist", () => {
    expect(SUPPORTED_INLINE).toContain("tg-entity");
  });
});

describe("tg:// inline entities: label escaping (no bracket breakout)", () => {
  // A model-authored label carrying `]` would close the label early and
  // smuggle raw bracket syntax past the renderer if the label were re-emitted
  // undecorated. It is prose, so it gets `escapeMarkdown` exactly like a
  // `plain` node.
  it("escapes brackets in the label instead of letting them close it early", () => {
    const out = roundTrip("![see [22:45]](tg://time?unix=1&format=t)");
    expect(out).toBe("![see \\[22:45\\]](tg://time?unix=1&format=t)");
    // No BARE `]` before the destination — the only unescaped one closes the label.
    expect(out.slice(0, out.indexOf("](")).includes("\\]")).toBe(true);
  });

  it("escapes emphasis delimiters in the label", () => {
    expect(roundTrip("![a*b_c~d](tg://time?unix=1&format=t)")).toBe(
      "![a\\*b\\_c\\~d](tg://time?unix=1&format=t)",
    );
  });

  it("collapses a soft line break in the label so the construct stays on one line", () => {
    const out = roundTrip("![22:45\ntomorrow](tg://time?unix=1&format=t)");
    expect(out).toBe("![22:45 tomorrow](tg://time?unix=1&format=t)");
    expect(out).not.toContain("\n");
  });
});

describe("tg:// inline entities: no regression of the image demotion", () => {
  // Deliberate, unchanged: an http(s) `![](…)` is a Telegram MEDIA block —
  // "Media can be specified only as a separate block" (Rich Markdown style) —
  // not an inline entity, and switchroom emits no media blocks. It keeps
  // degrading to escaped literal text.
  it("still degrades an http(s) image link to escaped plain text", () => {
    expect(roundTrip("![alt](https://x.example/y.png)")).toBe(
      "!\\[alt\\](https://x.example/y.png)",
    );
  });

  it("still degrades an UNDOCUMENTED tg:// image href to escaped plain text", () => {
    // The allowlist is deliberate: only `tg://time` and `tg://emoji` are
    // documented in image position, so anything else stays literal rather than
    // shipping syntax Telegram may parse-reject.
    expect(roundTrip("![t](tg://photo?id=1)")).toBe("!\\[t\\](tg://photo?id\\=1)");
    expect(roundTrip("![t](tg://user?id=1)")).toBe("!\\[t\\](tg://user?id\\=1)");
  });

  it("leaves an ordinary `[label](tg://user?id=…)` mention link alone", () => {
    const body = "ping [Ken](tg://user?id=123456789)";
    expect(roundTrip(body)).toBe(body);
  });
});

describe("tg:// inline entities: code context stays literal", () => {
  it("keeps the syntax verbatim inside an inline code span", () => {
    const body = "use `![22:45](tg://time?unix=1&format=t)` for that";
    expect(roundTrip(body)).toBe(body);
    // and it is a `code` node, NOT a folded entity
    expect(inlines(body).some((n) => n.type === "tg-entity")).toBe(false);
  });

  it("keeps the syntax verbatim inside a fenced code block", () => {
    const body = "```\n![22:45](tg://time?unix=1&format=t)\n```";
    expect(roundTrip(body)).toBe(body);
    expect(inlines(body).some((n) => n.type === "tg-entity")).toBe(false);
  });
});

describe("tg:// inline entities: the accidental-formatting guards are a no-op", () => {
  // `guardAccidentalFormatting` is the universal seam (installed as a grammy
  // API transformer in shared/bot-runtime.ts), so it runs over EVERY outbound
  // body — rendered or hand-built card alike. Its documented trigger set
  // (`_ * > . ~ == || $ #`) does not intersect this syntax, but nothing
  // asserted that until now.
  const bodies = [
    `Meeting at ${DATE_TIME} sharp.`,
    `${DATE_TIME} at the very start of the line`,
    EMOJI,
    `- due ${DATE_TIME}\n- and ${DATE_TIME}`,
    `> when: ${DATE_TIME}`,
    `| when |\n| --- |\n| ${DATE_TIME} |`,
    "![see \\[22:45\\]](tg://time?unix=1&format=t)",
  ];

  it("leaves every tg:// entity body byte-identical", () => {
    for (const body of bodies) expect(guardAccidentalFormatting(body)).toBe(body);
  });

  it("is idempotent over the rendered form too", () => {
    for (const body of bodies) {
      const rendered = roundTrip(body);
      expect(guardAccidentalFormatting(rendered)).toBe(rendered);
    }
  });
});

describe("tg:// inline entities: live outbound seams", () => {
  it("survives the STREAMED seam (renderOutboundChunks)", () => {
    const body = `Standup starts ${DATE_TIME}.`;
    const pieces = renderOutboundChunks(body);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].mode).toBe("markdown");
    expect(pieces[0].text).toBe(body);
  });

  it("survives the REPLY-TOOL seam (computeReplyChunks → richMessage)", () => {
    // This surface never touches the renderer — it is guards-only. Pinned so a
    // future guard cannot start escaping the syntax unnoticed.
    const body = `Standup starts ${DATE_TIME}.`;
    const chunks = computeReplyChunks({
      effectiveText: body,
      literalText: false,
      limit: RICH_MESSAGE_MAX_CHARS,
      chunkMode: "length",
    });
    expect(chunks.map((c) => richMessage(c).markdown).join("")).toContain(DATE_TIME);
  });
});

describe("tg:// inline entities: chunk boundaries never bisect the construct", () => {
  // `INLINE_SPAN_PATTERNS`' link pattern used to start at the `[`, leaving the
  // leading `!` outside the protected span: a cut inside the construct
  // retreated only to the `[`, stranding `!` on the previous chunk and
  // silently demoting a date_time entity to an ordinary link.
  it("keeps a cap-straddling date_time entity whole in one chunk", () => {
    const body = `${"x".repeat(80)} ${DATE_TIME}`;
    const chunks = splitMarkdownChunks(body, 110);
    expect(chunks.length).toBeGreaterThan(1);
    // Exactly one chunk carries the entity, whole.
    expect(chunks.filter((c) => c.includes(DATE_TIME))).toHaveLength(1);
    // And no chunk ends on the stranded `!`.
    for (const c of chunks) expect(c.endsWith("!")).toBe(false);
  });

  it("still keeps an ordinary link whole (unchanged behaviour)", () => {
    const link = "[a fairly long link label here](https://example.com/some/path)";
    const chunks = splitMarkdownChunks(`${"x".repeat(80)} ${link}`, 110);
    expect(chunks.filter((c) => c.includes(link))).toHaveLength(1);
  });
});
