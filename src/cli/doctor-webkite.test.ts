/**
 * doctor-webkite — surfaces the webkite fleet-default failure classes.
 *
 * Each case pins a bug that shipped during the webkite rollout:
 *   - wrong-arch binary (macOS Mach-O / non-x86-64) → won't run
 *     in-container (the canary catch that forced the trixie bump)
 *   - cloakbrowser absent → no local render, cloud-only
 *   - permissions.allow missing mcp__webkite__* → first fetch wedges
 *     on a permission prompt (#1949)
 *   - agent-UID-owned scaffold unreadable by the operator → skip,
 *     never fail (the no-sudo doctor discipline)
 */

import { describe, expect, it } from "vitest";

import { runWebkiteChecks, type WebkiteProbeDeps } from "./doctor-webkite.js";
import type { SwitchroomConfig } from "../config/schema.js";

function cfg(partial: Partial<SwitchroomConfig>): SwitchroomConfig {
  return partial as unknown as SwitchroomConfig;
}

function byName(rs: { name: string; status: string; detail?: string }[], name: string) {
  return rs.find((r) => r.name === name);
}

// ELF x86-64 header: 0x7F 'E' 'L' 'F', class=2, ... e_machine(0x3E) at 18.
const ELF_X64 = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0x3e, 0x00,
]);
// ELF aarch64: e_machine 0xB7.
const ELF_ARM64 = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0xb7, 0x00,
]);
// Mach-O 64 (macOS) magic 0xFEEDFACF — NOT ELF.
const MACHO = Buffer.from([
  0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

interface FakeFs {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  heads?: Record<string, Buffer>;
  eaccess?: Set<string>;
}

function deps(fs: FakeFs, extra: Partial<WebkiteProbeDeps> = {}): WebkiteProbeDeps {
  const present = new Set<string>([
    ...Object.keys(fs.files ?? {}),
    ...Object.keys(fs.dirs ?? {}),
    ...Object.keys(fs.heads ?? {}),
  ]);
  return {
    homeDir: "/home/op",
    agentsDir: "/home/op/.switchroom/agents",
    existsSync: (p) => present.has(p),
    readFileSync: (p) => {
      if (fs.eaccess?.has(p)) {
        const e = new Error("EACCES") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      const v = fs.files?.[p];
      if (v === undefined) throw new Error(`no file ${p}`);
      return v;
    },
    readdirSync: (p) => fs.dirs?.[p] ?? [],
    readHead: (p) => fs.heads?.[p] ?? null,
    ...extra,
  };
}

const BIN = "/home/op/.switchroom/bin/webkite";
const CLOAK = "/home/op/.cloakbrowser";
const CHROME = "/home/op/.cloakbrowser/chromium-146/chrome";

describe("runWebkiteChecks", () => {
  it("returns [] when every agent opts out of webkite", () => {
    const config = cfg({
      agents: { a: { mcp_servers: { webkite: false } } as never },
    });
    expect(runWebkiteChecks(config, deps({}))).toEqual([]);
  });

  it("warns when the binary is not staged", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(config, deps({ dirs: { [CLOAK]: ["chromium-146"] }, files: { [CHROME]: "" } }));
    expect(byName(r, "webkite: binary")?.status).toBe("warn");
  });

  it("fails when the staged binary is a non-ELF (macOS) build", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(config, deps({ heads: { [BIN]: MACHO } }));
    const bin = byName(r, "webkite: binary");
    expect(bin?.status).toBe("fail");
    expect(bin?.detail).toMatch(/not a Linux ELF/i);
  });

  it("fails when the staged binary is the wrong CPU arch (arm64 ELF)", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(config, deps({ heads: { [BIN]: ELF_ARM64 } }));
    expect(byName(r, "webkite: binary")?.status).toBe("fail");
  });

  it("passes the binary check for a linux x86-64 ELF", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(config, deps({ heads: { [BIN]: ELF_X64 } }));
    expect(byName(r, "webkite: binary")?.status).toBe("ok");
  });

  it("warns when cloakbrowser is absent", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(config, deps({ heads: { [BIN]: ELF_X64 } }));
    expect(byName(r, "webkite: cloakbrowser")?.status).toBe("warn");
  });

  it("passes cloakbrowser when chromium/chrome is present", () => {
    const config = cfg({ agents: { a: {} as never } });
    const r = runWebkiteChecks(
      config,
      deps({ heads: { [BIN]: ELF_X64 }, dirs: { [CLOAK]: ["chromium-146"] }, files: { [CHROME]: "" } }),
    );
    expect(byName(r, "webkite: cloakbrowser")?.status).toBe("ok");
  });

  it("OK per-agent scaffold when wired + pre-approved + WebFetch denied", () => {
    const config = cfg({
      switchroom: { version: 1, agents_dir: "/home/op/.switchroom/agents" } as never,
      agents: { clerk: {} as never },
    });
    const sp = "/home/op/.switchroom/agents/clerk/.claude/settings.json";
    const mp = "/home/op/.switchroom/agents/clerk/.mcp.json";
    const r = runWebkiteChecks(
      config,
      deps({
        heads: { [BIN]: ELF_X64 },
        files: {
          [sp]: JSON.stringify({ permissions: { allow: ["mcp__webkite__*"], deny: ["WebFetch", "WebSearch"] } }),
          [mp]: JSON.stringify({ mcpServers: { webkite: { command: "webkite" } } }),
        },
      }),
    );
    expect(byName(r, "webkite: clerk scaffold")?.status).toBe("ok");
  });

  it("warns per-agent when permissions.allow is missing the webkite pre-approval (#1949 regression)", () => {
    const config = cfg({
      switchroom: { version: 1, agents_dir: "/home/op/.switchroom/agents" } as never,
      agents: { clerk: {} as never },
    });
    const sp = "/home/op/.switchroom/agents/clerk/.claude/settings.json";
    const mp = "/home/op/.switchroom/agents/clerk/.mcp.json";
    const r = runWebkiteChecks(
      config,
      deps({
        heads: { [BIN]: ELF_X64 },
        files: {
          [sp]: JSON.stringify({ permissions: { allow: [], deny: ["WebFetch", "WebSearch"] } }),
          [mp]: JSON.stringify({ mcpServers: { webkite: {} } }),
        },
      }),
    );
    const s = byName(r, "webkite: clerk scaffold");
    expect(s?.status).toBe("warn");
    expect(s?.detail).toMatch(/mcp__webkite__\*/);
  });

  it("SKIPS (never fails) per-agent scaffold when the operator can't read agent-private files", () => {
    const config = cfg({
      switchroom: { version: 1, agents_dir: "/home/op/.switchroom/agents" } as never,
      agents: { clerk: {} as never },
    });
    const sp = "/home/op/.switchroom/agents/clerk/.claude/settings.json";
    const r = runWebkiteChecks(
      config,
      deps({ heads: { [BIN]: ELF_X64 }, files: { [sp]: "x" }, eaccess: new Set([sp]) }),
    );
    expect(byName(r, "webkite: clerk scaffold")?.status).toBe("skip");
  });
});
