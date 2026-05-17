import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUpdatePromptHook, UPDATE_PROMPT_HOOK_FILENAME } from "./update-prompt-hook.js";

describe("installUpdatePromptHook — PR C UserPromptSubmit hook", () => {
  let tmp: string;
  let agentDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "update-prompt-hook-"));
    agentDir = join(tmp, "agent");
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    // Pre-seed a minimal settings.json — the real scaffold writes one
    // before our hook installer runs.
    writeFileSync(
      join(agentDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: [] } }, null, 2),
      "utf-8",
    );
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes the script at the expected path with mode 0o755", () => {
    const res = installUpdatePromptHook(agentDir);
    expect(res.scriptPath).toBe(join(agentDir, ".claude", "hooks", UPDATE_PROMPT_HOOK_FILENAME));
    expect(existsSync(res.scriptPath)).toBe(true);
    const mode = statSync(res.scriptPath).mode & 0o777;
    expect(mode).toBe(0o755);
    const body = readFileSync(res.scriptPath, "utf-8");
    expect(body).toMatch(/UserPromptSubmit hook/);
    expect(body).toMatch(/update_apply/);
  });

  it("registers the hook entry in settings.json", () => {
    installUpdatePromptHook(agentDir);
    const settings = JSON.parse(readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"));
    expect(Array.isArray(settings.hooks?.UserPromptSubmit)).toBe(true);
    const list = settings.hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const flat = list.flatMap(e => (Array.isArray(e.hooks) ? e.hooks : []));
    const cmds = flat.map((h: any) => h.command).filter(Boolean);
    expect(cmds.some(c => c.includes(UPDATE_PROMPT_HOOK_FILENAME))).toBe(true);
  });

  it("is idempotent — second run does not duplicate the entry", () => {
    installUpdatePromptHook(agentDir);
    installUpdatePromptHook(agentDir);
    const settings = JSON.parse(readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"));
    const list = settings.hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const flat = list.flatMap(e => (Array.isArray(e.hooks) ? e.hooks : []));
    const matches = flat.filter((h: any) => typeof h.command === "string" && h.command.includes(UPDATE_PROMPT_HOOK_FILENAME));
    expect(matches.length).toBe(1);
  });

  it("returns gracefully when settings.json is absent (scaffold not yet run)", () => {
    rmSync(join(agentDir, ".claude", "settings.json"));
    const res = installUpdatePromptHook(agentDir);
    expect(existsSync(res.scriptPath)).toBe(true);
  });
});
