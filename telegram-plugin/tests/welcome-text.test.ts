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
  resetSessionAckText,
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
  it("points at /status and /switchroomhelp", () => {
    const out = startText("assistant", false);
    expect(out).toContain("/status");
    expect(out).toContain("/switchroomhelp");
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
    expect(out).toContain("/reset");
  });
  it("points at the richer /switchroomhelp", () => {
    expect(helpText("assistant")).toContain("/switchroomhelp");
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
    for (const needed of ["new", "reset", "approve", "deny", "pending"]) {
      expect(switchroomHelpCommandNames).toContain(needed);
    }
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
    for (const must of ["new", "reset", "approve", "deny", "pending", "restart", "logs", "switchroomhelp"]) {
      expect(names, `missing /${must} from Telegram menu`).toContain(must);
    }
  });

  it("menu drops the ops primitives that cluttered the old catalogue", () => {
    const names = TELEGRAM_MENU_COMMANDS.map(c => c.command);
    // These used to be in the menu and are now handler-only (still
    // typable, but not in autocomplete). If they sneak back in, the
    // menu has regressed to pre-trim length.
    // Note: /vault was re-added to the menu in PR #254 — users couldn't
    // discover the vault subcommands without typing the verb manually.
    for (const droppedFromMenu of ["grant", "dangerous", "permissions", "switchroomstart", "topics", "memory", "pins-status", "interrupt"]) {
      expect(names, `/${droppedFromMenu} should NOT be in the trimmed Telegram menu`).not.toContain(droppedFromMenu);
    }
  });

  it("menu is short enough for a mobile keyboard (<= 20 entries)", () => {
    // Hard cap: Telegram autocomplete on mobile shows ~8-10 commands
    // without scrolling. 20 is a generous upper bound.
    expect(TELEGRAM_MENU_COMMANDS.length).toBeLessThanOrEqual(20);
  });

  it("every menu command is documented in switchroomHelpText", () => {
    const helpDoc = switchroomHelpText("assistant");
    for (const { command } of TELEGRAM_SWITCHROOM_COMMANDS) {
      // Special case: /switchroomhelp describes itself; the check still passes
      // because the list item literally reads '/switchroomhelp — this help'.
      expect(helpDoc, `menu command /${command} missing from /switchroomhelp text`).toContain(`/${command}`);
    }
  });
});

describe("restart / new / reset ack text", () => {
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
  it("resetSessionAckText with flush", () => {
    expect(resetSessionAckText("assistant", true))
      .toBe("🔄 Reset session for <b>assistant</b> · flushed handoff · restarting…");
  });
  it("HTML-escapes agent name in all three", () => {
    expect(restartAckText("<x>")).toContain("&lt;x&gt;");
    expect(newSessionAckText("<x>", true)).toContain("&lt;x&gt;");
    expect(resetSessionAckText("<x>", true)).toContain("&lt;x&gt;");
  });
});
