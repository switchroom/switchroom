/**
 * #2483 — setSwitchroomTimezone YAML writer. Pins: writes the zone under
 * the root switchroom: block preserving siblings + comments; idempotent;
 * refuses UTC and malformed zones; produces schema-valid config.
 */
import { describe, it, expect } from "vitest";
import { parseDocument, parse } from "yaml";
import { setSwitchroomTimezone } from "./timezone-setup-yaml.js";
import { SwitchroomConfigSchema } from "../config/schema.js";

const BASE = `# top-level comment
switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents
telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "0"
agents:
  assistant:
    topic_name: "Assistant"
`;

describe("setSwitchroomTimezone", () => {
  it("writes timezone under the root switchroom: block, preserving siblings", () => {
    const out = setSwitchroomTimezone(BASE, "Australia/Melbourne");
    const doc = parseDocument(out);
    expect(doc.getIn(["switchroom", "timezone"])).toBe("Australia/Melbourne");
    // siblings survive
    expect(doc.getIn(["switchroom", "version"])).toBe(1);
    expect(doc.getIn(["switchroom", "agents_dir"])).toBe("~/.switchroom/agents");
    // surrounding blocks + comment survive
    expect(out).toMatch(/^# top-level comment/m);
    expect(out).toContain("agents:");
  });

  it("accepts a three-segment IANA zone", () => {
    const out = setSwitchroomTimezone(BASE, "America/Argentina/Buenos_Aires");
    expect(parseDocument(out).getIn(["switchroom", "timezone"])).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("is idempotent — same value returns input verbatim", () => {
    const once = setSwitchroomTimezone(BASE, "Europe/London");
    const twice = setSwitchroomTimezone(once, "Europe/London");
    expect(twice).toBe(once);
  });

  it("updates an existing timezone in place", () => {
    const withTz = setSwitchroomTimezone(BASE, "Europe/London");
    const out = setSwitchroomTimezone(withTz, "Asia/Tokyo");
    expect(parseDocument(out).getIn(["switchroom", "timezone"])).toBe("Asia/Tokyo");
    expect(out).not.toMatch(/Europe\/London/);
  });

  it("refuses to persist UTC (the silent fallback this write avoids)", () => {
    expect(() => setSwitchroomTimezone(BASE, "UTC")).toThrow(/refusing to persist UTC/);
  });

  it("rejects malformed zones (offsets, three-letter aliases, empty)", () => {
    for (const bad of ["EST", "PST", "UTC+10", "+10:00", ""]) {
      expect(() => setSwitchroomTimezone(BASE, bad)).toThrow();
    }
  });

  it("throws on a non-map YAML root (defensive)", () => {
    expect(() => setSwitchroomTimezone("- a\n- b\n", "Asia/Tokyo")).toThrow(/not a map/);
  });

  it("ensures a trailing newline", () => {
    const out = setSwitchroomTimezone(BASE.trimEnd(), "Asia/Tokyo");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("produces a config the schema accepts", () => {
    const out = setSwitchroomTimezone(BASE, "Australia/Melbourne");
    const cfg = SwitchroomConfigSchema.parse(parse(out));
    expect(cfg.switchroom.timezone).toBe("Australia/Melbourne");
  });
});
