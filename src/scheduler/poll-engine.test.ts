import { describe, expect, it } from "vitest";
import { cursorOf, extractLeaves, runHttpDiffPoll, type HttpDiffDeps, type HttpDiffSpec } from "./poll-engine.js";
import { createMemoryPollStateStore } from "./poll-state.js";
import type { EgressAllowlist } from "./poll-egress.js";

const ALLOW: EgressAllowlist = {
  hosts: ["api.brevo.com"],
  secretBindings: { brevo_api_key: "api.brevo.com" },
};

const SPEC: HttpDiffSpec = {
  type: "http-diff",
  url: "https://api.brevo.com/v3/contacts/lists/20/contacts",
  method: "GET",
  headers: { "api-key": "{{brevo_api_key}}" },
  secrets: ["brevo_api_key"],
  diff_jsonpath: "$.contacts[*].id",
  state_key: "last_max_contact_id",
};

function depsWith(body: unknown, over: Partial<HttpDiffDeps> = {}): HttpDiffDeps {
  return {
    fetchImpl: (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
    resolveSecret: async (n) => (n === "brevo_api_key" ? "secret-value" : ""),
    lookup: async () => "8.8.8.8",
    allow: ALLOW,
    now: () => 1_000,
    ...over,
  };
}

describe("extractLeaves / cursorOf", () => {
  it("walks $.a[*].b and reduces to numeric max", () => {
    const leaves = extractLeaves({ contacts: [{ id: 5 }, { id: 9 }, { id: 7 }] }, "$.contacts[*].id");
    expect(leaves).toEqual([5, 9, 7]);
    expect(cursorOf(leaves)).toMatchObject({ cursor: "9", numeric: true, count: 3 });
  });
  it("non-numeric leaves → count cursor", () => {
    expect(cursorOf(["a", "b"])).toMatchObject({ cursor: "n:2", numeric: false });
  });
});

describe("runHttpDiffPoll", () => {
  it("first run → baseline, NEVER escalates (the day-one floods guard)", async () => {
    const r = await runHttpDiffPoll(SPEC, undefined, depsWith({ contacts: [{ id: 1 }, { id: 2 }] }));
    expect(r).toMatchObject({ hit: false, baseline: true, cursor: "2" });
  });

  it("unchanged cursor → no-op (HEARTBEAT_OK)", async () => {
    const r = await runHttpDiffPoll(SPEC, "2", depsWith({ contacts: [{ id: 1 }, { id: 2 }] }));
    expect(r).toMatchObject({ hit: false, baseline: false, cursor: "2" });
  });

  it("advanced cursor → hit with a diff", async () => {
    const r = await runHttpDiffPoll(SPEC, "2", depsWith({ contacts: [{ id: 2 }, { id: 5 }] }));
    expect(r.hit).toBe(true);
    expect(r.cursor).toBe("5");
    expect(r.diff).toContain("5");
  });

  it("blocks egress: a Brevo poll whose secret is sent to the wrong host", async () => {
    const bad = { ...SPEC, url: "https://api.brevo.com/x", secrets: ["unbound_key"] };
    const r = await runHttpDiffPoll(bad, "2", depsWith({ contacts: [] }));
    expect(r.error).toMatch(/egress denied/);
    expect(r.hit).toBe(false);
  });

  it("blocks a DNS-rebind to a private IP", async () => {
    const r = await runHttpDiffPoll(SPEC, "2", depsWith({ contacts: [{ id: 9 }] }, { lookup: async () => "127.0.0.1" }));
    expect(r.error).toMatch(/blocked/);
  });

  it("non-2xx → error, no escalation", async () => {
    const r = await runHttpDiffPoll(
      SPEC,
      "2",
      depsWith({}, { fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch }),
    );
    expect(r.error).toMatch(/http 503/);
    expect(r.hit).toBe(false);
  });

  it("injects the resolved secret into the header via {{name}}", async () => {
    let seenHeaders: Record<string, string> = {};
    const deps = depsWith(
      { contacts: [{ id: 9 }] },
      {
        fetchImpl: (async (_url: string, init: RequestInit) => {
          seenHeaders = init.headers as Record<string, string>;
          return new Response(JSON.stringify({ contacts: [{ id: 9 }] }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    await runHttpDiffPoll(SPEC, "2", deps);
    expect(seenHeaders["api-key"]).toBe("secret-value");
  });
});

describe("write-ahead idempotency (the double-escalation race)", () => {
  it("a restart mid-escalation does not re-escalate (cursor already advanced)", async () => {
    const store = createMemoryPollStateStore({ last_max_contact_id: { value: "2" } });
    // Poll sees a hit at cursor 5 → write-ahead advances cursor BEFORE dispatch.
    const r1 = await runHttpDiffPoll(SPEC, store.get("last_max_contact_id")!.value, depsWith({ contacts: [{ id: 5 }] }));
    expect(r1.hit).toBe(true);
    store.writeAhead("last_max_contact_id", r1.cursor!, 1000, r1.diff!);
    // --- simulated crash before dispatch-ack, then restart re-polls ---
    const r2 = await runHttpDiffPoll(SPEC, store.get("last_max_contact_id")!.value, depsWith({ contacts: [{ id: 5 }] }));
    expect(r2.hit).toBe(false); // cursor is now 5; the same data is not new again
  });
});
