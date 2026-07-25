/**
 * Webkite integration doctor checks.
 *
 * Webkite is the fleet-default web fetcher (v0.13.62+): every agent
 * gets the `webkite_*` MCP tools and native WebFetch/WebSearch are
 * denied unless the agent opts out via `mcp_servers.webkite: false`.
 * The rollout shipped through three SILENT failure classes, each of
 * which these probes convert into one upfront, operator-visible line:
 *
 *   1. binary arch       — the operator stages a private-beta binary at
 *      `~/.switchroom/bin/webkite`. A wrong-arch build (e.g. a macOS
 *      arm64 Mach-O instead of linux x86-64 ELF, or a glibc-too-new
 *      build) won't run in-container — the agent silently loses web
 *      access. We read the ELF header on the host so the gross mistake
 *      is caught before a fleet roll, not after.
 *   2. cloakbrowser      — the fleet-shared stealth Chromium lives at
 *      `~/.switchroom/cloakbrowser/` and is bind-mounted RO onto the
 *      image's CLOAKBROWSER_CACHE_DIR (#TBD). Absent → webkite can only
 *      cloud-render (Cloudflare/Firecrawl) and fails on bot-gated sites
 *      with no local fallback.
 *   3. scaffold wiring   — for each webkite-enabled agent that HAS been
 *      scaffolded: `.mcp.json` must carry the `webkite` entry,
 *      `settings.json` `permissions.allow` must pre-approve
 *      `mcp__webkite__*` (the bug that wedged the first fetch on a
 *      permission prompt — #1949), and `permissions.deny` must carry
 *      WebFetch/WebSearch (so the model reaches for webkite).
 *
 * Filesystem access is dependency-injected so unit tests drive every
 * branch without a real scaffold tree (mirrors `doctor-drive.ts`). The
 * EACCES/EPERM split is load-bearing: scaffold artifacts are
 * agent-UID-owned 0600 and the host operator running `doctor` (without
 * sudo) cannot read them — that must read as `skip`, never `fail`.
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  readdirSync as realReaddirSync,
  openSync as realOpenSync,
  readSync as realReadSync,
  closeSync as realCloseSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface WebkiteProbeDeps {
  /** Home dir override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  readdirSync?: (p: string) => string[];
  /** Read the first `n` bytes of a file (for the ELF-header arch probe). */
  readHead?: (p: string, n: number) => Buffer | null;
}

interface ResolvedDeps {
  homeDir: string;
  agentsDir: string | undefined;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  readdirSync: (p: string) => string[];
  readHead: (p: string, n: number) => Buffer | null;
}

function defaultReadHead(p: string, n: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = realOpenSync(p, "r");
    const buf = Buffer.alloc(n);
    const read = realReadSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { realCloseSync(fd); } catch { /* ignore */ }
    }
  }
}

function resolveDeps(config: SwitchroomConfig, deps: WebkiteProbeDeps): ResolvedDeps {
  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }
  return {
    homeDir: deps.homeDir ?? homedir(),
    agentsDir,
    existsSync: deps.existsSync ?? ((p) => realExistsSync(p)),
    readFileSync: deps.readFileSync ?? ((p) => realReadFileSync(p, "utf-8")),
    readdirSync: deps.readdirSync ?? ((p) => realReaddirSync(p)),
    readHead: deps.readHead ?? defaultReadHead,
  };
}

/** ELF header classification of the staged binary. */
type ArchVerdict = "elf-x64" | "elf-other-arch" | "not-elf" | "unreadable";

function classifyArch(d: ResolvedDeps, path: string): ArchVerdict {
  const head = d.readHead(path, 20);
  if (head === null || head.length < 20) return "unreadable";
  // ELF magic: 0x7F 'E' 'L' 'F'
  if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
    return "not-elf"; // e.g. a Mach-O (macOS) build — the arm64 mistake
  }
  // e_machine is a 16-bit LE field at offset 18. 0x3E = EM_X86_64.
  const eMachine = head[18]! | (head[19]! << 8);
  return eMachine === 0x3e ? "elf-x64" : "elf-other-arch";
}

function webkiteEnabled(config: SwitchroomConfig, agent: string): boolean {
  const mcp = (config.agents?.[agent] as { mcp_servers?: Record<string, unknown> } | undefined)
    ?.mcp_servers;
  return (mcp ?? {})["webkite"] !== false;
}

/**
 * Run all webkite checks. Returns [] only when EVERY agent has opted
 * out of webkite (so the section stays silent on installs that don't
 * use it). On the default fleet (webkite on) it always emits.
 */
export function runWebkiteChecks(
  config: SwitchroomConfig,
  deps: WebkiteProbeDeps = {},
): CheckResult[] {
  const agents = Object.keys(config.agents ?? {});
  const enabledAgents = agents.filter((a) => webkiteEnabled(config, a));
  if (enabledAgents.length === 0) return [];

  const d = resolveDeps(config, deps);
  const results: CheckResult[] = [];

  // ── 1. binary present + arch ──────────────────────────────────────
  const binPath = join(d.homeDir, ".switchroom", "bin", "webkite");
  if (!d.existsSync(binPath)) {
    results.push({
      name: "webkite: binary",
      status: "warn",
      detail: `not staged at ${binPath} — agents run in degraded "no-webkite" mode (native WebFetch kept by the fail-safe gate)`,
      fix: "Stage the private-beta binary: cp <webkite> ~/.switchroom/bin/webkite && chmod +x; then `switchroom update`.",
    });
  } else {
    const arch = classifyArch(d, binPath);
    if (arch === "elf-x64") {
      results.push({ name: "webkite: binary", status: "ok", detail: `staged, linux x86-64 ELF (${binPath})` });
    } else if (arch === "unreadable") {
      results.push({ name: "webkite: binary", status: "skip", detail: `present but unreadable by the operator — re-run doctor without sudo` });
    } else if (arch === "not-elf") {
      results.push({
        name: "webkite: binary",
        status: "fail",
        detail: `${binPath} is not a Linux ELF binary (likely a macOS/other-OS build) — it cannot run in the agent container`,
        fix: "Replace with a linux x86-64 build (static musl preferred). See the webkite release artifacts.",
      });
    } else {
      results.push({
        name: "webkite: binary",
        status: "fail",
        detail: `${binPath} is an ELF binary for the wrong CPU arch (not x86-64) — it cannot run in the agent container`,
        fix: "Replace with a linux x86-64 (amd64) build.",
      });
    }
  }

  // ── 2. cloakbrowser local render ──────────────────────────────────
  // Probe the SHARED cache (`~/.switchroom/cloakbrowser/`) — the mount
  // source compose.ts emits (#TBD). The legacy per-operator
  // `~/.cloakbrowser/` is probed only to produce a migration hint: it is
  // no longer mounted anywhere, so a fleet with only that is NOT healthy.
  const sharedCloakDir = join(d.homeDir, ".switchroom", "cloakbrowser");
  const legacyCloakDir = join(d.homeDir, ".cloakbrowser");
  const hasChromium = (dir: string): boolean => {
    if (!d.existsSync(dir)) return false;
    try {
      for (const entry of d.readdirSync(dir)) {
        if (entry.startsWith("chromium-") && d.existsSync(join(dir, entry, "chrome"))) {
          return true;
        }
      }
    } catch { /* unreadable dir — treat as absent */ }
    return false;
  };
  if (hasChromium(sharedCloakDir)) {
    results.push({
      name: "webkite: cloakbrowser",
      status: "ok",
      detail: "shared stealth Chromium present at ~/.switchroom/cloakbrowser (local render available; one copy mounted RO into every agent)",
    });
  } else if (hasChromium(legacyCloakDir)) {
    results.push({
      name: "webkite: cloakbrowser",
      status: "warn",
      detail: "stealth Chromium is at the legacy ~/.cloakbrowser but NOT at the shared ~/.switchroom/cloakbrowser — nothing mounts the legacy path, so every agent re-downloads its own ~700MB copy",
      fix: "Move it to the shared path, then re-apply: mv ~/.cloakbrowser ~/.switchroom/cloakbrowser && chmod -R a+rX ~/.switchroom/cloakbrowser && switchroom apply",
    });
  } else {
    results.push({
      name: "webkite: cloakbrowser",
      status: "warn",
      detail: "no shared stealth Chromium at ~/.switchroom/cloakbrowser/chromium-*/chrome — webkite can only cloud-render (Cloudflare/Firecrawl) and will fail bot-gated sites with no local fallback",
      fix: "Populate once on the host, then re-apply: CLOAKBROWSER_CACHE_DIR=~/.switchroom/cloakbrowser cloakbrowser install && chmod -R a+rX ~/.switchroom/cloakbrowser && switchroom apply",
    });
  }

  // ── 3. per-agent scaffold wiring ──────────────────────────────────
  if (d.agentsDir === undefined) {
    results.push({
      name: "webkite: scaffold",
      status: "warn",
      detail: "agents_dir unresolved (no switchroom.agents_dir) — cannot verify per-agent webkite wiring",
    });
    return results;
  }

  for (const agent of enabledAgents) {
    const agentDir = join(d.agentsDir, agent);
    const settingsPath = join(agentDir, ".claude", "settings.json");
    const mcpPath = join(agentDir, ".mcp.json");
    if (!d.existsSync(settingsPath) && !d.existsSync(mcpPath)) {
      // Agent not scaffolded yet — silent (apply will scaffold it).
      continue;
    }

    let settings: { permissions?: { allow?: string[]; deny?: string[] } } | null = null;
    let mcp: { mcpServers?: Record<string, unknown> } | null = null;
    let unreadable = false;
    for (const [path, set] of [
      [settingsPath, (v: unknown) => { settings = v as typeof settings; }],
      [mcpPath, (v: unknown) => { mcp = v as typeof mcp; }],
    ] as const) {
      if (!d.existsSync(path)) continue;
      try {
        set(JSON.parse(d.readFileSync(path)));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM") { unreadable = true; }
        // corrupt/other → leave as null, handled below
      }
    }

    if (unreadable) {
      results.push({
        name: `webkite: ${agent} scaffold`,
        status: "skip",
        detail: "scaffold files are agent-UID-owned (0600) — re-run doctor without sudo to read them",
      });
      continue;
    }

    const mcpHasWebkite = !!(mcp && (mcp as { mcpServers?: Record<string, unknown> }).mcpServers?.["webkite"]);
    const allow = (settings as { permissions?: { allow?: string[] } } | null)?.permissions?.allow ?? [];
    const deny = (settings as { permissions?: { deny?: string[] } } | null)?.permissions?.deny ?? [];
    const allowOk = allow.includes("mcp__webkite__*");
    const denyOk = deny.includes("WebFetch");

    const problems: string[] = [];
    if (!mcpHasWebkite) problems.push(".mcp.json missing the webkite entry");
    if (!allowOk) problems.push("permissions.allow missing mcp__webkite__* (first fetch will prompt)");
    if (!denyOk) problems.push("permissions.deny missing WebFetch (native fetch not disabled)");

    if (problems.length === 0) {
      results.push({ name: `webkite: ${agent} scaffold`, status: "ok", detail: "wired + pre-approved + WebFetch denied" });
    } else {
      results.push({
        name: `webkite: ${agent} scaffold`,
        status: "warn",
        detail: problems.join("; "),
        fix: "Run `switchroom apply` (or `switchroom agent restart <agent>`) to re-scaffold the webkite wiring.",
      });
    }
  }

  return results;
}
