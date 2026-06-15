import { describe, it, expect, vi } from "vitest";
import {
  reprocessDocuments,
  refreshMentalModel,
  restBaseFromMcpUrl,
} from "./memory-remediation.js";

const okResp = () => ({ ok: true, status: 200 }) as unknown as Response;
const failResp = (status: number) =>
  ({ ok: false, status }) as unknown as Response;

describe("restBaseFromMcpUrl", () => {
  it("strips a trailing /mcp/", () => {
    expect(restBaseFromMcpUrl("http://127.0.0.1:18888/mcp/")).toBe(
      "http://127.0.0.1:18888",
    );
  });
  it("strips /mcp with no trailing slash", () => {
    expect(restBaseFromMcpUrl("http://127.0.0.1:18888/mcp")).toBe(
      "http://127.0.0.1:18888",
    );
  });
  it("strips a trailing slash on a non-/mcp url", () => {
    expect(restBaseFromMcpUrl("http://host:9000/")).toBe("http://host:9000");
  });
});

describe("reprocessDocuments", () => {
  it("POSTs one reprocess URL per docId and counts all ok", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return okResp();
    }) as unknown as typeof fetch;

    const r = await reprocessDocuments(
      "http://127.0.0.1:18888",
      "coach-mem",
      ["doc-1", "doc-2", "doc-3"],
      { fetchImpl },
    );

    expect(r).toEqual({ triggered: 3, failed: 0 });
    expect(calls).toHaveLength(3);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "http://127.0.0.1:18888/v1/default/banks/coach-mem/documents/doc-1/reprocess",
    );
  });

  it("counts ok vs failed when some POSTs return non-2xx", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("doc-2") ? failResp(500) : okResp(),
    ) as unknown as typeof fetch;

    const r = await reprocessDocuments(
      "http://127.0.0.1:18888",
      "bank",
      ["doc-1", "doc-2", "doc-3"],
      { fetchImpl },
    );

    expect(r.triggered).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.error).toBe("HTTP 500");
  });

  it("never throws when fetch rejects — counts as failed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const r = await reprocessDocuments("http://x", "bank", ["d1", "d2"], {
      fetchImpl,
    });

    expect(r.triggered).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("encodes bank + docId into the URL", async () => {
    let seen = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seen = url;
      return okResp();
    }) as unknown as typeof fetch;
    await reprocessDocuments("http://x", "a b", ["d/1"], { fetchImpl });
    expect(seen).toBe("http://x/v1/default/banks/a%20b/documents/d%2F1/reprocess");
  });

  it("is a no-op (triggered 0) for an empty docId list", async () => {
    const fetchImpl = vi.fn(async () => okResp()) as unknown as typeof fetch;
    const r = await reprocessDocuments("http://x", "bank", [], { fetchImpl });
    expect(r).toEqual({ triggered: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("refreshMentalModel", () => {
  it("POSTs the refresh URL and returns ok", async () => {
    let seen = "";
    let method = "";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen = url;
      method = init?.method ?? "";
      return okResp();
    }) as unknown as typeof fetch;

    const r = await refreshMentalModel(
      "http://127.0.0.1:18888",
      "coach-mem",
      "mm-9",
      { fetchImpl },
    );

    expect(r).toEqual({ ok: true });
    expect(method).toBe("POST");
    expect(seen).toBe(
      "http://127.0.0.1:18888/v1/default/banks/coach-mem/mental-models/mm-9/refresh",
    );
  });

  it("maps a non-2xx response to ok:false with a reason", async () => {
    const fetchImpl = vi.fn(async () =>
      failResp(404),
    ) as unknown as typeof fetch;
    const r = await refreshMentalModel("http://x", "bank", "id", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 404");
  });

  it("never throws when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await refreshMentalModel("http://x", "bank", "id", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network down");
  });
});
