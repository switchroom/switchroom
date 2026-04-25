import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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

  it("references switchroom update command", () => {
    expect(content).toContain("switchroom update");
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
