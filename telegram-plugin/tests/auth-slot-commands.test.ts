import { describe, it, expect } from "vitest";
import {
  assertSafeSlotName,
  parseAuthSubCommand,
  checkRemoveSafety,
  formatSlotList,
  splitFlags,
  usageText,
  AUTH_VERBS,
  type SlotListingFromCli,
  type AuthIntent,
} from "../auth-slot-parser";

describe("assertSafeSlotName", () => {
  it("accepts valid slot names", () => {
    for (const name of ["default", "personal-1", "work_acct", "a", "A".repeat(32)]) {
      expect(() => assertSafeSlotName(name)).not.toThrow();
    }
  });
  it("rejects empty string", () => {
    expect(() => assertSafeSlotName("")).toThrow(/invalid slot name/);
  });
  it("rejects names > 32 chars", () => {
    expect(() => assertSafeSlotName("a".repeat(33))).toThrow(/invalid slot name/);
  });
  it("rejects shell metacharacters and spaces", () => {
    for (const bad of ["foo bar", "foo;ls", "foo/bar", "foo.bar", "foo$var", "foo|bar"]) {
      expect(() => assertSafeSlotName(bad)).toThrow(/invalid slot name/);
    }
  });
});

describe("parseAuthSubCommand — existing verbs pass-through", () => {
  it("defaults to status with no args", () => {
    const intent = parseAuthSubCommand([], "clerk");
    expect(intent.kind).toBe("status");
    if (intent.kind === "status") expect(intent.cliArgs).toEqual(["auth", "status"]);
  });

  it("login with no agent defaults to currentAgent", () => {
    const intent = parseAuthSubCommand(["login"], "clerk");
    expect(intent.kind).toBe("login");
    if (intent.kind === "login") {
      expect(intent.agent).toBe("clerk");
      expect(intent.cliArgs).toEqual(["auth", "login", "clerk"]);
      expect(intent.registerReauth).toBe(true);
    }
  });

  it("login with explicit agent", () => {
    const intent = parseAuthSubCommand(["login", "klanker"], "clerk");
    expect(intent.kind).toBe("login");
    if (intent.kind === "login") expect(intent.agent).toBe("klanker");
  });

  it("code requires a browser code", () => {
    const intent = parseAuthSubCommand(["code"], "clerk");
    expect(intent.kind).toBe("usage");
  });

  it("code treats 2 args as agent-is-current + code", () => {
    const intent = parseAuthSubCommand(["code", "ABC123"], "clerk");
    expect(intent.kind).toBe("code");
    if (intent.kind === "code") {
      expect(intent.agent).toBe("clerk");
      expect(intent.code).toBe("ABC123");
    }
  });

  it("code treats 3 args as agent + code", () => {
    const intent = parseAuthSubCommand(["code", "klanker", "ABC123"], "clerk");
    expect(intent.kind).toBe("code");
    if (intent.kind === "code") {
      expect(intent.agent).toBe("klanker");
      expect(intent.code).toBe("ABC123");
    }
  });
});

describe("parseAuthSubCommand — /auth add", () => {
  it("defaults agent to currentAgent", () => {
    const intent = parseAuthSubCommand(["add"], "clerk");
    expect(intent.kind).toBe("add");
    if (intent.kind === "add") {
      expect(intent.agent).toBe("clerk");
      expect(intent.slot).toBeUndefined();
      expect(intent.cliArgs).toEqual(["auth", "add", "clerk"]);
    }
  });

  it("takes explicit agent", () => {
    const intent = parseAuthSubCommand(["add", "klanker"], "clerk");
    expect(intent.kind).toBe("add");
    if (intent.kind === "add") {
      expect(intent.agent).toBe("klanker");
      expect(intent.cliArgs).toEqual(["auth", "add", "klanker"]);
    }
  });

  it("accepts --slot value", () => {
    const intent = parseAuthSubCommand(["add", "clerk", "--slot", "personal"], "clerk");
    expect(intent.kind).toBe("add");
    if (intent.kind === "add") {
      expect(intent.slot).toBe("personal");
      expect(intent.cliArgs).toEqual(["auth", "add", "clerk", "--slot", "personal"]);
    }
  });

  it("rejects invalid slot name", () => {
    const intent = parseAuthSubCommand(["add", "clerk", "--slot", "bad name"], "clerk");
    expect(intent.kind).toBe("error");
    if (intent.kind === "error") expect(intent.message).toMatch(/slot name/i);
  });
});

describe("parseAuthSubCommand — /auth use", () => {
  it("requires a slot arg", () => {
    const intent = parseAuthSubCommand(["use"], "clerk");
    expect(intent.kind).toBe("usage");
  });

  it("1 positional arg = slot (agent defaults)", () => {
    const intent = parseAuthSubCommand(["use", "personal"], "clerk");
    expect(intent.kind).toBe("use");
    if (intent.kind === "use") {
      expect(intent.agent).toBe("clerk");
      expect(intent.slot).toBe("personal");
      expect(intent.force).toBe(false);
      expect(intent.cliArgs).toEqual(["auth", "use", "clerk", "personal"]);
      expect(intent.restartAgentAfter).toBe(true);
    }
  });

  it("2 positional args = agent + slot", () => {
    const intent = parseAuthSubCommand(["use", "klanker", "personal"], "clerk");
    expect(intent.kind).toBe("use");
    if (intent.kind === "use") {
      expect(intent.agent).toBe("klanker");
      expect(intent.slot).toBe("personal");
      expect(intent.force).toBe(false);
    }
  });

  it("--force sets force=true (#421)", () => {
    const intent = parseAuthSubCommand(["use", "personal", "--force"], "clerk");
    expect(intent.kind).toBe("use");
    if (intent.kind === "use") {
      expect(intent.slot).toBe("personal");
      expect(intent.force).toBe(true);
    }
  });

  it("--force with explicit agent + slot", () => {
    const intent = parseAuthSubCommand(["use", "klanker", "personal", "--force"], "clerk");
    expect(intent.kind).toBe("use");
    if (intent.kind === "use") {
      expect(intent.agent).toBe("klanker");
      expect(intent.slot).toBe("personal");
      expect(intent.force).toBe(true);
    }
  });

  it("rejects invalid slot name with clear error", () => {
    const intent = parseAuthSubCommand(["use", "bad slot"], "clerk");
    expect(intent.kind).toBe("error");
    if (intent.kind === "error") expect(intent.message).toMatch(/slot name/i);
  });

  it("rejects invalid agent name", () => {
    const intent = parseAuthSubCommand(["use", "bad;agent", "slot"], "clerk");
    expect(intent.kind).toBe("error");
    if (intent.kind === "error") expect(intent.message).toMatch(/agent name/i);
  });
});

describe("parseAuthSubCommand — /auth list", () => {
  it("defaults agent to currentAgent, requests JSON from CLI", () => {
    const intent = parseAuthSubCommand(["list"], "clerk");
    expect(intent.kind).toBe("list");
    if (intent.kind === "list") {
      expect(intent.agent).toBe("clerk");
      expect(intent.cliArgs).toEqual(["auth", "list", "clerk", "--json"]);
    }
  });

  it("takes explicit agent", () => {
    const intent = parseAuthSubCommand(["list", "klanker"], "clerk");
    expect(intent.kind).toBe("list");
    if (intent.kind === "list") expect(intent.agent).toBe("klanker");
  });
});

describe("parseAuthSubCommand — /auth rm", () => {
  it("requires a slot", () => {
    const intent = parseAuthSubCommand(["rm"], "clerk");
    expect(intent.kind).toBe("usage");
  });

  it("1 positional arg = slot, no --force", () => {
    const intent = parseAuthSubCommand(["rm", "personal"], "clerk");
    expect(intent.kind).toBe("rm");
    if (intent.kind === "rm") {
      expect(intent.agent).toBe("clerk");
      expect(intent.slot).toBe("personal");
      expect(intent.force).toBe(false);
      expect(intent.cliArgs).toEqual(["auth", "rm", "clerk", "personal"]);
    }
  });

  it("--force sets force=true", () => {
    const intent = parseAuthSubCommand(["rm", "personal", "--force"], "clerk");
    expect(intent.kind).toBe("rm");
    if (intent.kind === "rm") expect(intent.force).toBe(true);
  });

  it("2 positional args = agent + slot", () => {
    const intent = parseAuthSubCommand(["rm", "klanker", "personal"], "clerk");
    expect(intent.kind).toBe("rm");
    if (intent.kind === "rm") {
      expect(intent.agent).toBe("klanker");
      expect(intent.slot).toBe("personal");
    }
  });

  it("rejects invalid slot name", () => {
    const intent = parseAuthSubCommand(["rm", "bad slot"], "clerk");
    expect(intent.kind).toBe("error");
  });
});

describe("parseAuthSubCommand — unknown verb", () => {
  it("returns usage with full verb list", () => {
    const intent = parseAuthSubCommand(["foo"], "clerk");
    expect(intent.kind).toBe("usage");
    if (intent.kind === "usage") {
      // Primary verbs should appear in the usage text.
      // ("link" is an alias of "login" and not listed separately;
      // "status" is the bare /auth with no args.)
      const visibleVerbs = AUTH_VERBS.filter(v => v !== "link" && v !== "status");
      for (const v of visibleVerbs) {
        expect(intent.message).toContain(`/auth ${v}`);
      }
      // sanity: the 4 new verbs definitely appear
      expect(intent.message).toContain("/auth add");
      expect(intent.message).toContain("/auth use");
      expect(intent.message).toContain("/auth list");
      expect(intent.message).toContain("/auth rm");
    }
  });
});

describe("checkRemoveSafety", () => {
  const baseListing: SlotListingFromCli = {
    agent: "clerk",
    slots: [
      { slot: "default", active: true, health: "healthy", expires_at: null, quota_exhausted_until: null },
      { slot: "personal", active: false, health: "healthy", expires_at: null, quota_exhausted_until: null },
    ],
  };

  it("allows removing inactive slot without force", () => {
    expect(checkRemoveSafety(baseListing, "personal", false)).toBeNull();
  });

  it("blocks removing active slot without force", () => {
    const err = checkRemoveSafety(baseListing, "default", false);
    expect(err).toMatch(/active slot/i);
    expect(err).toMatch(/--force/);
  });

  it("blocks removing only slot without force", () => {
    const only: SlotListingFromCli = {
      agent: "clerk",
      slots: [{ slot: "default", active: true, health: "healthy", expires_at: null, quota_exhausted_until: null }],
    };
    const err = checkRemoveSafety(only, "default", false);
    expect(err).toMatch(/only account slot/i);
  });

  it("--force bypasses all safety checks", () => {
    expect(checkRemoveSafety(baseListing, "default", true)).toBeNull();
  });

  it("returns null for unknown slot (CLI will produce its own error)", () => {
    expect(checkRemoveSafety(baseListing, "ghost", false)).toBeNull();
  });
});

describe("formatSlotList", () => {
  const now = Date.now();

  it("shows active marker on active slot", () => {
    const out = formatSlotList({
      agent: "clerk",
      slots: [
        { slot: "default", active: true, health: "healthy", expires_at: null, quota_exhausted_until: null },
        { slot: "personal", active: false, health: "healthy", expires_at: null, quota_exhausted_until: null },
      ],
    });
    expect(out).toContain("<b>Slots for clerk</b>");
    expect(out).toContain("●"); // active marker
    expect(out).toContain("<code>default</code>");
    expect(out).toContain("<code>personal</code>");
  });

  it("shows 'no slots' message when empty", () => {
    const out = formatSlotList({ agent: "clerk", slots: [] });
    expect(out).toMatch(/no slots/i);
    expect(out).toContain("/auth add");
  });

  it("surfaces quota-exhausted with resets-in tail", () => {
    const until = now + 30 * 60_000;
    const out = formatSlotList({
      agent: "clerk",
      slots: [{ slot: "default", active: true, health: "quota-exhausted", expires_at: null, quota_exhausted_until: until }],
    });
    expect(out).toMatch(/resets in ~\d+m/);
    expect(out).toContain("⚠️");
  });

  it("surfaces expired with reauth hint", () => {
    const out = formatSlotList({
      agent: "clerk",
      slots: [{ slot: "default", active: true, health: "expired", expires_at: null, quota_exhausted_until: null }],
    });
    expect(out).toMatch(/\/auth reauth/);
    expect(out).toContain("⌛");
  });

  it("escapes HTML in agent name", () => {
    const out = formatSlotList({ agent: "<evil>", slots: [] });
    expect(out).toContain("&lt;evil&gt;");
    expect(out).not.toContain("<evil>");
  });
});

describe("splitFlags", () => {
  it("extracts value flag + leaves positional", () => {
    const { flags, positional } = splitFlags(["agent", "--slot", "personal"], ["--slot"]);
    expect(flags).toEqual({ "--slot": "personal" });
    expect(positional).toEqual(["agent"]);
  });

  it("treats value flag with no value as boolean", () => {
    const { flags, positional } = splitFlags(["--slot"], ["--slot"]);
    expect(flags["--slot"]).toBe(true);
    expect(positional).toEqual([]);
  });

  it("bare --flag becomes boolean", () => {
    const { flags, positional } = splitFlags(["slot", "--force"], []);
    expect(flags["--force"]).toBe(true);
    expect(positional).toEqual(["slot"]);
  });
});

describe("usageText", () => {
  it("lists all ten public sub-verbs", () => {
    const u = usageText();
    for (const v of ["login", "reauth", "code", "cancel", "add", "use", "list", "rm"]) {
      expect(u).toContain(`/auth ${v}`);
    }
  });
});
