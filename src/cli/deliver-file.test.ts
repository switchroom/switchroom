import { describe, it, expect } from "vitest";
import { runDeliverFile } from "./deliver-file.js";

const okDeps = {
  agentName: "clerk",
  fileSize: () => 1234,
  readFile: () => new Uint8Array([1, 2, 3]),
  getAccessToken: async () => "tok",
  deliver: async (a: { agentName: string; localPath: string }) => ({
    itemId: "ITEM",
    link: "https://1drv.ms/report",
    folderPath: `Switchroom/${a.agentName}`,
  }),
};

describe("runDeliverFile", () => {
  it("delivers a file and returns the share link + folder path", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", okDeps);
    expect(res.ok).toBe(true);
    expect(res.link).toBe("https://1drv.ms/report");
    expect(res.folderPath).toBe("Switchroom/clerk");
    expect(res.filename).toBe("report.pdf");
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
    const res = await runDeliverFile("/tmp/report.pdf", {
      ...okDeps,
      getAccessToken: async () => { throw new Error("no account"); },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no connected drive/i);
    expect(res.error).toMatch(/reply tool/i); // tells the agent the 50MB fallback
  });

  it("surfaces an upload failure without crashing", async () => {
    const res = await runDeliverFile("/tmp/report.pdf", {
      ...okDeps,
      deliver: async () => { throw new Error("HTTP 507 quota"); },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/upload failed.*507/);
  });
});
