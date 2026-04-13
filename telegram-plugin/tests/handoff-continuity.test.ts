import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgentDirFromEnv,
  readHandoffTopic,
  consumeHandoffTopic,
  shouldShowHandoffLine,
  formatHandoffLine,
  TOPIC_DISPLAY_MAX,
  HANDOFF_TOPIC_FILENAME,
} from "../handoff-continuity.js";

describe("resolveAgentDirFromEnv", () => {
  const prior = process.env.TELEGRAM_STATE_DIR;
  afterEach(() => {
    if (prior === undefined) delete process.env.TELEGRAM_STATE_DIR;
    else process.env.TELEGRAM_STATE_DIR = prior;
  });

  it("returns dirname of TELEGRAM_STATE_DIR", () => {
    process.env.TELEGRAM_STATE_DIR = "/foo/bar/agent/telegram";
    expect(resolveAgentDirFromEnv()).toBe("/foo/bar/agent");
  });

  it("returns null when env unset", () => {
    delete process.env.TELEGRAM_STATE_DIR;
    expect(resolveAgentDirFromEnv()).toBeNull();
  });

  it("returns null when env is empty string", () => {
    process.env.TELEGRAM_STATE_DIR = "   ";
    expect(resolveAgentDirFromEnv()).toBeNull();
  });
});

describe("readHandoffTopic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-topic-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when the file is missing", () => {
    expect(readHandoffTopic(tmp)).toBeNull();
  });

  it("returns null when the file is empty", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "");
    expect(readHandoffTopic(tmp)).toBeNull();
  });

  it("returns the trimmed single-line topic", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "  debugging the plugin  ");
    expect(readHandoffTopic(tmp)).toBe("debugging the plugin");
  });

  it("takes the first non-empty line when the file is multi-line", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "\n\nfirst topic\nsecond\n");
    expect(readHandoffTopic(tmp)).toBe("first topic");
  });

  it("truncates topics longer than the display max", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "x".repeat(TOPIC_DISPLAY_MAX + 20));
    const got = readHandoffTopic(tmp)!;
    expect(got.endsWith("…")).toBe(true);
    expect(got.length).toBe(TOPIC_DISPLAY_MAX + 1);
  });
});

describe("consumeHandoffTopic", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "handoff-consume-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the topic and deletes the file", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "once");
    expect(consumeHandoffTopic(tmp)).toBe("once");
    expect(existsSync(join(tmp, HANDOFF_TOPIC_FILENAME))).toBe(false);
  });

  it("returns null on the second call (one-shot)", () => {
    writeFileSync(join(tmp, HANDOFF_TOPIC_FILENAME), "once");
    expect(consumeHandoffTopic(tmp)).toBe("once");
    expect(consumeHandoffTopic(tmp)).toBeNull();
  });

  it("returns null when the file is missing", () => {
    expect(consumeHandoffTopic(tmp)).toBeNull();
  });
});

describe("shouldShowHandoffLine", () => {
  const prior = process.env.CLERK_HANDOFF_SHOW_LINE;
  afterEach(() => {
    if (prior === undefined) delete process.env.CLERK_HANDOFF_SHOW_LINE;
    else process.env.CLERK_HANDOFF_SHOW_LINE = prior;
  });

  it("defaults to true when unset", () => {
    delete process.env.CLERK_HANDOFF_SHOW_LINE;
    expect(shouldShowHandoffLine()).toBe(true);
  });

  it("returns true for 'true'", () => {
    process.env.CLERK_HANDOFF_SHOW_LINE = "true";
    expect(shouldShowHandoffLine()).toBe(true);
  });

  it("returns false for 'false' (case-insensitive)", () => {
    process.env.CLERK_HANDOFF_SHOW_LINE = "FALSE";
    expect(shouldShowHandoffLine()).toBe(false);
  });

  it("returns true for any other value (safe default)", () => {
    process.env.CLERK_HANDOFF_SHOW_LINE = "yes";
    expect(shouldShowHandoffLine()).toBe(true);
  });
});

describe("formatHandoffLine", () => {
  it("wraps the topic in italic HTML with the return emoji", () => {
    const line = formatHandoffLine("fixing the bug", "html");
    expect(line).toBe("<i>↩️ Picked up where we left off — fixing the bug</i>\n\n");
  });

  it("escapes HTML-unsafe chars in the topic", () => {
    const line = formatHandoffLine("<script> & ok", "html");
    expect(line).toContain("&lt;script&gt; &amp; ok");
    expect(line).not.toContain("<script>");
  });

  it("produces MarkdownV2 italic with escaped specials", () => {
    const line = formatHandoffLine("a.b (c)", "markdownv2");
    expect(line.startsWith("_")).toBe(true);
    expect(line.endsWith("_\n\n")).toBe(true);
    expect(line).toContain("a\\.b");
    expect(line).toContain("\\(c\\)");
  });

  it("produces plain text for 'text' format", () => {
    const line = formatHandoffLine("simple", "text");
    expect(line).toBe("↩️ Picked up where we left off — simple\n\n");
  });

  it("always ends with a blank-line separator", () => {
    for (const fmt of ["html", "markdownv2", "text"] as const) {
      expect(formatHandoffLine("t", fmt).endsWith("\n\n")).toBe(true);
    }
  });
});
