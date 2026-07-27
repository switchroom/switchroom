/**
 * `switchroom doctor` — the host-capabilities verdict row.
 *
 * Nothing checked this file before, and its silent-failure mode cost the fleet
 * GPU passthrough plus the GPU-gated reranker defaults on 2026-07-28: the
 * verdict was `root:root 0600` under a uid-1000 home (`sudo switchroom setup`
 * writes as root), so every later run read `EACCES`, swallowed it, and treated
 * the host as GPU-less. `doctor` was green throughout.
 */

import { describe, it, expect } from "vitest";
import { checkHostCapabilitiesReadable } from "./doctor.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { HostCapabilitiesRead } from "../setup/host-capabilities.js";

const CONFIG = { agents: {} } as unknown as SwitchroomConfig;
const CONFIG_GPU_ON = { agents: {}, hindsight: { gpu: true } } as unknown as SwitchroomConfig;

const PATH = "/home/someone/.switchroom/host-capabilities.json";

const read = (over: Partial<HostCapabilitiesRead>): HostCapabilitiesRead => ({
  status: "ok",
  path: PATH,
  caps: null,
  detail: "",
  ...over,
});

describe("checkHostCapabilitiesReadable", () => {
  it("FAILS on an unreadable verdict and names the file, the consequence, and the fix", () => {
    const r = checkHostCapabilitiesReadable(
      CONFIG,
      read({ status: "unreadable", code: "EACCES", detail: "EACCES: permission denied" }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(PATH);
    expect(r.detail).toContain("cannot tell");
    // The consequence has to be in the row — "unreadable file" alone reads
    // like a cosmetic problem, and that is why it was ignored for months.
    expect(r.detail).toContain("--gpus all");
    expect(r.detail).toContain("HINDSIGHT_API_RERANKER_LOCAL_FP16");
    expect(r.fix).toContain("chown");
    expect(r.fix).toContain("hindsight.gpu");
  });

  it("FAILS on a malformed verdict and tells the operator to re-probe", () => {
    const r = checkHostCapabilitiesReadable(
      CONFIG,
      read({ status: "malformed", detail: "invalid JSON: Unexpected end of input" }),
    );
    expect(r.status).toBe("fail");
    expect(r.fix).toContain("switchroom setup");
  });

  it("downgrades to WARN when `hindsight.gpu` already pins the answer", () => {
    const r = checkHostCapabilitiesReadable(
      CONFIG_GPU_ON,
      read({ status: "unreadable", code: "EACCES", detail: "EACCES: permission denied" }),
    );
    // Hindsight no longer depends on the file, but voice/compose still do —
    // so it is not silently green either.
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("hindsight.gpu: true");
  });

  it("stays OK for an absent verdict (a fresh install has never probed)", () => {
    const r = checkHostCapabilitiesReadable(CONFIG, read({ status: "absent" }));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("never probed");
  });

  it("is OK and reports the proven/not-proven verdict when the file reads fine", () => {
    const proven = checkHostCapabilitiesReadable(
      CONFIG,
      read({
        status: "ok",
        caps: {
          version: 1,
          voice: {
            gpuPresent: true,
            containerToolkit: true,
            engine: "local",
            detectedAt: "2026-07-26T00:00:00.000Z",
          },
        },
      }),
    );
    expect(proven.status).toBe("ok");
    expect(proven.detail).toContain("GPU passthrough proven");

    const notProven = checkHostCapabilitiesReadable(
      CONFIG,
      read({
        status: "ok",
        caps: {
          version: 1,
          voice: {
            gpuPresent: false,
            containerToolkit: false,
            engine: "cloud",
            detectedAt: "2026-07-26T00:00:00.000Z",
          },
        },
      }),
    );
    expect(notProven.status).toBe("ok");
    expect(notProven.detail).toContain("GPU passthrough not proven");
  });
});
