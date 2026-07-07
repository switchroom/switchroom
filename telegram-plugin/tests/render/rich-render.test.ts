import { describe, it, expect } from "vitest";
import {
  parseRichRenderEnabled,
  richRenderEnabled,
  renderOutbound,
  maybeRenderOutbound,
} from "../../render/rich-render.js";

describe("parseRichRenderEnabled", () => {
  it("defaults OFF when unset", () => {
    expect(parseRichRenderEnabled(undefined)).toBe(false);
  });
  it("accepts the truthy tokens", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
      expect(parseRichRenderEnabled(v)).toBe(true);
    }
  });
  it("treats everything else as OFF", () => {
    for (const v of ["0", "false", "off", "no", "", "maybe"]) {
      expect(parseRichRenderEnabled(v)).toBe(false);
    }
  });
});

describe("richRenderEnabled", () => {
  it("reads SWITCHROOM_RICH_RENDER, default OFF", () => {
    expect(richRenderEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      richRenderEnabled({ SWITCHROOM_RICH_RENDER: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("maybeRenderOutbound", () => {
  it("flag OFF is a byte-for-byte passthrough (no behavioural change)", () => {
    const raw = "**bold** and a\n\n**> collapsible quote\n> second line";
    const r = maybeRenderOutbound(raw, {} as NodeJS.ProcessEnv);
    expect(r.mode).toBe("markdown");
    expect(r.text).toBe(raw);
  });

  it("flag ON routes through parse -> renderSafe", () => {
    const r = maybeRenderOutbound("**> collapsible", {
      SWITCHROOM_RICH_RENDER: "1",
    } as NodeJS.ProcessEnv);
    expect(r.mode).toBe("markdown");
    // The expandable blockquote round-trips back to the `**> ` marker.
    expect(r.text).toContain("**> ");
  });

  it("flag ON preserves plain prose through the round-trip", () => {
    const r = maybeRenderOutbound("just some plain text", {
      SWITCHROOM_RICH_RENDER: "1",
    } as NodeJS.ProcessEnv);
    expect(r.text).toContain("just some plain text");
  });

  it("flag ON round-trips underline / spoiler / highlight", () => {
    const on = { SWITCHROOM_RICH_RENDER: "1" } as NodeJS.ProcessEnv;
    expect(maybeRenderOutbound("__u__", on).text).toBe("__u__");
    expect(maybeRenderOutbound("a ||s|| b", on).text).toBe("a ||s|| b");
    expect(maybeRenderOutbound("a ==m== b", on).text).toBe("a ==m== b");
  });

  it("flag OFF passes new constructs through untouched too", () => {
    const raw = "__u__ and ||s|| and ==m==";
    const r = maybeRenderOutbound(raw, {} as NodeJS.ProcessEnv);
    expect(r.text).toBe(raw);
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
