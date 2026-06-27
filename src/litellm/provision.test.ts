import { describe, it, expect } from "vitest";
import {
  ensureTeam,
  ensureKey,
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
  it("POSTs team_alias to /team/new and resolves on success", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return mockResponse({ ok: true, status: 200, json: { team_id: "t1" } });
    };
    await ensureTeam("http://127.0.0.1:4010", "sk-master", "switchroom", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4010/team/new");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({ team_alias: "switchroom" });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-master");
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
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).resolves.toBeUndefined();
  });

  it("treats a 409 conflict as success (idempotent)", async () => {
    const fetchFn: FetchFn = async () =>
      mockResponse({ ok: false, status: 409, text: "conflict" });
    await expect(
      ensureTeam("http://h", "k", "switchroom", fetchFn),
    ).resolves.toBeUndefined();
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
  it("POSTs the key spec to /key/generate and returns the new key", async () => {
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
        team: "switchroom",
        models: ["claude-haiku-4-5-20251001"],
        metadata: { agent: "clerk", env: "fleet" },
      },
      fetchFn,
    );
    expect(result).toEqual({ key: "sk-virtual-abc", created: true });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4010/key/generate");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      key_alias: "agent:clerk",
      models: ["claude-haiku-4-5-20251001"],
      team_alias: "switchroom",
      metadata: { agent: "clerk", env: "fleet" },
    });
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
