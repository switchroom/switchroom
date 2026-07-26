import { describe, it, expect } from "vitest";
import {
  ensureTeam,
  ensureKey,
  validateKey,
  bindKeyToTeam,
  updateKeyModels,
  LiteLLMProvisionError,
  type FetchFn,
} from "./provision.js";

/** Build a minimal mock Response. */
function mockResponse(opts: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    async json() {
      if (opts.json === undefined) throw new Error("no json body");
      return opts.json;
    },
    async text() {
      return opts.text ?? "";
    },
  } as unknown as Response;
}

describe("ensureTeam", () => {
  it("POSTs team_alias to /team/new and RETURNS the team_id from the response", async () => {
    // /team/new's request body carries team_alias (that IS the NewTeamRequest
    // field), but its RESPONSE (a LiteLLM_TeamTable) carries the team_id — the
    // UUID that keys must be bound to. ensureTeam must surface that id so
    // ensureKey can pass it as team_id on /key/generate (the pre-fix code
    // returned void and threw the id away → keys landed unbound).
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return mockResponse({ ok: true, status: 200, json: { team_id: "t1" } });
    };
    const teamId = await ensureTeam("http://127.0.0.1:4010", "sk-master", "switchroom", fetchFn);
    expect(teamId).toEqual({ kind: "bound", teamId: "t1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4010/team/new");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ team_alias: "switchroom" });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-master");
  });

  it("resolves the team_id via /team/list when the team already exists", async () => {
    // On the idempotent already-exists path /team/new hands back an error, not
    // the team object — so ensureTeam must resolve the id by alias via
    // /team/list (each entry carries team_id + team_alias) so a re-apply still
    // binds keys to the existing team.
    const calls: { url: string; method: string }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET" });
      if (u.endsWith("/team/new")) {
        return mockResponse({
          ok: false,
          status: 400,
          text: "Team alias switchroom already exists in DB",
        });
      }
      if (u.endsWith("/team/list")) {
        return mockResponse({
          ok: true,
          status: 200,
          json: [
            { team_id: "other-id", team_alias: "other" },
            { team_id: "switchroom-uuid", team_alias: "switchroom" },
          ],
        });
      }
      return mockResponse({ ok: false, status: 404, text: "not found" });
    };
    const teamId = await ensureTeam("http://127.0.0.1:4010", "sk-master", "switchroom", fetchFn);
    expect(teamId).toEqual({ kind: "bound", teamId: "switchroom-uuid" });
    // It fell through to /team/list after the already-exists /team/new.
    expect(calls.map((c) => `${c.method} ${c.url.replace("http://127.0.0.1:4010", "")}`)).toEqual([
      "POST /team/new",
      "GET /team/list",
    ]);
  });

  it("returns unbound + a reason (non-fatal) when the already-exists team can't be resolved", async () => {
    // Best-effort: if /team/list is unavailable, degrade to `unbound` (carrying
    // WHY) rather than failing the whole apply — the caller then warns LOUDLY
    // and the key falls back to unbound instead of a silent green success.
    const fetchFn: FetchFn = async (url) =>
      String(url).endsWith("/team/new")
        ? mockResponse({ ok: false, status: 409, text: "conflict" })
        : mockResponse({ ok: false, status: 500, text: "list unavailable" });
    const result = await ensureTeam("http://h", "k", "switchroom", fetchFn);
    expect(result.kind).toBe("unbound");
    expect((result as { reason: string }).reason).toMatch(/could not be resolved/);
  });

  it("returns unbound with a reason when /team/new 200s but carries no team_id", async () => {
    // A fresh-create 200 whose body has no usable team_id must NOT masquerade as
    // a bound team — it degrades to `unbound` so the caller warns instead of
    // falsely claiming the key was team-bound.
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: true, status: 200, json: { not_a_team_id: true } });
    const result = await ensureTeam("http://h", "k", "switchroom", fetchFn);
    expect(result.kind).toBe("unbound");
    expect((result as { reason: string }).reason).toMatch(/no usable team_id/);
  });

  it("duplicate team_alias: picks the lexicographically smallest team_id + WARNS (deterministic)", async () => {
    // LiteLLM does NOT enforce a unique team_alias, so /team/list can carry
    // several teams sharing our alias. Returning the first (array-order) match
    // is nondeterministic — keys could bind to a different team run-to-run,
    // splitting cost tracking. ensureTeam must pick deterministically (lex-
    // smallest id) and warn naming every duplicate.
    const logs: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      const u = String(url);
      if (u.endsWith("/team/new")) {
        return mockResponse({ ok: false, status: 400, text: "Team alias switchroom already exists in DB" });
      }
      // Duplicates deliberately out of lexicographic order to prove the sort.
      return mockResponse({
        ok: true,
        status: 200,
        json: [
          { team_id: "zzz-team", team_alias: "switchroom" },
          { team_id: "aaa-team", team_alias: "switchroom" },
          { team_id: "mmm-team", team_alias: "other" },
        ],
      });
    };
    const result = await ensureTeam("http://h", "k", "switchroom", fetchFn, (m) => logs.push(m));
    // Deterministic: lexicographically smallest of {zzz-team, aaa-team}.
    expect(result).toEqual({ kind: "bound", teamId: "aaa-team" });
    // Loud + honest: the warning names BOTH duplicate ids.
    const warned = logs.join("\n");
    expect(warned).toMatch(/2 LiteLLM teams share team_alias 'switchroom'/);
    expect(warned).toMatch(/aaa-team/);
    expect(warned).toMatch(/zzz-team/);
  });

  it("strips a trailing slash from base_url", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(String(url));
      return mockResponse({ ok: true, status: 200, json: {} });
    };
    await ensureTeam("http://127.0.0.1:4010/", "k", "switchroom", fetchFn);
    expect(calls[0]).toBe("http://127.0.0.1:4010/team/new");
  });

  it("treats an 'already exists' error body as success (idempotent)", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({
        ok: false,
        status: 400,
        text: "Team alias switchroom already exists in DB",
      });
    // Idempotent already-exists, but no /team/list reachable here → `unbound`
    // (non-fatal), not a throw.
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).resolves.toMatchObject({ kind: "unbound" });
  });

  it("treats a 409 conflict as success (idempotent)", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 409, text: "conflict" });
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).resolves.toMatchObject({ kind: "unbound" });
  });

  it("throws LiteLLMProvisionError on a genuine non-existence error", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 401, text: "invalid master key" });
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).rejects.toBeInstanceOf(LiteLLMProvisionError);
  });

  it("wraps a network failure in LiteLLMProvisionError", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("ensureKey", () => {
  it("POSTs the key spec to /key/generate and binds it to the team via team_id", async () => {
    // Regression pin for the cost-tracking bug: the key MUST carry team_id (the
    // UUID from /team/new), NOT team_alias. LiteLLM's GenerateKeyRequest
    // (v1.91 litellm/proxy/_types.py: GenerateRequestBase) has a `team_id`
    // field and NO `team_alias` field, so a key generated with team_alias is
    // never attached to the team → per-team budget/spend tracking silently
    // doesn't apply. The prior test asserted team_alias: "switchroom", pinning
    // exactly that unbound-key bug.
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return mockResponse({ ok: true, status: 200, json: { key: "sk-virtual-abc" } });
    };
    const result = await ensureKey(
      {
        baseUrl: "http://127.0.0.1:4010",
        masterKey: "sk-master",
        alias: "agent:clerk",
        teamId: "switchroom-team-uuid",
        models: ["claude-haiku-4-5-20251001"],
        metadata: { agent: "clerk", env: "fleet" },
      },
      fetchFn,
    );
    expect(result).toEqual({ key: "sk-virtual-abc" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4010/key/generate");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      key_alias: "agent:clerk",
      models: ["claude-haiku-4-5-20251001"],
      team_id: "switchroom-team-uuid",
      metadata: { agent: "clerk", env: "fleet" },
    });
    // Explicitly assert the buggy field is gone.
    expect(body).not.toHaveProperty("team_alias");
  });

  it("omits models/team/metadata when not provided", async () => {
    let captured: Record<string, unknown> = {};
    const fetchFn: FetchFn = async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return mockResponse({ ok: true, status: 200, json: { key: "k" } });
    };
    await ensureKey(
      { baseUrl: "http://h", masterKey: "m", alias: "agent:bob" },
      fetchFn,
    );
    expect(captured).toEqual({ key_alias: "agent:bob" });
  });

  it("throws when the response omits a key field", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: true, status: 200, json: { not_a_key: true } });
    await expect(
      ensureKey({ baseUrl: "http://h", masterKey: "m", alias: "a" }, fetchFn),
    ).rejects.toThrow(/missing a "key" field/);
  });

  it("propagates a non-200 as LiteLLMProvisionError with status + body", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 403, text: "forbidden" });
    try {
      await ensureKey({ baseUrl: "http://h", masterKey: "m", alias: "a" }, fetchFn);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiteLLMProvisionError);
      expect((err as LiteLLMProvisionError).status).toBe(403);
      expect((err as LiteLLMProvisionError).body).toBe("forbidden");
    }
  });

  it("wraps a network failure in LiteLLMProvisionError", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("socket hang up");
    };
    await expect(
      ensureKey({ baseUrl: "http://h", masterKey: "m", alias: "a" }, fetchFn),
    ).rejects.toThrow(/socket hang up/);
  });
});

/**
 * Orphaned-alias self-heal: LiteLLM enforces unique key aliases (upstream
 * #9730). If a prior apply generated `agent:<name>` but crashed before the
 * vault write, the alias lives in LiteLLM with no recoverable key and every
 * later /key/generate hard-fails with 400 "already exists". ensureKey must
 * recover by deleting the orphan and regenerating.
 */
describe("ensureKey — orphaned-alias self-heal", () => {
  interface Call {
    method: string;
    url: string;
    body: Record<string, unknown> | null;
  }

  /** A URL/method router that also records every call for assertions. */
  function makeRouter(
    handlers: {
      generate: () => ReturnType<typeof mockResponse>;
      list?: () => ReturnType<typeof mockResponse>;
      delete?: () => ReturnType<typeof mockResponse>;
    },
    calls: Call[],
  ): FetchFn {
    return async (url, init) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url: u, body });
      if (u.includes("/key/generate")) return handlers.generate();
      if (u.includes("/key/list")) return (handlers.list ?? (() => mockResponse({ ok: true, status: 200, json: { keys: [] } })))();
      if (u.includes("/key/delete")) return (handlers.delete ?? (() => mockResponse({ ok: true, status: 200, json: {} })))();
      return mockResponse({ ok: false, status: 404, text: "not found" });
    };
  }

  it("clean generate: one POST, no delete round-trip", async () => {
    const calls: Call[] = [];
    const fetchFn = makeRouter(
      { generate: () => mockResponse({ ok: true, status: 200, json: { key: "sk-clean" } }) },
      calls,
    );
    const result = await ensureKey(
      { baseUrl: "http://h", masterKey: "m", alias: "agent:clerk", teamId: "t1" },
      fetchFn,
    );
    expect(result).toEqual({ key: "sk-clean" });
    // Exactly one call — no /key/list or /key/delete on the happy path.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/key/generate");
  });

  it("recovers a duplicate alias: delete the orphan (by token + alias), then regenerate", async () => {
    const calls: Call[] = [];
    let generateCount = 0;
    const logs: string[] = [];
    const fetchFn = makeRouter(
      {
        generate: () => {
          generateCount += 1;
          if (generateCount === 1) {
            return mockResponse({
              ok: false,
              status: 400,
              text: "Key with alias agent:clerk already exists in DB",
            });
          }
          return mockResponse({ ok: true, status: 200, json: { key: "sk-fresh" } });
        },
        list: () =>
          mockResponse({
            ok: true,
            status: 200,
            json: { keys: [{ token: "hashed-orphan-token", key_alias: "agent:clerk" }] },
          }),
        delete: () => mockResponse({ ok: true, status: 200, json: {} }),
      },
      calls,
    );

    const result = await ensureKey(
      { baseUrl: "http://h", masterKey: "m", alias: "agent:clerk", teamId: "t1", log: (m) => logs.push(m) },
      fetchFn,
    );

    expect(result).toEqual({ key: "sk-fresh" });
    // Call sequence: generate(400) → list → delete → generate(200).
    const seq = calls.map((c) => `${c.method} ${c.url.split("?")[0]!.replace("http://h", "")}`);
    expect(seq).toEqual([
      "POST /key/generate",
      "GET /key/list",
      "POST /key/delete",
      "POST /key/generate",
    ]);
    // The delete carries BOTH the resolved token and the alias (belt + braces).
    const del = calls.find((c) => c.url.includes("/key/delete"))!;
    expect(del.body).toEqual({
      key_aliases: ["agent:clerk"],
      keys: ["hashed-orphan-token"],
    });
    // It logged the self-heal.
    expect(logs.join("\n")).toMatch(/orphaned|self-healing|already exists/i);
  });

  it("recovers even when /key/list resolves no token (deletes by alias only)", async () => {
    const calls: Call[] = [];
    let generateCount = 0;
    const fetchFn = makeRouter(
      {
        generate: () => {
          generateCount += 1;
          return generateCount === 1
            ? mockResponse({ ok: false, status: 400, text: "key alias already exists" })
            : mockResponse({ ok: true, status: 200, json: { key: "sk-by-alias" } });
        },
        list: () => mockResponse({ ok: true, status: 200, json: { keys: [] } }),
        delete: () => mockResponse({ ok: true, status: 200, json: {} }),
      },
      calls,
    );
    const result = await ensureKey(
      { baseUrl: "http://h", masterKey: "m", alias: "agent:bob" },
      fetchFn,
    );
    expect(result).toEqual({ key: "sk-by-alias" });
    const del = calls.find((c) => c.url.includes("/key/delete"))!;
    // No `keys` field when the list resolved nothing — alias-only delete.
    expect(del.body).toEqual({ key_aliases: ["agent:bob"] });
  });

  it("delete FAILS: surfaces a clear error naming the manual remediation", async () => {
    const calls: Call[] = [];
    const fetchFn = makeRouter(
      {
        generate: () => mockResponse({ ok: false, status: 400, text: "alias already exists" }),
        list: () => mockResponse({ ok: true, status: 200, json: { keys: [] } }),
        delete: () => mockResponse({ ok: false, status: 500, text: "internal error" }),
      },
      calls,
    );
    try {
      await ensureKey({ baseUrl: "http://h", masterKey: "m", alias: "agent:zoe" }, fetchFn);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LiteLLMProvisionError);
      const msg = (err as LiteLLMProvisionError).message;
      expect(msg).toMatch(/key\/delete/);
      expect(msg).toMatch(/Manual remediation/);
      expect(msg).toMatch(/key_aliases.*agent:zoe/);
    }
    // We never got to the second generate.
    expect(calls.filter((c) => c.url.includes("/key/generate"))).toHaveLength(1);
  });

  it("second generate STILL duplicate after delete: distinct error naming remediation", async () => {
    const calls: Call[] = [];
    const fetchFn = makeRouter(
      {
        generate: () => mockResponse({ ok: false, status: 400, text: "alias already exists" }),
        list: () => mockResponse({ ok: true, status: 200, json: { keys: [] } }),
        delete: () => mockResponse({ ok: true, status: 200, json: {} }),
      },
      calls,
    );
    await expect(
      ensureKey({ baseUrl: "http://h", masterKey: "m", alias: "agent:kay" }, fetchFn),
    ).rejects.toThrow(/still reports alias .* already exists after deleting/);
  });
});

describe("validateKey", () => {
  it("returns valid with teamId=null on a 200 /key/info whose info carries no team_id", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(String(url));
      return mockResponse({ ok: true, status: 200, json: { key: "sk-x", info: {} } });
    };
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    // An UNBOUND key → teamId null (so the caller can re-bind it).
    expect(r).toEqual({ kind: "valid", teamId: null, models: [] });
    expect(calls[0]).toContain("/key/info?key=sk-x");
  });

  it("reports the bound team_id from info.team_id on a 200 /key/info", async () => {
    // F1: validateKey must surface the key's CURRENT team binding so the apply
    // path can tell an unbound (or wrong-team) key from a correctly-bound one.
    // Verified v1.91.0 shape: GET /key/info → { key, info: {...team_id...} }.
    const fetchFn: FetchFn = async () =>
      mockResponse({
        ok: true,
        status: 200,
        json: { key: "sk-x", info: { team_id: "team-uuid-42", spend: 0 } },
      });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r).toEqual({ kind: "valid", teamId: "team-uuid-42", models: [] });
  });

  it("returns unknown on a 400 'not found' (DB drift)", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 400, text: "Authentication Error: Key not found in DB" });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-gone" }, fetchFn);
    expect(r).toEqual({ kind: "unknown" });
  });

  it("returns unreachable on a network error (never re-provisions)", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r.kind).toBe("unreachable");
    expect((r as { detail: string }).detail).toMatch(/ECONNREFUSED/);
  });

  it("returns unknown on a 401 with a clear not-found semantic (auth-path drift shape)", async () => {
    // Some LiteLLM auth-path shapes report an unknown virtual key as a 401
    // "Authentication Error: Key not found" — that IS drift, not a bad master
    // key, so it must trigger re-provisioning.
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 401, text: "Authentication Error: Key not found in DB" });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-gone" }, fetchFn);
    expect(r).toEqual({ kind: "unknown" });
  });

  it("treats a BARE 401 (bad master key, no not-found semantic) as unreachable, NOT unknown", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 401, text: "Authentication Error: invalid master key" });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "bad", key: "sk-x" }, fetchFn);
    expect(r.kind).toBe("unreachable");
  });

  it("treats a non-drift 400 'invalid' body as unreachable (no unnecessary key churn)", async () => {
    // "invalid" alone is NOT a drift signal — a malformed-request 400 must not
    // trigger a destructive re-provision.
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 400, text: "invalid request: bad key format" });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r.kind).toBe("unreachable");
  });

  it("treats a 500 as unreachable, NOT unknown", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 500, text: "internal server error" });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r.kind).toBe("unreachable");
  });
});

describe("bindKeyToTeam", () => {
  it("POSTs {key, team_id} to /key/update and returns ok on 200", async () => {
    // F1 re-bind contract (verified v1.91.0 update_key_fn / UpdateKeyRequest):
    // a bind-only /key/update attaches an existing key to a team WITHOUT
    // deleting/regenerating it, so per-team cost tracking starts aggregating.
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return mockResponse({ ok: true, status: 200, json: { key: "sk-x", team_id: "t1" } });
    };
    const r = await bindKeyToTeam(
      { baseUrl: "http://127.0.0.1:4010", masterKey: "sk-master", key: "sk-x", teamId: "t1" },
      fetchFn,
    );
    expect(r).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4010/key/update");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    // Exactly the bind-only payload — no incidental key churn.
    expect(body).toEqual({ key: "sk-x", team_id: "t1" });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-master");
  });

  it("strips a trailing slash from base_url", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(String(url));
      return mockResponse({ ok: true, status: 200, json: {} });
    };
    await bindKeyToTeam({ baseUrl: "http://h/", masterKey: "m", key: "sk-x", teamId: "t1" }, fetchFn);
    expect(calls[0]).toBe("http://h/key/update");
  });

  it("returns a structured error (never throws) on a non-200", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 403, text: "forbidden" });
    const r = await bindKeyToTeam({ baseUrl: "http://h", masterKey: "m", key: "sk-x", teamId: "t1" }, fetchFn);
    expect(r.kind).toBe("error");
    expect((r as { detail: string }).detail).toMatch(/HTTP 403.*forbidden/);
  });

  it("returns a structured error (never throws) on a network failure", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await bindKeyToTeam({ baseUrl: "http://h", masterKey: "m", key: "sk-x", teamId: "t1" }, fetchFn);
    expect(r.kind).toBe("error");
    expect((r as { detail: string }).detail).toMatch(/ECONNREFUSED/);
  });
});

describe("validateKey — the key's model allowlist", () => {
  it("surfaces info.models so a key that cannot reach a declared lane is visible", () => {
    // The whole reason this field is read: the allowlist has no declarative
    // home on the proxy side, so `apply`/`doctor` can only see it here.
    const fetchFn: FetchFn = async () =>
      mockResponse({
        ok: true,
        status: 200,
        json: {
          key: "sk-x",
          info: { team_id: "t", models: ["gpt-oss-20b", "gpt-oss-120b"] },
        },
      });
    return validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn).then(
      (r) => {
        expect(r).toEqual({
          kind: "valid",
          teamId: "t",
          models: ["gpt-oss-20b", "gpt-oss-120b"],
        });
      },
    );
  });

  it("degrades an absent or non-array models field to [] (reads as unrestricted)", async () => {
    // [] is LiteLLM's "unrestricted", which reconciles NOTHING. That is the
    // safe direction: an unreadable field must never be mistaken for "this key
    // reaches nothing" and trigger a truncating write.
    for (const models of [undefined, null, "gpt-oss-20b", 42, {}]) {
      const fetchFn: FetchFn = async () =>
        mockResponse({ ok: true, status: 200, json: { key: "sk-x", info: { models } } });
      const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
      expect(r).toEqual({ kind: "valid", teamId: null, models: [] });
    }
  });

  it("drops non-string entries rather than propagating them into a write", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({
        ok: true,
        status: 200,
        json: { key: "sk-x", info: { models: ["gpt-oss-20b", 7, null, "gpt-oss-120b"] } },
      });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r).toEqual({ kind: "valid", teamId: null, models: ["gpt-oss-20b", "gpt-oss-120b"] });
  });

  it("degrades an unreadable body to [] instead of throwing", async () => {
    const fetchFn: FetchFn = async () => mockResponse({ ok: true, status: 200 });
    const r = await validateKey({ baseUrl: "http://h", masterKey: "m", key: "sk-x" }, fetchFn);
    expect(r).toEqual({ kind: "valid", teamId: null, models: [] });
  });
});

describe("updateKeyModels", () => {
  it("POSTs the FULL allowlist to /key/update, keyed by the key itself", async () => {
    // /key/update REPLACES `models` (v1.91.0 key_management_endpoints.py
    // update_key_fn), so the caller must send the union it wants to end up
    // with. Sending only the delta would silently REVOKE everything else.
    let seenUrl = "";
    let seenBody: unknown = null;
    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String((init as RequestInit).body));
      return mockResponse({ ok: true, status: 200, json: {} });
    };
    const r = await updateKeyModels(
      {
        baseUrl: "http://h",
        masterKey: "m",
        key: "sk-x",
        models: ["gpt-oss-20b", "gpt-oss-20b-retain"],
      },
      fetchFn,
    );
    expect(r).toEqual({ kind: "ok" });
    expect(seenUrl).toBe("http://h/key/update");
    expect(seenBody).toEqual({ key: "sk-x", models: ["gpt-oss-20b", "gpt-oss-20b-retain"] });
    // It must NOT regenerate or delete the key — that would churn the vault
    // and 401 every in-flight caller.
    expect(seenUrl).not.toContain("/key/delete");
    expect(seenUrl).not.toContain("/key/generate");
  });

  it("returns a structured error, never throws, on a non-2xx", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 403, text: "Authentication Error" });
    const r = await updateKeyModels(
      { baseUrl: "http://h", masterKey: "m", key: "sk-x", models: ["a"] },
      fetchFn,
    );
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.detail).toContain("HTTP 403");
  });

  it("returns a structured error, never throws, on a transport failure", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await updateKeyModels(
      { baseUrl: "http://h", masterKey: "m", key: "sk-x", models: ["a"] },
      fetchFn,
    );
    expect(r).toEqual({ kind: "error", detail: "ECONNREFUSED" });
  });
});
