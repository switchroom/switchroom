/**
 * Phase 1 of #233: telegram-plugin manifest scaffolding (#229).
 *
 * The manifest establishes the path for #230 (scaffold.ts switching from
 * the hand-installed .mcp.json + hook commands to plugin-driven
 * `enabledPlugins: { 'switchroom-telegram': true }`). This phase changes
 * no agent behaviour — it just adds files. Tests pin existence + JSON
 * shape so a future template edit can't silently regress the manifest.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

describe("telegram-plugin manifest (#229)", () => {
  it("plugin.json exists and declares switchroom-telegram", () => {
    const path = join(REPO_ROOT, "telegram-plugin", ".claude-plugin", "plugin.json");
    expect(existsSync(path)).toBe(true);
    const m = JSON.parse(readFileSync(path, "utf-8"));
    expect(m.name).toBe("switchroom-telegram");
    expect(typeof m.version).toBe("string");
    expect(m.version.length).toBeGreaterThan(0);
  });

  it(".mcp.json declares the switchroom-telegram MCP server", () => {
    const path = join(REPO_ROOT, "telegram-plugin", ".mcp.json");
    expect(existsSync(path)).toBe(true);
    const m = JSON.parse(readFileSync(path, "utf-8"));
    expect(m.mcpServers).toBeDefined();
    expect(m.mcpServers["switchroom-telegram"]).toBeDefined();
    const server = m.mcpServers["switchroom-telegram"];
    expect(server.command).toBe("bun");
    expect(Array.isArray(server.args)).toBe(true);
    // Must use ${CLAUDE_PLUGIN_ROOT} so the plugin loader resolves the
    // cwd correctly when installed from the marketplace.
    expect(server.args.some((a: string) => a.includes("${CLAUDE_PLUGIN_ROOT}"))).toBe(true);
  });

  it("hooks/hooks.json declares the four hook events the plugin owns", () => {
    const path = join(REPO_ROOT, "telegram-plugin", "hooks", "hooks.json");
    expect(existsSync(path)).toBe(true);
    const m = JSON.parse(readFileSync(path, "utf-8"));
    expect(m.hooks).toBeDefined();
    expect(Array.isArray(m.hooks.PreToolUse)).toBe(true);
    expect(Array.isArray(m.hooks.PostToolUse)).toBe(true);
    expect(Array.isArray(m.hooks.Stop)).toBe(true);
  });

  it("hook commands all use ${CLAUDE_PLUGIN_ROOT}", () => {
    // Every hook command in the plugin must be portable across install
    // paths — that's the whole point of the manifest. Hardcoded absolute
    // paths would break the moment someone installs from a different
    // marketplace or a different repo location.
    const path = join(REPO_ROOT, "telegram-plugin", "hooks", "hooks.json");
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands: string[] = [];
    for (const eventGroups of Object.values(m.hooks)) {
      for (const group of eventGroups) {
        for (const h of group.hooks) {
          allCommands.push(h.command);
        }
      }
    }
    expect(allCommands.length).toBeGreaterThan(0);
    for (const c of allCommands) {
      expect(c).toContain("${CLAUDE_PLUGIN_ROOT}");
    }
  });

  it("hook commands cover the same five hook surfaces scaffold.ts wires today", () => {
    // The plugin manifest must own the same set of hook scripts the
    // scaffold currently writes by hand. This pins the migration
    // contract: #230 swaps scaffold's hand-wired path for the plugin
    // path, but the scripts that run must be identical.
    const path = join(REPO_ROOT, "telegram-plugin", "hooks", "hooks.json");
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const all = JSON.stringify(m);
    expect(all).toContain("secret-guard-pretool.mjs");
    expect(all).toContain("subagent-tracker-pretool.mjs");
    expect(all).toContain("subagent-tracker-posttool.mjs");
    expect(all).toContain("secret-scrub-stop.mjs");
    expect(all).toContain("silent-end-interrupt-stop.mjs");
  });

  it("subagent-tracker hooks gate on Agent or Task (regex matcher)", () => {
    // Pre-#262: matcher was the literal "Agent". Post-fix: regex
    // covering both `Agent` and `Task` for Claude Code version
    // compatibility. Pin so the plugin manifest stays aligned with
    // the gate the tracker hooks themselves enforce.
    const path = join(REPO_ROOT, "telegram-plugin", "hooks", "hooks.json");
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    const trackerEntries = [...(m.hooks.PreToolUse ?? []), ...(m.hooks.PostToolUse ?? [])].filter((g) =>
      g.hooks.some((h) => h.command.includes("subagent-tracker"))
    );
    expect(trackerEntries.length).toBeGreaterThanOrEqual(2);
    for (const entry of trackerEntries) {
      expect(entry.matcher).toBe("^(Agent|Task)$");
    }
  });
});

describe("marketplace.json — switchroom-telegram entry (#229)", () => {
  it("includes a second plugin entry pointing at telegram-plugin/", () => {
    const path = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
    expect(existsSync(path)).toBe(true);
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      plugins: Array<{ name: string; source: string; category?: string }>;
    };
    expect(m.plugins.length).toBeGreaterThanOrEqual(2);
    const telegramEntry = m.plugins.find((p) => p.name === "switchroom-telegram");
    expect(telegramEntry).toBeDefined();
    expect(telegramEntry!.source).toBe("./telegram-plugin");
    expect(telegramEntry!.category).toBe("messaging");
  });

  it("marketplace source path resolves to a real directory", () => {
    const path = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      plugins: Array<{ source: string }>;
    };
    for (const p of m.plugins) {
      // Resolve relative to the repo root since `source` paths are repo-relative.
      const resolved = resolve(REPO_ROOT, p.source);
      expect(existsSync(resolved)).toBe(true);
    }
  });
});
