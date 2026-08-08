import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  formatAuthLine,
  formatAgentLine,
  startText,
  helpText,
  statusPairedText,
  statusPendingText,
  statusUnpairedText,
  switchroomHelpText,
  switchroomHelpCommandNames,
  restartAckText,
  newSessionAckText,
  TELEGRAM_BASE_COMMANDS,
  TELEGRAM_SWITCHROOM_COMMANDS,
  TELEGRAM_MENU_COMMANDS,
  type AgentMetadata,
  type AuthSummary,
} from "../welcome-text";

const baseMeta: AgentMetadata = {
  agentName: "assistant",
  model: "sonnet",
  extendsProfile: "default",
  topicName: null,
  topicEmoji: null,
  uptime: null,
  status: null,
  auth: null,
};

describe("escapeHtml (now a markdown escaper, kept under the legacy name, #2669)", () => {
  it("escapes the inline-markdown specials (\\ ` * _ ~ = [ ] |); leaves < > & \" literal", () => {
    // The HTML escaper is gone — this is escapeMarkdown under the old name.
    // `< > & "` are literal in rich markdown; `* _ =` etc. are escaped.
    expect(escapeHtml('<foo bar="baz">&')).toBe('<foo bar\\="baz">&');
    expect(escapeHtml("a *b* _c_")).toBe("a \\*b\\* \\_c\\_");
  });
  it("leaves safe text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("formatAuthLine", () => {
  it("null auth → unknown", () => {
    expect(formatAuthLine(null)).toBe("— auth state unknown");
  });
  it("unauth, no pending", () => {
    expect(formatAuthLine({ authenticated: false, subscription_type: null, expires_in: null, auth_source: null }))
      .toBe("✗ not authenticated");
  });
  it("pending auth", () => {
    expect(formatAuthLine({ authenticated: false, subscription_type: null, expires_in: null, auth_source: "pending" }))
      .toBe("… pending auth");
  });
  it("authed Max with expiry", () => {
    expect(formatAuthLine({ authenticated: true, subscription_type: "Max", expires_in: "29 days", auth_source: "oauth" }))
      .toBe("✓ Max · expires 29 days");
  });
  it("authed Pro no expiry", () => {
    expect(formatAuthLine({ authenticated: true, subscription_type: "Pro", expires_in: null, auth_source: "oauth" }))
      .toBe("✓ Pro");
  });
  it("fallback label when subscription_type is null", () => {
    expect(formatAuthLine({ authenticated: true, subscription_type: null, expires_in: null, auth_source: "oauth" }))
      .toBe("✓ subscription");
  });
  it("passes < > literally (markdown, #2669) in subscription type", () => {
    expect(formatAuthLine({ authenticated: true, subscription_type: "<injected>", expires_in: null, auth_source: "oauth" }))
      .toContain("<injected>");
  });
});

describe("formatAgentLine", () => {
  it("includes model inline", () => {
    expect(formatAgentLine(baseMeta)).toContain("`sonnet`");
  });
  it("falls back to 'default' when model is null/empty", () => {
    expect(formatAgentLine({ ...baseMeta, model: null })).toContain("`default`");
    expect(formatAgentLine({ ...baseMeta, model: "" })).toContain("`default`");
  });
  it("appends topic when present", () => {
    const out = formatAgentLine({ ...baseMeta, topicName: "Planning", topicEmoji: "🗓" });
    expect(out).toContain("topic: 🗓 Planning");
  });
  it("shows the live session model alongside the configured model when a /model switch is active", () => {
    const out = formatAgentLine({ ...baseMeta, model: "claude-fable-5[1m]", sessionModel: "Opus 4.8 (1M context)" });
    // Both surfaces present + agree: configured AND what's actually running.
    expect(out).toContain("`claude-fable-5[1m]`");
    expect(out).toContain("live session: `Opus 4.8 (1M context)`");
  });
  it("omits the session line when no override is active", () => {
    expect(formatAgentLine({ ...baseMeta, sessionModel: null })).not.toContain("live session");
    expect(formatAgentLine({ ...baseMeta, sessionModel: "" })).not.toContain("live session");
    expect(formatAgentLine(baseMeta)).not.toContain("live session");
  });
  it("omits topic when only emoji is set", () => {
    // topicName null → no topic chunk. Keeps the line clean.
    expect(formatAgentLine({ ...baseMeta, topicEmoji: "🗓" })).not.toContain("topic");
  });
  it("passes < > literally (markdown, #2669) in agent name", () => {
    expect(formatAgentLine({ ...baseMeta, agentName: "<script>" }))
      .toContain("<script>");
  });
});

describe("startText", () => {
  it("dmDisabled path", () => {
    expect(startText("assistant", true)).toBe("This bot isn't accepting new connections.");
  });
  it("names the agent, not 'Claude Code session'", () => {
    const out = startText("assistant", false);
    expect(out).toContain("**assistant**");
    expect(out).not.toMatch(/Claude Code session/);
  });
  it("mentions pairing code flow", () => {
    const out = startText("assistant", false);
    expect(out).toContain("/telegram:access pair");
    expect(out).toContain("6-char code");
  });
  it("points at /status and /commands", () => {
    const out = startText("assistant", false);
    expect(out).toContain("/status");
    expect(out).toContain("/commands");
  });
  it("passes < > literally (markdown, #2669) in agent name", () => {
    expect(startText("<x>", false)).toContain("<x>");
  });
});

describe("helpText", () => {
  it("names the agent", () => {
    expect(helpText("klanker")).toContain("**klanker**");
  });
  it("mentions the new Sprint 2/3 commands", () => {
    const out = helpText("assistant");
    expect(out).toContain("/approve");
    expect(out).toContain("/deny");
    expect(out).toContain("/pending");
    expect(out).toContain("/new");
    expect(out).toContain("/compact");
    expect(out).toContain("/clear");
  });
  it("points at the richer /commands", () => {
    expect(helpText("assistant")).toContain("/commands");
  });
  it("drops the old 'Claude Code session' phrasing", () => {
    expect(helpText("assistant")).not.toMatch(/Claude Code session/);
  });
});

describe("statusPairedText", () => {
  const meta: AgentMetadata = {
    ...baseMeta,
    agentName: "assistant",
    model: "sonnet",
    auth: { authenticated: true, subscription_type: "Max", expires_in: "29 days", auth_source: "oauth" },
  };

  it("includes the paired-user tag", () => {
    expect(statusPairedText({ user: "@ken", meta })).toContain("Paired as @ken.");
  });
  it("shows agent + model + auth lines", () => {
    const out = statusPairedText({ user: "@ken", meta });
    expect(out).toContain("Agent:");
    expect(out).toContain("Auth: ✓ Max · expires 29 days");
    expect(out).toContain("`sonnet`");
  });
  it("omits status/uptime when absent", () => {
    expect(statusPairedText({ user: "@ken", meta })).not.toContain("Status:");
  });
  it("includes status/uptime when present", () => {
    const withStatus: AgentMetadata = { ...meta, status: "running", uptime: "3h 12m" };
    const out = statusPairedText({ user: "@ken", meta: withStatus });
    expect(out).toContain("Status: `running` · up 3h 12m");
  });

  // demo mode (the `/status demo` suffix) — masks the paired-user tag only.
  describe("demo mode", () => {
    it("WITHOUT demo, the real handle still renders (underscore markdown-escaped, #2669)", () => {
      // The `_` in the handle is escaped so it can't open an italic run in
      // the rich-markdown body — the handle renders as @ken\_real verbatim.
      expect(statusPairedText({ user: "@ken_real", meta })).toContain("Paired as @ken\\_real.");
    });
    it("WITH demo, the handle is masked to a @demo_user form", () => {
      const out = statusPairedText({ user: "@ken_real", meta, demo: true });
      expect(out).not.toContain("@ken_real");
      // The masked handle's underscore is markdown-escaped too.
      expect(out).toMatch(/Paired as @demo\\_user\d*\./);
    });
    it("WITH demo, a numeric sender id is masked to a @handle, not a raw number", () => {
      const out = statusPairedText({ user: "12345", meta, demo: true });
      expect(out).not.toContain("12345");
      expect(out).toMatch(/Paired as @demo\\_user\d*\./);
    });
    it("WITH demo, the agent/model/auth topology is NOT masked", () => {
      const out = statusPairedText({ user: "@ken_real", meta, demo: true });
      // Out-of-scope fields stay real.
      expect(out).toContain("Auth: ✓ Max · expires 29 days");
      expect(out).toContain("`sonnet`");
    });
  });

  // Issue #142 PR 3 — audit details surfaced on /status when the gateway
  // successfully loads switchroom.yaml. Pre-#142 this content lived in
  // the SessionStart greeting card; now it's pulled on demand.
  describe("audit block (#142 PR 3)", () => {
    const audit = {
      version: "v0.3.0+44 · 2h ago",
      tools: "Read, Write, Bash, Edit, Grep +12 more",
      toolsDeny: "WebFetch",
      skills: "git, telegram, vault, +3 more",
      limits: "idle 30m, 50 turns",
      channel: "switchroom (default)",
      memoryBank: "assistant",
    };

    it("does NOT render audit rows when meta.audit is undefined (yaml load failed)", () => {
      const out = statusPairedText({ user: "@ken", meta });
      expect(out).not.toContain("Version");
      expect(out).not.toContain("Tools");
      expect(out).not.toContain("Channel");
    });

    it("renders all audit rows when meta.audit is fully populated", () => {
      const withAudit: AgentMetadata = { ...meta, extendsProfile: "klanker", audit };
      const out = statusPairedText({ user: "@ken", meta: withAudit });
      expect(out).toContain("**Version** v0.3.0+44 · 2h ago");
      expect(out).toContain("**Profile** klanker");
      expect(out).toContain("**Tools** Read, Write, Bash, Edit, Grep +12 more");
      expect(out).toContain("**Deny** WebFetch");
      expect(out).toContain("**Skills** git, telegram, vault, +3 more");
      expect(out).toContain("**Limits** idle 30m, 50 turns");
      expect(out).toContain("**Channel** switchroom (default)");
      expect(out).toContain("**Memory** assistant");
    });

    it("omits Deny row when toolsDeny is null", () => {
      const partial: AgentMetadata = { ...meta, audit: { ...audit, toolsDeny: null } };
      const out = statusPairedText({ user: "@ken", meta: partial });
      expect(out).not.toContain("Deny");
      expect(out).toContain("**Tools**");
    });

    it("omits Skills row when skills is null (agent has no bundled skills)", () => {
      const partial: AgentMetadata = { ...meta, audit: { ...audit, skills: null } };
      const out = statusPairedText({ user: "@ken", meta: partial });
      expect(out).not.toContain("Skills");
    });

    it("renders the audit block AFTER the live state (Agent/Auth/Status)", () => {
      const withAudit: AgentMetadata = { ...meta, status: "running", uptime: "1h", audit };
      const out = statusPairedText({ user: "@ken", meta: withAudit });
      const statusIdx = out.indexOf("Status:");
      const versionIdx = out.indexOf("Version");
      expect(statusIdx).toBeGreaterThan(0);
      expect(versionIdx).toBeGreaterThan(statusIdx);
    });

    it("passes < > & literally (markdown, #2669) in audit values", () => {
      const hostile: AgentAuditLike = {
        version: "<script>alert(1)</script>",
        tools: "Read & <Write>",
        toolsDeny: null,
        skills: null,
        limits: "idle 30m",
        channel: "switchroom",
        memoryBank: "bank<>name",
      };
      const out = statusPairedText({ user: "@ken", meta: { ...meta, audit: hostile } });
      // < > & are literal in rich markdown — no HTML entities. The hostile
      // input is shown verbatim (it cannot inject formatting; only * _ ` etc.
      // would be, and those are escaped).
      expect(out).toContain("<script>alert(1)</script>");
      expect(out).toContain("Read & <Write>");
      expect(out).toContain("bank<>name");
    });

    it("handles empty extendsProfile (no Profile row when meta.extendsProfile is null)", () => {
      const withAudit: AgentMetadata = { ...meta, extendsProfile: null, audit };
      const out = statusPairedText({ user: "@ken", meta: withAudit });
      expect(out).not.toContain("**Profile**");
      // But other audit rows still render.
      expect(out).toContain("**Version**");
    });
  });

  // Live probe block — `/status` shows EVERY probe (green and otherwise).
  // This is the deliberate opposite of the boot card's silent-when-healthy
  // contract: boot card = quiet ack, /status = dashboard.
  describe("live health block", () => {
    it("does NOT render a Health section when meta.live is undefined", () => {
      const out = statusPairedText({ user: "@ken", meta });
      expect(out).not.toContain("**Health**");
    });

    it("does NOT render a Health section when meta.live is empty array", () => {
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live: [] } });
      expect(out).not.toContain("**Health**");
    });

    it("renders all probe rows including green ones", () => {
      const live: AgentMetadata["live"] = [
        { status: "ok",       label: "Account",   detail: "ken@x.com · Max · token 60d" },
        { status: "ok",       label: "Broker",    detail: "reachable" },
        { status: "degraded", label: "Skills",    detail: "1/5 dangling: foo" },
        { status: "fail",     label: "Scheduler", detail: "sidecar not running" },
      ];
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live } });
      expect(out).toContain("**Health**");
      expect(out).toContain("🟢 **Account**  ken@x.com · Max · token 60d");
      expect(out).toContain("🟢 **Broker**  reachable");
      expect(out).toContain("🟡 **Skills**  1/5 dangling: foo");
      expect(out).toContain("🔴 **Scheduler**  sidecar not running");
    });

    it("renders Health section before the audit block", () => {
      const live: AgentMetadata["live"] = [
        { status: "ok", label: "Account", detail: "ok" },
      ];
      const audit = {
        version: "v0.3.0", tools: "all", toolsDeny: null, skills: null,
        limits: "idle 30m", channel: "switchroom", memoryBank: "x",
      };
      const out = statusPairedText({
        user: "@ken",
        meta: { ...meta, live, audit },
      });
      const healthIdx = out.indexOf("**Health**");
      const versionIdx = out.indexOf("**Version**");
      expect(healthIdx).toBeGreaterThan(-1);
      expect(versionIdx).toBeGreaterThan(healthIdx);
    });

    it("passes < > literally (markdown, #2669) in probe detail strings", () => {
      const live: AgentMetadata["live"] = [
        { status: "fail", label: "Skills", detail: "<script>alert(1)</script>" },
      ];
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live } });
      expect(out).toContain("<script>alert(1)</script>");
    });
  });
});

// Regression: the Bot API 10.1 rich-message (GFM) renderer collapses a LONE
// `\n` between two non-blank lines into a SPACE (soft break), so a card built
// with `lines.join("\n")` renders as one run-on blob. The deterministic card
// builders MUST route through `stackCardLines`, which promotes every inter-
// field break to a GFM hard break (`  \n`) and keeps intentional `\n\n` block
// gaps. These tests pin that so the "/status renders as a giant run-on blob"
// bug can't silently regress.
describe("card line-break hardening (GFM soft-break blob fix)", () => {
  const meta: AgentMetadata = {
    ...baseMeta,
    agentName: "assistant",
    model: "sonnet",
    status: "running",
    uptime: "3h",
    auth: { authenticated: true, subscription_type: "Max", expires_in: "29 days", auth_source: "oauth" },
    live: [
      { status: "ok", label: "Broker", detail: "running" },
      { status: "ok", label: "Kernel", detail: "up" },
    ],
    audit: {
      version: "v0.3.0",
      tools: "all",
      skills: "git, vault",
      limits: "idle 30m",
      channel: "switchroom",
      memoryBank: "assistant",
    },
  };

  // Every adjacent field-pair inside a block is separated by a GFM hard break,
  // and NO two adjacent non-blank content lines are joined by a bare `\n`
  // (which would soft-collapse into a blob). Block separators stay `\n\n`.
  const assertNoSoftJoin = (out: string) => {
    const nl = out.split("\n");
    for (let i = 0; i < nl.length - 1; i++) {
      const cur = nl[i];
      const next = nl[i + 1];
      if (cur.trim() === "" || next.trim() === "") continue; // `\n\n` block gap
      // A hardened line ends in the two-space GFM hard-break marker.
      expect(cur.endsWith("  ")).toBe(true);
    }
  };

  it("/status: fields are hard-broken, not soft-collapsed into a blob", () => {
    const out = statusPairedText({ user: "@ken", meta });
    // Adjacent fields inside the identity block use a GFM hard break.
    expect(out).toContain("Auth: ✓ Max · expires 29 days  \n");
    // Health rows stack (hard break before each 🟢 row).
    expect(out).toContain("  \n🟢 **Kernel**");
    // Audit rows stack.
    expect(out).toContain("**Version** v0.3.0  \n");
    // Blocks stay separated by a real paragraph gap.
    expect(out).toContain("\n\n**Health**");
    assertNoSoftJoin(out);
  });

  it("/start, /help, /commands, /status-pending all hard-break their lines", () => {
    assertNoSoftJoin(startText("assistant", false));
    assertNoSoftJoin(helpText("assistant"));
    assertNoSoftJoin(switchroomHelpText("assistant"));
    assertNoSoftJoin(statusPendingText("abc-123"));
  });
});

// Local alias for the audit shape — duplicates the AgentMetadata.audit
// type so the test file doesn't have to re-import it just for one
// hostile-input fixture.
type AgentAuditLike = NonNullable<AgentMetadata["audit"]>;

describe("statusPendingText / statusUnpairedText", () => {
  it("pending includes the code verbatim", () => {
    expect(statusPendingText("abc-123")).toContain("/telegram:access pair abc-123");
  });
  it("unpaired prompts the user to DM", () => {
    expect(statusUnpairedText()).toMatch(/Send me a message/);
  });
  it("passes < > literally (markdown, #2669) in the pending code value", () => {
    expect(statusPendingText("<x>")).toContain("<x>");
  });
});

describe("switchroomHelpText + switchroomHelpCommandNames", () => {
  it("agent name appears in header", () => {
    expect(switchroomHelpText("klanker")).toContain("**klanker**");
  });
  it("every command in the autocomplete array is documented here", () => {
    const out = switchroomHelpText("assistant");
    for (const cmd of switchroomHelpCommandNames) {
      expect(out, `missing /${cmd} in switchroomHelpText`).toContain(`/${cmd}`);
    }
  });
  it("groups commands into sections", () => {
    const out = switchroomHelpText("assistant");
    expect(out).toContain("**Session & approvals**");
    expect(out).toContain("**Agents**");
    expect(out).toContain("**Auth & config**");
  });
  it("the name array contains the Sprint 2/3 additions", () => {
    for (const needed of ["new", "compact", "clear", "approve", "deny", "pending"]) {
      expect(switchroomHelpCommandNames).toContain(needed);
    }
    // /reset was removed (it was a pure alias of /new).
    expect(switchroomHelpCommandNames).not.toContain("reset");
  });
});

describe("TELEGRAM_MENU_COMMANDS (slash-menu shape)", () => {
  it("base commands are exactly /start /help /status in that order", () => {
    expect(TELEGRAM_BASE_COMMANDS.map(c => c.command)).toEqual(["start", "help", "status"]);
  });

  it("menu + base split is non-overlapping and recomposes to the full list", () => {
    // Invariant: TELEGRAM_MENU_COMMANDS is base followed by switchroom; no dupes.
    expect([...TELEGRAM_BASE_COMMANDS, ...TELEGRAM_SWITCHROOM_COMMANDS]).toEqual(
      [...TELEGRAM_MENU_COMMANDS],
    );
    const names = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it("menu includes the session-control commands (the most-used trio)", () => {
    const names = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    // These MUST be in the menu — they're the primary mobile UX flows
    for (const must of ["new", "compact", "clear", "approve", "deny", "pending", "restart", "logs", "commands"]) {
      expect(names, `missing /${must} from Telegram menu`).toContain(must);
    }
    // /reset removed (alias of /new).
    expect(names, "/reset should be gone from the menu").not.toContain("reset");
  });

  it("menu drops the ops primitives that cluttered the old catalogue", () => {
    const names = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    // These used to be in the menu and are now handler-only (still
    // typable, but not in autocomplete). If they sneak back in, the
    // menu has regressed to pre-trim length.
    // Note: /vault was re-added to the menu in PR #254 — users couldn't
    // discover the vault subcommands without typing the verb manually.
    for (const droppedFromMenu of ["grant", "dangerous", "permissions", "agentstart", "topics", "memory", "pins-status", "interrupt"]) {
      expect(names, `/${droppedFromMenu} should NOT be in the trimmed Telegram menu`).not.toContain(droppedFromMenu);
    }
  });

  it("does NOT register /authfallback (removed in v0.6.12)", () => {
    // The /authfallback typed command duplicated the work of the
    // dashboard's Switch primary picker (operator-facing surface) and
    // the auto-fallback poller (transparent on-quota-wall case). It
    // was removed from the slash-menu, the autocomplete helper-list,
    // AND the help text. If any of those re-surface the command, this
    // test catches the regression.
    const menuNames = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    expect(menuNames, "/authfallback must not be in the slash menu").not.toContain(
      "authfallback",
    );
    expect(
      switchroomHelpCommandNames as readonly string[],
      "/authfallback must not be in the autocomplete name list",
    ).not.toContain("authfallback");
    const helpDoc = switchroomHelpText("clerk");
    expect(helpDoc, "/authfallback must not appear in help text").not.toContain(
      "/authfallback",
    );
  });

  it("does NOT register /reauth (removed in v0.6.13)", () => {
    // /reauth was a typed entry point for the same flow the `/auth`
    // dashboard's `🔄 Reauth` button fires. Two paths to the same
    // outcome confused operators; the dashboard button is the right
    // surface (one-tap from the same place quota / promote / add
    // live). OAuth code paste-back still works without a typed
    // command — the generic message intercept watches
    // `pendingReauthFlows` and exchanges any code-shaped paste
    // automatically.
    const menuNames = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    expect(menuNames, "/reauth must not be in the slash menu").not.toContain(
      "reauth",
    );
    expect(
      switchroomHelpCommandNames as readonly string[],
      "/reauth must not be in the autocomplete name list",
    ).not.toContain("reauth");
    const helpDoc = switchroomHelpText("clerk");
    // The /auth description string still mentions "reauth" as a
    // dashboard verb — that's intentional, not a registered command.
    // Pin that there's no top-level `/reauth ...` entry.
    expect(
      helpDoc,
      "/reauth must not appear as a top-level command in help text",
    ).not.toMatch(/`\/reauth\b/);
  });

  it("menu is short enough for a mobile keyboard (<= 23 entries)", () => {
    // Hard cap: Telegram autocomplete on mobile shows ~8-10 commands
    // without scrolling. 23 is a generous upper bound (well under
    // Telegram's own 100-command limit). /whoami brought it to 21;
    // /private + /public (autocomplete for the shipped handlers) → 23.
    expect(TELEGRAM_MENU_COMMANDS.length).toBeLessThanOrEqual(23);
  });

  it("menu includes /whoami (sandbox introspection)", () => {
    const names = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    expect(names, "missing /whoami from Telegram menu").toContain("whoami");
  });

  it("every menu command is documented in switchroomHelpText", () => {
    const helpDoc = switchroomHelpText("assistant");
    for (const { command } of TELEGRAM_SWITCHROOM_COMMANDS) {
      // Special case: /commands describes itself; the check still passes
      // because the list item literally reads '/commands — this help'.
      expect(helpDoc, `menu command /${command} missing from /commands text`).toContain(`/${command}`);
    }
  });
});

describe("restart / new ack text", () => {
  it("restartAckText is consistent", () => {
    expect(restartAckText("assistant")).toBe("🔄 Restarting **assistant**…");
  });
  it("newSessionAckText with flush", () => {
    expect(newSessionAckText("assistant", true))
      .toBe("🆕 Started fresh session for **assistant** · flushed handoff · restarting…");
  });
  it("newSessionAckText without flush", () => {
    expect(newSessionAckText("assistant", false))
      .toBe("🆕 Started fresh session for **assistant** · restarting…");
  });
  it("passes < > literally (markdown, #2669) in agent name in both", () => {
    expect(restartAckText("<x>")).toContain("<x>");
    expect(newSessionAckText("<x>", true)).toContain("<x>");
  });
});
