import { describe, it, expect } from "vitest";
import {
  parseRichRenderEnabled,
  richRenderEnabled,
  renderOutbound,
  maybeRenderOutbound,
} from "../../render/rich-render.js";
import { guardAccidentalFormatting } from "../../rich-send.js";

describe("parseRichRenderEnabled", () => {
  it("defaults ON when unset (escape hatch, not opt-in)", () => {
    expect(parseRichRenderEnabled(undefined)).toBe(true);
  });
  it("disabled only by the explicit off tokens (case-insensitive, trimmed)", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off ", "NO"]) {
      expect(parseRichRenderEnabled(v)).toBe(false);
    }
  });
  it("truthy tokens stay ON", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
      expect(parseRichRenderEnabled(v)).toBe(true);
    }
  });
  it("empty / unrecognised values stay ON (fail-open to the default)", () => {
    for (const v of ["", "  ", "maybe", "2", "disable"]) {
      expect(parseRichRenderEnabled(v)).toBe(true);
    }
  });
});

describe("richRenderEnabled", () => {
  it("reads SWITCHROOM_RICH_RENDER, default ON", () => {
    expect(richRenderEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      richRenderEnabled({ SWITCHROOM_RICH_RENDER: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      richRenderEnabled({ SWITCHROOM_RICH_RENDER: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("maybeRenderOutbound", () => {
  it("disabled (=0) is a byte-for-byte passthrough (the escape hatch)", () => {
    const raw = "**bold** and a\n\n**> collapsible quote\n> second line";
    const r = maybeRenderOutbound(raw, {
      SWITCHROOM_RICH_RENDER: "0",
    } as NodeJS.ProcessEnv);
    expect(r.mode).toBe("markdown");
    expect(r.text).toBe(raw);
  });

  it("default (env unset) routes through parse -> renderSafe", () => {
    const r = maybeRenderOutbound("**> collapsible", {} as NodeJS.ProcessEnv);
    expect(r.mode).toBe("markdown");
    // The legacy expandable marker is REPAIRED to a plain quote: `**>` is
    // MarkdownV2-only syntax the rich path renders as literal text
    // (wire-proved 2026-08-13), so the renderer must never re-emit it.
    expect(r.text).toBe("> collapsible");
  });

  it("default preserves plain prose through the round-trip", () => {
    const r = maybeRenderOutbound(
      "just some plain text",
      {} as NodeJS.ProcessEnv,
    );
    expect(r.text).toContain("just some plain text");
  });

  it("default round-trips underline / spoiler / highlight", () => {
    const on = {} as NodeJS.ProcessEnv;
    expect(maybeRenderOutbound("__u__", on).text).toBe("__u__");
    expect(maybeRenderOutbound("a ||s|| b", on).text).toBe("a ||s|| b");
    expect(maybeRenderOutbound("a ==m== b", on).text).toBe("a ==m== b");
  });

  it("disabled (=0) passes new constructs through untouched too", () => {
    const raw = "__u__ and ||s|| and ==m==";
    const r = maybeRenderOutbound(raw, {
      SWITCHROOM_RICH_RENDER: "0",
    } as NodeJS.ProcessEnv);
    expect(r.text).toBe(raw);
  });

  it("a junk env value still renders (fail-open to the default)", () => {
    const r = maybeRenderOutbound("**> collapsible", {
      SWITCHROOM_RICH_RENDER: "maybe",
    } as NodeJS.ProcessEnv);
    expect(r.mode).toBe("markdown");
    expect(r.text).toBe("> collapsible");
  });
});

describe("renderOutbound (flag-independent)", () => {
  it("repairs a legacy `**>` quote to a plain quote end to end", () => {
    const r = renderOutbound("**> hidden line one\n> hidden line two");
    expect(r.mode).toBe("markdown");
    // One coherent quote, no retired marker: on the pre-fix renderer the
    // first line came back as `**> hidden line one`, which Telegram rendered
    // as LITERAL `**>` paragraph text (wire-proved 2026-08-13).
    expect(r.text).not.toContain("**>");
    expect(r.text.split("\n")[0]).toBe("> hidden line one");
    expect(r.text).toContain("> hidden line two");
  });

  it("passes native constructs through: <details>, $math$, footnotes", () => {
    // Wire-verified natives (2026-08-13) must survive parse -> renderSafe
    // BYTE-IDENTICAL. On the pre-fix pipeline the footnote case failed:
    // escapeMarkdown turned `[^n1]` into `\[^n1\]`, breaking the construct.
    const details =
      "<details open><summary>S</summary>\n\nbody\n\n</details>";
    expect(renderOutbound(details).text).toBe(details);

    const math = "inline $x^2+y^2$ done";
    expect(renderOutbound(math).text).toBe(math);

    const footnotes = "claim[^n1] more\n\n[^n1]: body text";
    expect(renderOutbound(footnotes).text).toBe(footnotes);
  });

  it("a tg:// inline entity and a footnote survive TOGETHER in one message", () => {
    // Cross-feature composition (#4683 x #4685): the `tg-entity` fold (mdast
    // image position) and the footnote `raw` fold (footnoteReference /
    // footnoteDefinition) land in the SAME foldInline/foldBlock walk — this
    // pins that neither eats the other. On #4683 alone the footnote came back
    // as `claim\[^n1\]`; on #4685 alone (pre-rebase) the entity came back as
    // `!\[now\](tg://time?unix\=…)` literal text.
    const combined =
      "meet at ![now](tg://time?unix=1755000000&format=wDT) as promised[^n1]\n\n[^n1]: agreed yesterday";
    expect(renderOutbound(combined).text).toBe(combined);

    // Same pair inside ONE paragraph plus the guard seam on top: the composed
    // wire body (renderOutbound then the richMessage guard, i.e. the full
    // streamed send path) is still byte-identical.
    const guarded = guardAccidentalFormatting(renderOutbound(combined).text);
    expect(guarded).toBe(combined);
  });

  it("falls back to plain mode for oversized atomic content", () => {
    // A single code block far over the cap cannot be safely emitted as rich.
    const huge = "```\n" + "x".repeat(40000) + "\n```";
    const r = renderOutbound(huge, 1000);
    expect(r.mode).toBe("plain");
  });
});
