import { describe, it, expect } from "vitest";
import {
  ensureFolder,
  ensureSwitchroomFolder,
  uploadFile,
  createShareLink,
  deliverToOneDrive,
  ONEDRIVE_INLINE_MAX_BYTES,
} from "./onedrive.js";

/** Build a fetch mock from a (method, urlSubstring) → Response routing table. */
function mockFetch(
  routes: Array<{ method?: string; match: string; status?: number; json?: unknown; record?: (url: string, init?: RequestInit) => void }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const r of routes) {
      if (url.includes(r.match) && (r.method ?? "GET").toUpperCase() === method) {
        r.record?.(url, init);
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: "",
          json: async () => r.json ?? {},
          text: async () => JSON.stringify(r.json ?? {}),
        } as Response;
      }
    }
    throw new Error(`unmocked ${method} ${url}`);
  }) as typeof fetch;
}

const TOKEN = "fake-access-token";

describe("ensureFolder", () => {
  it("returns the existing folder when GET by path succeeds (no create)", async () => {
    let created = false;
    const f = mockFetch([
      { method: "GET", match: "/root:/Switchroom", status: 200, json: { id: "F1", name: "Switchroom" } },
      { method: "POST", match: "/children", record: () => { created = true; }, json: {} },
    ]);
    const item = await ensureFolder({ accessToken: TOKEN, fetchImpl: f }, "", "Switchroom");
    expect(item.id).toBe("F1");
    expect(created).toBe(false);
  });

  it("creates the folder when GET returns 404", async () => {
    let createBody: string | undefined;
    const f = mockFetch([
      { method: "GET", match: "/root:/Switchroom", status: 404 },
      { method: "POST", match: "/root/children", status: 201, json: { id: "NEW", name: "Switchroom" }, record: (_u, init) => { createBody = String(init?.body); } },
    ]);
    const item = await ensureFolder({ accessToken: TOKEN, fetchImpl: f }, "", "Switchroom");
    expect(item.id).toBe("NEW");
    expect(createBody).toContain('"folder"');
    expect(createBody).toContain('conflictBehavior":"fail"');
  });

  it("treats a 409 create-race as 'exists' and re-fetches", async () => {
    let gets = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        gets++;
        // first GET 404 (not found), second GET 200 (created by the racer)
        const status = gets === 1 ? 404 : 200;
        return { ok: status === 200, status, statusText: "", json: async () => ({ id: "RACED", name: "x" }), text: async () => "" } as Response;
      }
      // POST → 409 conflict
      return { ok: false, status: 409, statusText: "", json: async () => ({}), text: async () => "" } as Response;
    }) as typeof fetch;
    const item = await ensureFolder({ accessToken: TOKEN, fetchImpl: f }, "", "Switchroom");
    expect(item.id).toBe("RACED");
    expect(gets).toBe(2);
  });
});

describe("ensureSwitchroomFolder", () => {
  it("ensures both Switchroom and Switchroom/<agent>", async () => {
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
      // Both folders already exist → GET 200.
      if (method === "GET" && url.includes("/root:/Switchroom/clerk")) {
        return { ok: true, status: 200, json: async () => ({ id: "AGENT", name: "clerk" }), text: async () => "" } as Response;
      }
      if (method === "GET" && url.includes("/root:/Switchroom")) {
        return { ok: true, status: 200, json: async () => ({ id: "TOP", name: "Switchroom" }), text: async () => "" } as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const item = await ensureSwitchroomFolder({ accessToken: TOKEN, fetchImpl: f }, "clerk");
    expect(item.id).toBe("AGENT");
    expect(seen.some((s) => s.includes("/root:/Switchroom/clerk"))).toBe(true);
  });
});

describe("uploadFile", () => {
  it("uses an inline PUT for a small file", async () => {
    let putUrl = "";
    const f = mockFetch([
      { method: "PUT", match: ":/content", status: 201, json: { id: "ITEM", name: "r.pdf" }, record: (u) => { putUrl = u; } },
    ]);
    const small = new Uint8Array(10);
    const item = await uploadFile({ accessToken: TOKEN, fetchImpl: f }, "FOLDER", "r.pdf", small);
    expect(item.id).toBe("ITEM");
    expect(putUrl).toContain("/me/drive/items/FOLDER:/r.pdf:/content");
  });

  it("uses an upload session for a file over the inline cap", async () => {
    let sessionRequested = false;
    const big = new Uint8Array(ONEDRIVE_INLINE_MAX_BYTES + 1);
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("createUploadSession")) {
        sessionRequested = true;
        return { ok: true, status: 200, json: async () => ({ uploadUrl: "https://upload.example/session" }), text: async () => "" } as Response;
      }
      if (url.includes("upload.example/session") && method === "PUT") {
        return { ok: true, status: 201, json: async () => ({ id: "BIGITEM", name: "big.bin" }), text: async () => "" } as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const item = await uploadFile({ accessToken: TOKEN, fetchImpl: f }, "FOLDER", "big.bin", big);
    expect(sessionRequested).toBe(true);
    expect(item.id).toBe("BIGITEM");
  });
});

describe("createShareLink", () => {
  it("returns the anonymous link webUrl when sharing succeeds", async () => {
    const f = mockFetch([
      { method: "POST", match: "/createLink", status: 200, json: { link: { webUrl: "https://1drv.ms/abc" } } },
    ]);
    const link = await createShareLink({ accessToken: TOKEN, fetchImpl: f }, { id: "ITEM", name: "x" });
    expect(link).toBe("https://1drv.ms/abc");
  });

  it("falls back to the item webUrl when sharing is blocked by policy", async () => {
    const f = mockFetch([
      { method: "POST", match: "/createLink", status: 403 }, // both anon + org attempts 403
    ]);
    const link = await createShareLink({ accessToken: TOKEN, fetchImpl: f }, { id: "ITEM", name: "x", webUrl: "https://onedrive/item" });
    expect(link).toBe("https://onedrive/item");
  });
});

describe("deliverToOneDrive (full orchestration)", () => {
  it("ensures the folder, uploads, and returns a link + folderPath", async () => {
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/root:/Switchroom")) {
        return { ok: true, status: 200, json: async () => ({ id: url.includes("/clerk") ? "AGENT" : "TOP", name: "x" }), text: async () => "" } as Response;
      }
      if (method === "PUT" && url.includes(":/content")) {
        return { ok: true, status: 201, json: async () => ({ id: "ITEM", name: "report.pdf", webUrl: "https://onedrive/report" }), text: async () => "" } as Response;
      }
      if (method === "POST" && url.includes("/createLink")) {
        return { ok: true, status: 200, json: async () => ({ link: { webUrl: "https://1drv.ms/report" } }), text: async () => "" } as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const out = await deliverToOneDrive({
      accessToken: TOKEN,
      agentName: "clerk",
      localPath: "/tmp/report.pdf",
      bytes: new Uint8Array(20),
      fetchImpl: f,
    });
    expect(out.itemId).toBe("ITEM");
    expect(out.link).toBe("https://1drv.ms/report");
    expect(out.folderPath).toBe("Switchroom/clerk");
  });
});
