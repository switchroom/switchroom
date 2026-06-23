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

describe("escapeHtml", () => {
  it("escapes &, <, >, \"", () => {
    expect(escapeHtml('<foo bar="baz">&')).toBe("&lt;foo bar=&quot;baz&quot;&gt;&amp;");
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
  it("HTML-escapes subscription type", () => {
    expect(formatAuthLine({ authenticated: true, subscription_type: "<injected>", expires_in: null, auth_source: "oauth" }))
      .toContain("&lt;injected&gt;");
  });
});

describe("formatAgentLine", () => {
  it("includes model inline", () => {
    expect(formatAgentLine(baseMeta)).toContain("<code>sonnet</code>");
  });
  it("falls back to 'default' when model is null/empty", () => {
    expect(formatAgentLine({ ...baseMeta, model: null })).toContain("<code>default</code>");
    expect(formatAgentLine({ ...baseMeta, model: "" })).toContain("<code>default</code>");
  });
  it("appends topic when present", () => {
    const out = formatAgentLine({ ...baseMeta, topicName: "Planning", topicEmoji: "🗓" });
    expect(out).toContain("topic: 🗓 Planning");
  });
  it("shows the live session model alongside the configured model when a /model switch is active", () => {
    const out = formatAgentLine({ ...baseMeta, model: "claude-fable-5[1m]", sessionModel: "Opus 4.8 (1M context)" });
    // Both surfaces present + agree: configured AND what's actually running.
    expect(out).toContain("<code>claude-fable-5[1m]</code>");
    expect(out).toContain("live session: <code>Opus 4.8 (1M context)</code>");
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
  it("HTML-escapes agent name", () => {
    expect(formatAgentLine({ ...baseMeta, agentName: "<script>" }))
      .toContain("&lt;script&gt;");
  });
});

describe("startText", () => {
  it("dmDisabled path", () => {
    expect(startText("assistant", true)).toBe("This bot isn't accepting new connections.");
  });
  it("names the agent, not 'Claude Code session'", () => {
    const out = startText("assistant", false);
    expect(out).toContain("<b>assistant</b>");
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
  it("HTML-escapes agent name", () => {
    expect(startText("<x>", false)).toContain("&lt;x&gt;");
  });
});

describe("helpText", () => {
  it("names the agent", () => {
    expect(helpText("klanker")).toContain("<b>klanker</b>");
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
    expect(out).toContain("<code>sonnet</code>");
  });
  it("omits status/uptime when absent", () => {
    expect(statusPairedText({ user: "@ken", meta })).not.toContain("Status:");
  });
  it("includes status/uptime when present", () => {
    const withStatus: AgentMetadata = { ...meta, status: "running", uptime: "3h 12m" };
    const out = statusPairedText({ user: "@ken", meta: withStatus });
    expect(out).toContain("Status: <code>running</code> · up 3h 12m");
  });

  // demo mode (the `/status demo` suffix) — masks the paired-user tag only.
  describe("demo mode", () => {
    it("WITHOUT demo, the real handle still renders", () => {
      expect(statusPairedText({ user: "@ken_real", meta })).toContain("Paired as @ken_real.");
    });
    it("WITH demo, the handle is masked to a @demo_user form", () => {
      const out = statusPairedText({ user: "@ken_real", meta, demo: true });
      expect(out).not.toContain("@ken_real");
      expect(out).toMatch(/Paired as @demo_user\d*\./);
    });
    it("WITH demo, a numeric sender id is masked to a @handle, not a raw number", () => {
      const out = statusPairedText({ user: "12345", meta, demo: true });
      expect(out).not.toContain("12345");
      expect(out).toMatch(/Paired as @demo_user\d*\./);
    });
    it("WITH demo, the agent/model/auth topology is NOT masked", () => {
      const out = statusPairedText({ user: "@ken_real", meta, demo: true });
      // Out-of-scope fields stay real.
      expect(out).toContain("Auth: ✓ Max · expires 29 days");
      expect(out).toContain("<code>sonnet</code>");
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
      expect(out).toContain("<b>Version</b> v0.3.0+44 · 2h ago");
      expect(out).toContain("<b>Profile</b> klanker");
      expect(out).toContain("<b>Tools</b> Read, Write, Bash, Edit, Grep +12 more");
      expect(out).toContain("<b>Deny</b> WebFetch");
      expect(out).toContain("<b>Skills</b> git, telegram, vault, +3 more");
      expect(out).toContain("<b>Limits</b> idle 30m, 50 turns");
      expect(out).toContain("<b>Channel</b> switchroom (default)");
      expect(out).toContain("<b>Memory</b> assistant");
    });

    it("omits Deny row when toolsDeny is null", () => {
      const partial: AgentMetadata = { ...meta, audit: { ...audit, toolsDeny: null } };
      const out = statusPairedText({ user: "@ken", meta: partial });
      expect(out).not.toContain("Deny");
      expect(out).toContain("<b>Tools</b>");
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

    it("escapes HTML in audit values", () => {
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
      expect(out).not.toContain("<script>alert");
      expect(out).toContain("&lt;script&gt;");
      expect(out).toContain("Read &amp; &lt;Write&gt;");
      expect(out).toContain("bank&lt;&gt;name");
    });

    it("handles empty extendsProfile (no Profile row when meta.extendsProfile is null)", () => {
      const withAudit: AgentMetadata = { ...meta, extendsProfile: null, audit };
      const out = statusPairedText({ user: "@ken", meta: withAudit });
      expect(out).not.toContain("<b>Profile</b>");
      // But other audit rows still render.
      expect(out).toContain("<b>Version</b>");
    });
  });

  // Live probe block — `/status` shows EVERY probe (green and otherwise).
  // This is the deliberate opposite of the boot card's silent-when-healthy
  // contract: boot card = quiet ack, /status = dashboard.
  describe("live health block", () => {
    it("does NOT render a Health section when meta.live is undefined", () => {
      const out = statusPairedText({ user: "@ken", meta });
      expect(out).not.toContain("<b>Health</b>");
    });

    it("does NOT render a Health section when meta.live is empty array", () => {
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live: [] } });
      expect(out).not.toContain("<b>Health</b>");
    });

    it("renders all probe rows including green ones", () => {
      const live: AgentMetadata["live"] = [
        { status: "ok",       label: "Account",   detail: "ken@x.com · Max · token 60d" },
        { status: "ok",       label: "Broker",    detail: "reachable" },
        { status: "degraded", label: "Skills",    detail: "1/5 dangling: foo" },
        { status: "fail",     label: "Scheduler", detail: "sidecar not running" },
      ];
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live } });
      expect(out).toContain("<b>Health</b>");
      expect(out).toContain("🟢 <b>Account</b>  ken@x.com · Max · token 60d");
      expect(out).toContain("🟢 <b>Broker</b>  reachable");
      expect(out).toContain("🟡 <b>Skills</b>  1/5 dangling: foo");
      expect(out).toContain("🔴 <b>Scheduler</b>  sidecar not running");
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
      const healthIdx = out.indexOf("<b>Health</b>");
      const versionIdx = out.indexOf("<b>Version</b>");
      expect(healthIdx).toBeGreaterThan(-1);
      expect(versionIdx).toBeGreaterThan(healthIdx);
    });

    it("escapes HTML in probe detail strings", () => {
      const live: AgentMetadata["live"] = [
        { status: "fail", label: "Skills", detail: "<script>alert(1)</script>" },
      ];
      const out = statusPairedText({ user: "@ken", meta: { ...meta, live } });
      expect(out).not.toContain("<script>alert");
      expect(out).toContain("&lt;script&gt;");
    });
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
  it("pending escapes HTML in the code value", () => {
    expect(statusPendingText("<x>")).toContain("&lt;x&gt;");
  });
});

describe("switchroomHelpText + switchroomHelpCommandNames", () => {
  it("agent name appears in header", () => {
    expect(switchroomHelpText("klanker")).toContain("<b>klanker</b>");
  });
  it("every command in the autocomplete array is documented here", () => {
    const out = switchroomHelpText("assistant");
    for (const cmd of switchroomHelpCommandNames) {
      expect(out, `missing /${cmd} in switchroomHelpText`).toContain(`/${cmd}`);
    }
  });
  it("groups commands into sections", () => {
    const out = switchroomHelpText("assistant");
    expect(out).toContain("<b>Session &amp; approvals</b>");
    expect(out).toContain("<b>Agents</b>");
    expect(out).toContain("<b>Auth &amp; config</b>");
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
    // Pin that there's no top-level <code>/reauth ...</code> entry.
    expect(
      helpDoc,
      "/reauth must not appear as a top-level command in help text",
    ).not.toMatch(/<code>\/reauth\b/);
  });

  it("menu is short enough for a mobile keyboard (<= 21 entries)", () => {
    // Hard cap: Telegram autocomplete on mobile shows ~8-10 commands
    // without scrolling. 21 is a generous upper bound (well under
    // Telegram's own 100-command limit). /whoami brought it to 21.
    expect(TELEGRAM_MENU_COMMANDS.length).toBeLessThanOrEqual(21);
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
    expect(restartAckText("assistant")).toBe("🔄 Restarting <b>assistant</b>…");
  });
  it("newSessionAckText with flush", () => {
    expect(newSessionAckText("assistant", true))
      .toBe("🆕 Started fresh session for <b>assistant</b> · flushed handoff · restarting…");
  });
  it("newSessionAckText without flush", () => {
    expect(newSessionAckText("assistant", false))
      .toBe("🆕 Started fresh session for <b>assistant</b> · restarting…");
  });
  it("HTML-escapes agent name in both", () => {
    expect(restartAckText("<x>")).toContain("&lt;x&gt;");
    expect(newSessionAckText("<x>", true)).toContain("&lt;x&gt;");
  });
});
