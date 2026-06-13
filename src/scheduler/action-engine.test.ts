import { describe, expect, it } from "vitest";
import {
  runAction,
  substituteDeterministic,
  type ActionDeps,
} from "./action-engine.js";
import type { ActionSpec } from "../config/schema.js";
import type { EgressAllowlist } from "./poll-egress.js";

const ALLOW: EgressAllowlist = {
  hosts: ["hooks.example.com"],
  secretBindings: { hook_token: "hooks.example.com" },
};

/** A capturing fake for the model-free send seam + a default-OK webhook fetch. */
function depsWith(over: Partial<ActionDeps> = {}): {
  deps: ActionDeps;
  sent: Array<{ text: string; parseMode: string }>;
  fetched: Array<{ url: string; init?: RequestInit }>;
} {
  const sent: Array<{ text: string; parseMode: string }> = [];
  const fetched: Array<{ url: string; init?: RequestInit }> = [];
  const deps: ActionDeps = {
    fetchImpl: (async (url: string, init?: RequestInit) => {
      fetched.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
    resolveSecret: async (n) => (n === "hook_token" ? "tok-123" : ""),
    lookup: async () => "8.8.8.8",
    allow: ALLOW,
    now: () => Date.UTC(2026, 5, 13, 9, 5), // 2026-06-13T09:05Z
    agent: "clerk",
    sendMessage: async (text, opts) => {
      sent.push({ text, parseMode: opts.parseMode });
      return true;
    },
    ...over,
  };
  return { deps, sent, fetched };
}

describe("substituteDeterministic", () => {
  it("fills {{date}}/{{time}}/{{agent}} from the fire clock — and nothing else", () => {
    const out = substituteDeterministic("{{agent}} @ {{date}} {{time}} — {{secret:X}}", {
      now: Date.UTC(2026, 5, 13, 9, 5),
      agent: "clerk",
    });
    // date/time/agent substituted; an unknown placeholder ({{secret:X}}) is left verbatim
    // (NO secret substitution in a message — that's the webhook's job).
    expect(out).toBe("clerk @ 2026-06-13 09:05 — {{secret:X}}");
  });
});

describe("runAction — telegram-message", () => {
  const spec: ActionSpec = { type: "telegram-message", text: "Daily heartbeat {{date}}", parse_mode: "html" };

  it("sends the substituted text to the agent's own chat (model-free)", async () => {
    const { deps, sent } = depsWith();
    const r = await runAction(spec, deps);
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("Daily heartbeat 2026-06-13");
    expect(sent[0].parseMode).toBe("html");
  });

  it("reports not-delivered as an error (no throw)", async () => {
    const { deps } = depsWith({ sendMessage: async () => false });
    const r = await runAction(spec, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not delivered/);
  });

  it("never reaches the network for a message action", async () => {
    const { deps, fetched } = depsWith();
    await runAction(spec, deps);
    expect(fetched).toHaveLength(0);
  });
});

describe("runAction — webhook", () => {
  const spec: ActionSpec = {
    type: "webhook",
    url: "https://hooks.example.com/ping",
    method: "POST",
    headers: { authorization: "Bearer {{hook_token}}" },
    body: "token={{hook_token}}",
    secrets: ["hook_token"],
  };

  it("fires the request with substituted secrets on the happy path", async () => {
    const { deps, fetched } = depsWith();
    const r = await runAction(spec, deps);
    expect(r.ok).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe("https://hooks.example.com/ping");
    expect((fetched[0].init!.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(fetched[0].init!.body).toBe("token=tok-123");
    expect(fetched[0].init!.redirect).toBe("error");
  });

  it("blocks egress to a non-allowlisted host", async () => {
    const r = await runAction({ ...spec, url: "https://evil.example.net/x", secrets: [] }, depsWith().deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/egress denied/);
  });

  it("blocks a secret bound to a different host (no exfil)", async () => {
    const { deps } = depsWith();
    const r = await runAction({ ...spec, url: "https://hooks.example.com/ping", secrets: ["unbound"] }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/egress denied/);
  });

  it("blocks a DNS-rebind to a private IP", async () => {
    const { deps } = depsWith({ lookup: async () => "127.0.0.1" });
    const r = await runAction(spec, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked/);
  });

  it("surfaces a non-2xx status as an error", async () => {
    const { deps } = depsWith({
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    const r = await runAction(spec, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http 500/);
  });

  it("never sends a Telegram message for a webhook action", async () => {
    const { deps, sent } = depsWith();
    await runAction(spec, deps);
    expect(sent).toHaveLength(0);
  });
});
