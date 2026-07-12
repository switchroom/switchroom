import { describe, it, expect } from "vitest";
import {
  parseRichRenderEnabled,
  richRenderEnabled,
  renderOutbound,
  maybeRenderOutbound,
} from "../../render/rich-render.js";

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
    // The expandable blockquote round-trips back to the `**> ` marker.
    expect(r.text).toContain("**> ");
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
    expect(r.text).toContain("**> ");
  });
});

describe("renderOutbound (flag-independent)", () => {
  it("renders an expandable blockquote round-trip end to end", () => {
    const r = renderOutbound("**> hidden line one\n> hidden line two");
    expect(r.mode).toBe("markdown");
    expect(r.text.split("\n")[0]).toMatch(/^\*\*> /);
  });

  it("falls back to plain mode for oversized atomic content", () => {
    // A single code block far over the cap cannot be safely emitted as rich.
    const huge = "```\n" + "x".repeat(40000) + "\n```";
    const r = renderOutbound(huge, 1000);
    expect(r.mode).toBe("plain");
  });
});
