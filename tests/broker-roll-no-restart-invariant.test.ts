/**
 * Structural invariant (#3031 PR 4): broker-side account rolls NEVER trigger
 * the gateway's self-restart / fleet-fallback-resume machinery.
 *
 * Why this matters: `fleetQuotaProbeTick` → `markExhaustedAndRoll`
 * (src/auth/broker/server.ts) rolls the fleet PROACTIVELY, before any agent
 * crashes into the wall. That roll is a credential fan-out only — running
 * sessions pick up the new mirror bytes on their next request (see
 * docs/auth.md § "Mid-turn account swap semantics"). The gateway's
 * `triggerSelfRestart('fleet-fallback-resume')` exists for a DIFFERENT case:
 * a mid-turn 429 already KILLED a turn, and only a restart's boot-resume path
 * can replay it. If broker rolls ever grew a restart hook, every proactive
 * roll would bounce healthy agents mid-turn — the exact disruption the
 * proactive design avoids.
 *
 * These tests pin the separation structurally so a refactor can't quietly
 * couple the two paths.
 *
 * KNOWN BLIND SPOT — the ban is lexical, not semantic. It catches direct
 * references to the gateway restart machinery, but the broker could still
 * reach restart semantics through another door: shelling out to
 * `docker restart`, invoking a hostd restart verb, or writing a relaunch
 * stamp file. Those doors don't exist in src/auth/broker today; if one is
 * ever added deliberately, extend the forbidden list here (or write the
 * behavioural test) rather than treating this suite as proof it can't
 * happen.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const BROKER_DIR = join(REPO_ROOT, "src", "auth", "broker");
const GATEWAY_TS = join(REPO_ROOT, "telegram-plugin", "gateway", "gateway.ts");

/** Recursively list .ts files (excluding tests) under a directory. */
function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...tsSources(p));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Every non-test .ts under src/, for the repo-wide sweep. */
function allSrcSources(): string[] {
  return tsSources(join(REPO_ROOT, "src"));
}

describe("broker roll ↔ gateway restart separation (structural)", () => {
  it("src/auth/broker/ never references the gateway restart machinery", () => {
    const forbidden = [
      "triggerSelfRestart",
      "fleet-fallback-resume",
      "doFireFleetAutoFallback",
      "fireFleetAutoFallback",
    ];
    for (const file of tsSources(BROKER_DIR)) {
      const text = readFileSync(file, "utf-8");
      for (const needle of forbidden) {
        expect(
          text.includes(needle),
          `${file} references '${needle}' — broker rolls must stay a pure ` +
            `credential fan-out; restarts belong to the gateway's 429-resume path only`,
        ).toBe(false);
      }
    }
  });

  it("src/auth/broker/ imports nothing from telegram-plugin", () => {
    const importRe = /from\s+["'][^"']*telegram-plugin[^"']*["']/;
    for (const file of tsSources(BROKER_DIR)) {
      const text = readFileSync(file, "utf-8");
      expect(
        importRe.test(text),
        `${file} imports from telegram-plugin — the broker must not depend on gateway code`,
      ).toBe(false);
    }
  });

  it("nothing anywhere in src/ reaches the restart/resume machinery", () => {
    // Broader sweep than the broker dir: the CLI/agents/scheduler side of the
    // repo must not grow a call into the gateway's self-restart either — the
    // only sanctioned trigger lives in telegram-plugin/gateway.
    const forbidden = ["triggerSelfRestart", "doFireFleetAutoFallback", "createFleetFallbackResumeGate"];
    for (const file of allSrcSources()) {
      const text = readFileSync(file, "utf-8");
      for (const needle of forbidden) {
        expect(
          text.includes(needle),
          `${file} references '${needle}' — restart/resume is gateway-only`,
        ).toBe(false);
      }
    }
  });

  it("the 'fleet-fallback-resume' restart fires from exactly one site: doFireFleetAutoFallback", () => {
    const text = readFileSync(GATEWAY_TS, "utf-8");

    // Exactly one CALL site passes the fleet-fallback-resume reason to
    // triggerSelfRestart (comments mentioning the string don't match this).
    const callRe = /triggerSelfRestart\([^)]*['"]fleet-fallback-resume['"]/g;
    const calls = [...text.matchAll(callRe)];
    expect(
      calls.length,
      "expected exactly one triggerSelfRestart(..., 'fleet-fallback-resume') call site in gateway.ts",
    ).toBe(1);

    // ...and that call site sits inside doFireFleetAutoFallback's body: after
    // the function's declaration and before the next top-level function decl.
    const fnStart = text.indexOf("async function doFireFleetAutoFallback");
    expect(fnStart, "doFireFleetAutoFallback declaration not found in gateway.ts").toBeGreaterThan(-1);
    const callIdx = calls[0]!.index!;
    expect(
      callIdx,
      "the fleet-fallback-resume restart call precedes doFireFleetAutoFallback — it moved",
    ).toBeGreaterThan(fnStart);
    const nextTopLevelFn = text.slice(fnStart + 1).search(/\n(?:async function |function |const \w+ = (?:async )?\(|class )/);
    expect(nextTopLevelFn, "could not find a declaration after doFireFleetAutoFallback").toBeGreaterThan(-1);
    const fnEndBound = fnStart + 1 + nextTopLevelFn;
    expect(
      callIdx,
      "the fleet-fallback-resume restart call escaped doFireFleetAutoFallback's body",
    ).toBeLessThan(fnEndBound);

    // Guard the guard: it is gated on the resume gate's verdict (single-flight
    // + staleness), so a 429 storm cannot loop-restart the agent.
    const body = text.slice(fnStart, fnEndBound);
    expect(body).toContain("fleetFallbackResumeGate.decide");
  });

  it("the resume gate module is consumed only by gateway.ts", () => {
    const pluginDir = join(REPO_ROOT, "telegram-plugin");
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "tests" || entry === "uat" || entry.startsWith(".")) continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { scan(p); continue; }
        if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
        if (p === GATEWAY_TS) continue;
        if (p.endsWith(join("telegram-plugin", "fleet-fallback-resume.ts"))) continue; // the module itself
        const text = readFileSync(p, "utf-8");
        if (/from\s+["'][^"']*fleet-fallback-resume(?:\.js)?["']/.test(text)) offenders.push(p);
      }
    };
    scan(pluginDir);
    expect(
      offenders,
      "fleet-fallback-resume gate imported outside gateway.ts — the restart decision must stay single-owner",
    ).toEqual([]);
  });
});
