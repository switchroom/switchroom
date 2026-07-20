import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getBuiltinDefaultSkillEntries } from "../src/memory/scaffold-integration.js";

const skillPath = resolve(__dirname, "../skills/switchroom-manage/SKILL.md");

describe("switchroom-manage skill", () => {
  const content = readFileSync(skillPath, "utf-8");

  it("exists and is readable", () => {
    expect(content).toBeTruthy();
  });

  it("has valid frontmatter with name field", () => {
    expect(content).toMatch(/^---\n[\s\S]*?name:\s*switchroom-manage[\s\S]*?---/);
  });

  it("has valid frontmatter with description field", () => {
    expect(content).toMatch(
      /^---\n[\s\S]*?description:\s*.+[\s\S]*?---/
    );
  });

  it("references switchroom agent list command", () => {
    expect(content).toContain("switchroom agent list");
  });

  it("references switchroom agent start command", () => {
    expect(content).toContain("switchroom agent start");
  });

  it("references switchroom agent stop command", () => {
    expect(content).toContain("switchroom agent stop");
  });

  it("references switchroom restart command", () => {
    expect(content).toContain("switchroom restart");
  });

  it("references switchroom apply command", () => {
    expect(content).toContain("switchroom apply");
  });

  it("references switchroom version command", () => {
    expect(content).toContain("switchroom version");
  });

  it("references switchroom memory search command", () => {
    expect(content).toContain("switchroom memory search");
  });

  it("references switchroom vault list command", () => {
    expect(content).toContain("switchroom vault list");
  });

  it("references switchroom topics list command", () => {
    expect(content).toContain("switchroom topics list");
  });
});

describe("telegram-formatting skill (PR4 — full palette on demand)", () => {
  const tfPath = resolve(__dirname, "../skills/telegram-formatting/SKILL.md");

  it("is registered as a bundled default skill on every agent", () => {
    // Outcome assertion: dropping the entry from getBuiltinDefaultSkillEntries
    // silently stops the skill reaching agents — this test goes RED if that
    // registration is removed.
    const keys = getBuiltinDefaultSkillEntries().map((e) => e.key);
    expect(keys).toContain("telegram-formatting");
  });

  it("exists on disk in the bundled skills pool with matching frontmatter", () => {
    expect(existsSync(tfPath)).toBe(true);
    const content = readFileSync(tfPath, "utf-8");
    expect(content).toMatch(
      /^---\n[\s\S]*?name:\s*telegram-formatting[\s\S]*?---/,
    );
    expect(content).toMatch(/^---\n[\s\S]*?description:\s*.+[\s\S]*?---/);
  });

  it("carries the built-but-underused rich constructs", () => {
    const content = readFileSync(tfPath, "utf-8");
    expect(content).toContain("Expandable blockquote");
    expect(content).toContain("Spoiler");
    expect(content).toContain("Highlight");
    expect(content).toContain("32768");
    expect(content).toContain("escapeMarkdown");
  });

  it("does NOT re-advertise the constructs PR3 removed as false", () => {
    // PR3 removed inline math, details/collapsible, and footnotes from the
    // truthful guide because they don't render; the skill must not resurrect
    // them as usable, and must not present underline as a real construct.
    const content = readFileSync(tfPath, "utf-8");
    // No positive advertisement of math/details/footnotes syntax as usable.
    expect(content).not.toMatch(/\$[^$\n]+\$\s*\|/); // no "$x=1$ |" table row
    expect(content).not.toContain("<details>|"); // not offered as a block row
    // Underline is presented as NOT a real construct (renders as bold), not advertised.
    expect(content).toMatch(/renders\s+as\s+\*\*bold\*\*/);
    expect(content).toContain("NO underline token");
  });
});
