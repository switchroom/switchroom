import { describe, it, expect } from "vitest";
import { runDeliverFile, resolveLinkScopes, resolveGoogleLinkScopes, safeAgentName } from "./deliver-file.js";

describe("resolveLinkScopes (OneDrive)", () => {
  it("defaults to anonymous-first", () => {
    expect(resolveLinkScopes({} as NodeJS.ProcessEnv)).toEqual(["anonymous", "organization"]);
  });
  it("honors organization-only", () => {
    expect(resolveLinkScopes({ SWITCHROOM_DELIVER_LINK_SCOPE: "organization" } as NodeJS.ProcessEnv)).toEqual(["organization"]);
  });
  it("honors anonymous-only", () => {
    expect(resolveLinkScopes({ SWITCHROOM_DELIVER_LINK_SCOPE: "anonymous" } as NodeJS.ProcessEnv)).toEqual(["anonymous"]);
  });
});

describe("resolveGoogleLinkScopes", () => {
  it("defaults to anyone-with-link", () => {
    expect(resolveGoogleLinkScopes({} as NodeJS.ProcessEnv)).toEqual(["anyone"]);
  });
  it("maps organization → domain", () => {
    expect(resolveGoogleLinkScopes({ SWITCHROOM_DELIVER_LINK_SCOPE: "organization" } as NodeJS.ProcessEnv)).toEqual(["domain"]);
  });
});

describe("safeAgentName (path-traversal guard)", () => {
  it("passes a valid agent name", () => {
    expect(safeAgentName("clerk")).toBe("clerk");
  });
  it("rejects a name with a slash or dot-dot, falling back to 'agent'", () => {
    expect(safeAgentName("../evil")).toBe("agent");
    expect(safeAgentName("a/b")).toBe("agent");
    expect(safeAgentName(undefined)).toBe("agent");
  });
});

const oneDrive = {
  name: "OneDrive" as const,
  deliver: async (a: { agentName: string }) => ({
    itemId: "ITEM",
    link: "https://1drv.ms/report",
    folderPath: `Switchroom/${a.agentName}`,
  }),
};

const okDeps = {
  agentName: "clerk",
  fileSize: () => 1234,
  readFile: () => new Uint8Array([1, 2, 3]),
  resolveProvider: async () => oneDrive,
};

describe("runDeliverFile", () => {
  it("delivers a file and returns the provider + share link + folder path", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", okDeps);
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("OneDrive");
    expect(res.link).toBe("https://1drv.ms/report");
    expect(res.folderPath).toBe("Switchroom/clerk");
    expect(res.filename).toBe("report.pdf");
  });

  it("uses Google Drive when that's the resolved provider", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", {
      ...okDeps,
      resolveProvider: async () => ({
        name: "Google Drive" as const,
        deliver: async (a: { agentName: string }) => ({ itemId: "G", link: "https://drive.google.com/x", folderPath: `Switchroom/${a.agentName}` }),
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("Google Drive");
    expect(res.link).toBe("https://drive.google.com/x");
  });

  it("fails cleanly when the file is missing", async () => {
    const res = await runDeliverFile("/tmp/nope.pdf", {
      ...okDeps,
      fileSize: () => { throw new Error("ENOENT"); },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/file not found/);
  });

  it("fails cleanly on an empty file", async () => {
    const res = await runDeliverFile("/tmp/empty", { ...okDeps, fileSize: () => 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/);
  });

  it("gives an actionable error when no drive is connected (points at reply fallback)", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", { ...okDeps, resolveProvider: async () => null });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no connected drive/i);
    expect(res.error).toMatch(/reply tool/i); // tells the agent the 50MB fallback
  });

  it("surfaces an upload failure without crashing", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", {
      ...okDeps,
      resolveProvider: async () => ({ name: "OneDrive" as const, deliver: async () => { throw new Error("HTTP 507 quota"); } }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/upload failed.*507/);
  });
});
