import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installUpdatePromptHook, containerHookCommand, UPDATE_PROMPT_HOOK_FILENAME } from "./update-prompt-hook.js";

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

  it("writes the script at the HOST path (in the bind-mounted volume)", () => {
    const res = installUpdatePromptHook(agentDir);
    // Script is written to the host-side agentDir so it lands in the
    // bind-mounted volume the container reads.
    expect(res.scriptPath).toBe(join(agentDir, ".claude", "hooks", UPDATE_PROMPT_HOOK_FILENAME));
    expect(existsSync(res.scriptPath)).toBe(true);
    const mode = statSync(res.scriptPath).mode & 0o777;
    expect(mode).toBe(0o755);
    const body = readFileSync(res.scriptPath, "utf-8");
    expect(body).toMatch(/UserPromptSubmit hook/);
    expect(body).toMatch(/update_apply/);
  });

  it("registers the hook command as the CONTAINER-STABLE path in settings.json", () => {
    // The command must use the in-container path (/state/agent/...), not the
    // host agentDir path. Claude Code runs inside the container and resolves
    // the command relative to the container filesystem. Using the host path
    // caused "hook not found" on every prompt (the host path doesn't exist
    // inside the container).
    installUpdatePromptHook(agentDir);
    const settings = JSON.parse(readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"));
    expect(Array.isArray(settings.hooks?.UserPromptSubmit)).toBe(true);
    const list = settings.hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const flat = list.flatMap(e => (Array.isArray(e.hooks) ? e.hooks : []));
    const cmds = flat.map((h: any) => h.command).filter(Boolean) as string[];
    const hookCmd = cmds.find(c => c.includes(UPDATE_PROMPT_HOOK_FILENAME));
    expect(hookCmd).toBeDefined();
    // Must be the container-stable path, never a host-absolute path.
    expect(hookCmd).toBe(containerHookCommand());
    expect(hookCmd).not.toContain(tmp);        // no host tmp path
    expect(hookCmd).toMatch(/^\/state\/agent/); // container-stable prefix
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

  it("migrates a stale host-path entry to the container-stable path on re-apply", () => {
    // Simulate a pre-fix installation: settings.json has the host path.
    const staleCommand = join(agentDir, ".claude", "hooks", UPDATE_PROMPT_HOOK_FILENAME);
    const staleSettings = {
      permissions: { allow: [] },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: staleCommand }] },
        ],
      },
    };
    writeFileSync(
      join(agentDir, ".claude", "settings.json"),
      JSON.stringify(staleSettings, null, 2),
      "utf-8",
    );

    const res = installUpdatePromptHook(agentDir);
    expect(res.installed).toBe(true); // something was changed (migration)

    const settings = JSON.parse(readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"));
    const list = settings.hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const flat = list.flatMap(e => (Array.isArray(e.hooks) ? e.hooks : []));
    const cmds = flat.map((h: any) => h.command).filter(Boolean) as string[];
    // Exactly one entry, now using the container-stable path.
    const hookCmds = cmds.filter(c => c.includes(UPDATE_PROMPT_HOOK_FILENAME));
    expect(hookCmds.length).toBe(1);
    expect(hookCmds[0]).toBe(containerHookCommand());
  });

  it("returns gracefully when settings.json is absent (scaffold not yet run)", () => {
    rmSync(join(agentDir, ".claude", "settings.json"));
    const res = installUpdatePromptHook(agentDir);
    expect(existsSync(res.scriptPath)).toBe(true);
  });
});
