import { describe, it, expect, afterEach } from "vitest";
import { resolveAgentDirFromEnv } from "../agent-dir.js";

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
