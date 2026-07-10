/**
 * L4 render safety — reference/rfcs/cheap-cron-sessions.md §2.2.
 *
 * The load-bearing property: the cron-session fork in start.sh renders
 * EMPTY unless `cronSessionEnabled` (a config-derived flag that is false
 * for every current fleet agent), so adding this feature does not change
 * any current agent's boot. Plus the cron-session launcher's compliance
 * (interactive claude, no -p) + correct identity.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  modelQ: "'claude-sonnet-5'",
  cronModelQ: "'claude-sonnet-5'",
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
    expect(out).toContain("--model 'claude-sonnet-5'");
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

describe("cron-session.sh LiteLLM routing — mirrors start.sh boot block", () => {
  const src = readFileSync(CRON_SH, "utf-8");
  const out = renderTemplate(CRON_SH, baseCtx);

  it("vault lookup uses the BASE name ({{name}} → marko), never the cron identity", () => {
    // The virtual key is provisioned under litellm/marko/api-key, NOT
    // litellm/marko-cron/api-key. The template var bakes the base name at
    // scaffold time — no fragile runtime suffix-stripping.
    expect(out).toContain('switchroom vault get "litellm/marko/api-key"');
    expect(out).not.toContain("marko-cron/api-key");
    // Template source must use {{name}}, not a hardcoded literal or runtime strip.
    expect(src).toContain('litellm/{{name}}/api-key');
  });

  it("is gated on SWITCHROOM_LITELLM — inert when not set", () => {
    expect(out).toContain('if [ -n "${SWITCHROOM_LITELLM:-}" ]');
  });

  it("exports ANTHROPIC_CUSTOM_HEADERS and CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY when key present", () => {
    expect(out).toContain("x-litellm-api-key: Bearer $sr_ll_key");
    // Attribution now uses the compile-time-literal cron identity (marko-cron)
    // consistently — no longer a runtime $SWITCHROOM_AGENT_NAME (drift fix). The
    // value is identical (line 69 sets SWITCHROOM_AGENT_NAME=$CRON_NAME).
    expect(out).toContain("x-litellm-customer-id: marko-cron");
    expect(out).toContain("x-litellm-tags: agent:marko-cron");
    expect(out).not.toContain("x-litellm-customer-id: $SWITCHROOM_AGENT_NAME");
    expect(out).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1");
  });

  it("MISSING KEY fails open: unsets ALL routing vars → direct OAuth, loud log", () => {
    expect(out).toContain(
      "unset ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL SWITCHROOM_LITELLM",
    );
    // The missing-key branch still fails open (correct — no metered route).
    expect(out).toContain("no virtual key for 'marko'");
    expect(out).toContain("falling back to direct OAuth");
  });

  it("PROXY UNREACHABLE with key does NOT fail open — keeps routing + self-heals (ported from start.sh)", () => {
    // The pre-#2940 cron logic unset routing on unreachable → untracked direct
    // OAuth for the fire. The new contract keeps routing in place, loud-warns,
    // and exports the header so it self-heals when the proxy returns.
    expect(out).toContain('sr_ll_unreachable="1"');
    expect(out).toContain("routing LEFT IN PLACE");
    expect(out).toContain("NOT falling back to untracked direct Anthropic OAuth");
    // The header-export arm fires for BOTH ok and unreachable (key in hand).
    expect(out).toContain('if [ -n "$sr_ll_ok" ] || [ -n "$sr_ll_unreachable" ]; then');
    // The old fail-open-on-unreachable log wording is gone.
    expect(out).not.toContain("no tracking/guardrail this session");
  });

  it("bounded SHORT retry budget (3 attempts) — not start.sh's 120s deadline", () => {
    // Cron latency budget: a few quick retries, then keep routing anyway.
    expect(out).toContain('[ "$sr_ll_try" -ge 3 ]');
    expect(out).not.toContain("+ 120 ))"); // no 120s boot-probe deadline here
  });

  it("dispatch (executed): UNREACHABLE keeps routing + HEADER, MISSING KEY strips it", () => {
    // Slice JUST the decision dispatch (skips the 15s probe loop): from the
    // shared decision `if` through the scratch-var cleanup, driven by preset
    // flags — the real strip-vs-keep code paths without any sleeping.
    const dispStart = out.indexOf(
      'if [ -n "$sr_ll_ok" ] || [ -n "$sr_ll_unreachable" ]; then',
    );
    const endMarker = "unset sr_ll_key sr_ll_ok sr_ll_unreachable";
    const dispEnd = out.indexOf(endMarker, dispStart) + endMarker.length;
    expect(dispStart).toBeGreaterThan(-1);
    expect(dispEnd).toBeGreaterThan(dispStart);
    const dispatch = out.slice(dispStart, dispEnd);

    const runDispatch = (preset: { ok: string; unreachable: string }): Record<string, string> => {
      const script = [
        "set -e",
        "unset ANTHROPIC_CUSTOM_HEADERS",
        "export SWITCHROOM_AGENT_NAME=marko-cron",
        "export SWITCHROOM_AGENT_PROFILE=default",
        'export ANTHROPIC_BASE_URL="http://litellm:4010/anthropic"',
        "export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5",
        "export SWITCHROOM_LITELLM=1",
        'export SWITCHROOM_LITELLM_BASE="http://litellm:4010"',
        "sr_ll_key=k",
        `sr_ll_ok=${JSON.stringify(preset.ok)}`,
        `sr_ll_unreachable=${JSON.stringify(preset.unreachable)}`,
        dispatch,
        'echo "BASEURL=${ANTHROPIC_BASE_URL:-__UNSET__}"',
        'echo "LITELLM=${SWITCHROOM_LITELLM:-__UNSET__}"',
        'if [ -n "${ANTHROPIC_CUSTOM_HEADERS:-}" ]; then echo "HEADERS=SET"; else echo "HEADERS=__UNSET__"; fi',
        'case "${ANTHROPIC_CUSTOM_HEADERS:-}" in *"Bearer k"*) echo "KEYINHEADER=YES";; *) echo "KEYINHEADER=NO";; esac',
        'case "${ANTHROPIC_CUSTOM_HEADERS:-}" in *"customer-id: marko-cron"*) echo "CRONID=YES";; *) echo "CRONID=NO";; esac',
      ].join("\n");
      const cmdOut = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      return Object.fromEntries(
        [...cmdOut.matchAll(/^(BASEURL|LITELLM|HEADERS|KEYINHEADER|CRONID)=(.*)$/gm)].map((m) => [
          m[1],
          m[2].trim(),
        ]),
      );
    };

    // Proxy unreachable → routing SURVIVES and the auth header is exported with
    // the key + cron identity, so the fire self-heals instead of running dark.
    const unreachable = runDispatch({ ok: "", unreachable: "1" });
    expect(unreachable.BASEURL).toBe("http://litellm:4010/anthropic");
    expect(unreachable.LITELLM).toBe("1");
    expect(unreachable.HEADERS).toBe("SET");
    expect(unreachable.KEYINHEADER).toBe("YES");
    expect(unreachable.CRONID).toBe("YES");

    // Missing key → fail-open strip (routing gone; no header).
    const missingKey = runDispatch({ ok: "", unreachable: "" });
    expect(missingKey.BASEURL).toBe("__UNSET__");
    expect(missingKey.LITELLM).toBe("__UNSET__");
    expect(missingKey.HEADERS).toBe("__UNSET__");
  });

  it("LiteLLM block appears BEFORE the tmux new-session call", () => {
    const litellmIdx = out.indexOf("SWITCHROOM_LITELLM");
    const tmuxIdx = out.indexOf("tmux -L");
    expect(litellmIdx, "SWITCHROOM_LITELLM not found in rendered output").toBeGreaterThanOrEqual(0);
    expect(tmuxIdx, "tmux -L not found in rendered output").toBeGreaterThan(0);
    expect(litellmIdx, "LiteLLM block must precede the tmux launch").toBeLessThan(tmuxIdx);
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
