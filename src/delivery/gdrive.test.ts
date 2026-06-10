import { describe, it, expect } from "vitest";
import {
  ensureFolder,
  ensureSwitchroomFolder,
  uploadFile,
  createShareLink,
  deliverToGoogleDrive,
  GDRIVE_MULTIPART_MAX_BYTES,
} from "./gdrive.js";

function route(
  handlers: Array<{ method?: string; match: string; status?: number; json?: unknown; record?: (url: string, init?: RequestInit) => void }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    for (const h of handlers) {
      if (url.includes(h.match) && (h.method ?? "GET").toUpperCase() === method) {
        h.record?.(url, init);
        const status = h.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: "",
          json: async () => h.json ?? {},
          text: async () => JSON.stringify(h.json ?? {}),
        } as Response;
      }
    }
    throw new Error(`unmocked ${method} ${url}`);
  }) as typeof fetch;
}

const TOKEN = "ya29.access";

describe("ensureFolder", () => {
  it("returns the existing folder when the query finds one (no create)", async () => {
    let created = false;
    const f = route([
      { method: "GET", match: "/drive/v3/files?q=", json: { files: [{ id: "EXIST", name: "Switchroom" }] } },
      { method: "POST", match: "/drive/v3/files?fields", record: () => { created = true; }, json: {} },
    ]);
    const folder = await ensureFolder({ accessToken: TOKEN, fetchImpl: f }, "Switchroom", "root");
    expect(folder.id).toBe("EXIST");
    expect(created).toBe(false);
  });

  it("creates the folder when the query returns none, with the right parent", async () => {
    let createBody = "";
    const f = route([
      { method: "GET", match: "/drive/v3/files?q=", json: { files: [] } },
      { method: "POST", match: "/drive/v3/files?fields", json: { id: "NEW", name: "clerk" }, record: (_u, init) => { createBody = String(init?.body); } },
    ]);
    const folder = await ensureFolder({ accessToken: TOKEN, fetchImpl: f }, "clerk", "PARENT");
    expect(folder.id).toBe("NEW");
    expect(createBody).toContain('"mimeType":"application/vnd.google-apps.folder"');
    expect(createBody).toContain('"parents":["PARENT"]');
  });
});

describe("ensureSwitchroomFolder", () => {
  it("creates Switchroom under root, then <agent> under Switchroom", async () => {
    const parents: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/files?q=")) {
        return { ok: true, status: 200, json: async () => ({ files: [] }), text: async () => "" } as Response;
      }
      if (method === "POST" && url.includes("/files?fields")) {
        const b = JSON.parse(String(init?.body)) as { name: string; parents: string[] };
        parents.push(`${b.name}<-${b.parents[0]}`);
        return { ok: true, status: 200, json: async () => ({ id: b.name === "Switchroom" ? "TOP" : "AGENT", name: b.name }), text: async () => "" } as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const folder = await ensureSwitchroomFolder({ accessToken: TOKEN, fetchImpl: f }, "clerk");
    expect(folder.id).toBe("AGENT");
    expect(parents).toEqual(["Switchroom<-root", "clerk<-TOP"]);
  });
});

describe("uploadFile", () => {
  it("uploads via multipart and returns the file with id", async () => {
    let ct = "";
    const f = route([
      { method: "POST", match: "/upload/drive/v3/files?uploadType=multipart", json: { id: "FILE", name: "r.pdf", webViewLink: "https://drive.google.com/file/d/FILE/view" }, record: (_u, init) => { ct = String((init?.headers as Record<string, string>)["Content-Type"]); } },
    ]);
    const file = await uploadFile({ accessToken: TOKEN, fetchImpl: f }, "FOLDER", "r.pdf", new Uint8Array([1, 2, 3]));
    expect(file.id).toBe("FILE");
    expect(ct).toContain("multipart/related; boundary=");
  });

  it("switches to a resumable session for a file over the multipart cap", async () => {
    // 20 MiB → init session + chunked PUTs (8 MiB each → 3 chunks).
    const big = new Uint8Array(20 * 1024 * 1024);
    const ranges: string[] = [];
    let initted = false;
    let puts = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("uploadType=resumable")) {
        initted = true;
        return { ok: true, status: 200, headers: new Headers({ location: "https://upload.googleapis.com/session/xyz" }), json: async () => ({}), text: async () => "" } as Response;
      }
      if (method === "PUT" && url.includes("upload.googleapis.com/session")) {
        puts++;
        ranges.push((init?.headers as Record<string, string>)["Content-Range"]);
        const last = puts === 3;
        return { ok: last, status: last ? 200 : 308, headers: new Headers(), json: async () => (last ? { id: "BIG", name: "big.bin" } : {}), text: async () => "" } as Response;
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const file = await uploadFile({ accessToken: TOKEN, fetchImpl: f }, "FOLDER", "big.bin", big);
    expect(initted).toBe(true);
    expect(file.id).toBe("BIG");
    expect(puts).toBe(3);
    const total = 20 * 1024 * 1024;
    const chunk = 8 * 1024 * 1024;
    expect(ranges[0]).toBe(`bytes 0-${chunk - 1}/${total}`);
    expect(ranges[2]).toBe(`bytes ${2 * chunk}-${total - 1}/${total}`);
  });

  it("errors clearly if the resumable init returns no session URL", async () => {
    const big = new Uint8Array(GDRIVE_MULTIPART_MAX_BYTES + 1);
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") return { ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => "" } as Response;
      throw new Error("should not PUT without a session");
    }) as typeof fetch;
    await expect(uploadFile({ accessToken: TOKEN, fetchImpl: f }, "FOLDER", "big.bin", big)).rejects.toThrow(/no session URL/);
  });
});

describe("createShareLink", () => {
  it("grants anyone-reader and returns the webViewLink from the upload response", async () => {
    let permBody = "";
    const f = route([
      { method: "POST", match: "/permissions", json: {}, record: (_u, init) => { permBody = String(init?.body); } },
    ]);
    const link = await createShareLink({ accessToken: TOKEN, fetchImpl: f }, { id: "FILE", webViewLink: "https://drive.google.com/file/d/FILE/view" });
    expect(link).toBe("https://drive.google.com/file/d/FILE/view");
    expect(permBody).toContain('"type":"anyone"');
    expect(permBody).toContain('"role":"reader"');
  });

  it("fetches the webViewLink when the upload didn't include it", async () => {
    const f = route([
      { method: "POST", match: "/permissions", json: {} },
      { method: "GET", match: "fields=webViewLink", json: { webViewLink: "https://drive.google.com/fetched" } },
    ]);
    const link = await createShareLink({ accessToken: TOKEN, fetchImpl: f }, { id: "FILE" });
    expect(link).toBe("https://drive.google.com/fetched");
  });
});

describe("deliverToGoogleDrive (full orchestration)", () => {
  it("ensures folders, uploads, shares, and returns link + folderPath", async () => {
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/files?q=")) return { ok: true, status: 200, json: async () => ({ files: [] }), text: async () => "" } as Response;
      if (method === "POST" && url.includes("/files?fields")) { const b = JSON.parse(String(init?.body)) as { name: string }; return { ok: true, status: 200, json: async () => ({ id: b.name === "Switchroom" ? "TOP" : "AGENT" }), text: async () => "" } as Response; }
      if (method === "POST" && url.includes("/upload/")) return { ok: true, status: 200, json: async () => ({ id: "FILE", webViewLink: "https://drive.google.com/report" }), text: async () => "" } as Response;
      if (method === "POST" && url.includes("/permissions")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const out = await deliverToGoogleDrive({ accessToken: TOKEN, agentName: "clerk", localPath: "/tmp/report.pdf", bytes: new Uint8Array(10), fetchImpl: f });
    expect(out.itemId).toBe("FILE");
    expect(out.link).toBe("https://drive.google.com/report");
    expect(out.folderPath).toBe("Switchroom/clerk");
  });
});
