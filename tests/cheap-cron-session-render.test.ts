/**
 * L4 render safety — docs/rfcs/cheap-cron-sessions.md §2.2.
 *
 * The load-bearing property: the cron-session fork in start.sh renders
 * EMPTY unless `cronSessionEnabled` (a config-derived flag that is false
 * for every current fleet agent), so adding this feature does not change
 * any current agent's boot. Plus the cron-session launcher's compliance
 * (interactive claude, no -p) + correct identity.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "../src/agents/profiles.js";
import { scheduleNeedsCronSession } from "../src/scheduler/cron-routing.js";

const START_SH = join(__dirname, "..", "profiles", "_base", "start.sh.hbs");
const CRON_SH = join(__dirname, "..", "profiles", "_base", "cron-session.sh.hbs");

const baseCtx = {
  name: "marko",
  agentDir: "/state/agent",
  securityPluginDir: "/opt/switchroom/security-plugin",
  useSwitchroomPlugin: true,
  modelQ: "'claude-sonnet-4-6'",
  cronModelQ: "'claude-sonnet-4-6'",
};

// Structural assertion on the template SOURCE (start.sh.hbs uses custom
// handlebars helpers registered by scaffold, so standalone render isn't
// representative — mirror gateway-supervisor-backoff.test.ts's raw-source
// approach). The load-bearing guarantee: every line of the cron fork lives
// strictly inside a single {{#if cronSessionEnabled}}…{{/if}} block, so the
// flag-false render is byte-identical to before the feature.
describe("start.sh cron-session fork — gated by {{#if cronSessionEnabled}}", () => {
  const src = readFileSync(START_SH, "utf-8");

  it("the fork block exists and references cron-session.sh", () => {
    expect(src).toContain("cheap cron SESSION");
    expect(src).toContain("_switchroom_supervise cron-session");
    expect(src).toContain('bash "$(dirname "$0")/cron-session.sh"');
  });

  it("EVERY cron-fork line is inside one {{#if cronSessionEnabled}} guard", () => {
    const lines = src.split("\n");
    const open = lines.findIndex((l) => l.includes("{{#if cronSessionEnabled}}"));
    expect(open, "fork guard not found").toBeGreaterThanOrEqual(0);
    // the matching {{/if}} — the next {{/if}} after open (the block has no nested #if)
    let close = -1;
    for (let i = open + 1; i < lines.length; i++) {
      if (lines[i].includes("{{#if")) throw new Error("unexpected nested #if in cron fork block");
      if (lines[i].includes("{{/if}}")) { close = i; break; }
    }
    expect(close, "fork guard not closed").toBeGreaterThan(open);
    const block = lines.slice(open, close + 1).join("\n");
    // all the cron-specific tokens are within the guarded block…
    expect(block).toContain("cron-session.sh");
    expect(block).toContain("_switchroom_supervise cron-session");
    // …and NOT anywhere outside it.
    const outside = lines.slice(0, open).concat(lines.slice(close + 1)).join("\n");
    expect(outside).not.toContain("cron-session.sh");
    expect(outside).not.toContain("cheap cron SESSION");
  });
});

describe("cron-session.sh launcher — compliance + identity", () => {
  const out = renderTemplate(CRON_SH, baseCtx);

  it("is interactive claude — NEVER claude -p (pillar 3)", () => {
    expect(out).toContain("tmux -L");
    expect(out).toMatch(/\bclaude\b/);
    expect(out).not.toMatch(/claude\s+-p\b/);
    expect(out).not.toContain("--print");
  });

  it("creates the tmux session DETACHED (-d), not attached (-A) — it's a no-TTY background sidecar", () => {
    // `new-session -A` (attach) dies "open terminal failed: not a terminal" in
    // the supervised background fork (no controlling TTY) — the bug that kept
    // the cron bridge from ever registering. -d runs claude in a detached pane.
    expect(out).toMatch(/new-session -d -s "\$CRON_NAME"/);
    expect(out).not.toMatch(/new-session -A/);
    // and it blocks while the session lives so the supervisor sees a long-running child.
    expect(out).toMatch(/while tmux -L "\$CRON_SOCKET" has-session -t "\$CRON_NAME"/);
  });

  it("forks a boot-phase autoaccept for the CRON socket (dismisses the dev-channels ack)", () => {
    // The main autoaccept watches switchroom-<name>; the cron session needs its
    // own (switchroom-<name>-cron) or it wedges on the per-boot dev-channels
    // prompt. Boot-phase only (WEDGE_WATCHDOG off → dismiss then exit).
    expect(out).toMatch(/SWITCHROOM_WEDGE_WATCHDOG=0 bun \/opt\/switchroom\/autoaccept-poll\.js "\$CRON_NAME"/);
  });

  it("registers as the cron bridge identity and its own config dir", () => {
    expect(out).toContain('SWITCHROOM_AGENT_NAME="$CRON_NAME"');
    expect(out).toContain('CRON_NAME="marko-cron"');
    expect(out).toContain('CLAUDE_CONFIG_DIR="$CRON_CONFIG_DIR"');
    expect(out).toContain(".claude-cron");
  });

  it("runs at the cheap cron model with the cron mcp config", () => {
    expect(out).toContain("--model 'claude-sonnet-4-6'");
    expect(out).toContain("--strict-mcp-config");
    // points at the cron config (full set, tool-search-deferred), with a
    // fallback to the main config for older scaffolds.
    expect(out).toContain(".claude-cron/.mcp.json");
    expect(out).toContain('[ -f "$CRON_MCP_CONFIG" ] ||');
  });

  it("Tier-1 un-starve (#2307): tool-search on, memory-sharing prompt, cwd aligned", () => {
    // full set defers via tool-search → keeps low context (honours the kill-switch)
    expect(out).toContain('ENABLE_TOOL_SEARCH="${ENABLE_TOOL_SEARCH:-auto}"');
    expect(out).toContain("SWITCHROOM_DISABLE_TOOL_SEARCH");
    // the append-prompt now tells the worker it SHARES memory + tools (not lobotomised)
    expect(out).toMatch(/SHARE .*memory/);
    expect(out).not.toMatch(/do not have .* full memory/);
    // cd into the workspace so claude's project key matches the seeded trust state
    expect(out).toMatch(/cd ".*" \|\| exit 1/);
  });

  it("self-gates on the runtime flag (exit 78, no respawn, only when explicitly disabled)", () => {
    expect(out).toContain("SWITCHROOM_CHEAP_CRON");
    expect(out).toContain("exit 78");
    // Cheap-cron is ON by default (mirrors isCheapCronEnabled): the gate must
    // exit only on the explicit kill-switch values, NOT default-off. The old
    // `1 | true | on) :;; *) exit 78` quarantined the session even with
    // cheap-by-default on, so every Tier-1 fire fell back to main and saved
    // nothing. Assert the disable-values arm and that the wildcard arm runs
    // (does not exit).
    expect(out).toMatch(/0 \| false \| off/i);
    // The non-disabled default arm is a no-op (`*) :`) — the session starts.
    expect(out).toMatch(/\*\)\s*:\s*;;/);
    // Guard against regressing to the old default-off gate.
    expect(out).not.toMatch(/1 \| true \| on \| ON\) : ;;/);
  });

  it("shares the broker OAuth creds via symlink (same subscription)", () => {
    expect(out).toContain(".credentials.json");
    expect(out).toContain("ln -sfn");
  });
});

describe("scheduleNeedsCronSession drives the gate", () => {
  it("no fresh entry → false (the whole fleet today)", () => {
    expect(scheduleNeedsCronSession([{ kind: "poll" }, {}], { cheapCronEnabled: true })).toBe(false);
  });
  it("a context:fresh entry → true", () => {
    expect(scheduleNeedsCronSession([{ context: "fresh" }], { cheapCronEnabled: true })).toBe(true);
  });
  it("a cheap-model entry → true", () => {
    expect(scheduleNeedsCronSession([{ model: "sonnet" }], { cheapCronEnabled: true })).toBe(true);
  });
  it("flag off → always false", () => {
    expect(scheduleNeedsCronSession([{ context: "fresh" }], { cheapCronEnabled: false })).toBe(false);
  });
});
