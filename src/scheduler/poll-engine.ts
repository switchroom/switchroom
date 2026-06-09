/**
 * Tier-0 http-diff poll engine — docs/rfcs/cheap-cron-sessions.md §2.1.
 *
 * Model-free: fetch a URL, extract a cursor via a tiny JSONPath, compare
 * to the durable cursor. New cursor ⟹ a hit that escalates to a Tier-1
 * model fire; unchanged ⟹ no-op (HEARTBEAT_OK). All network is fenced by
 * poll-egress.ts (§6.1) and the fetch wrapper below (no-redirect, 5s
 * timeout, size cap, DNS-rebind pin). Deps are injected so the engine is
 * unit-tested without network/broker.
 */

import type { HttpDiffPollSchema } from "../config/schema.js";
import type { z } from "zod";
import { checkHttpDiffEgress, isBlockedAddress, normalizeHost, type EgressAllowlist } from "./poll-egress.js";

export type HttpDiffSpec = z.infer<typeof HttpDiffPollSchema>;

export interface HttpDiffDeps {
  /** injected for tests; the real one wraps global fetch. */
  fetchImpl: typeof fetch;
  /** resolve a vault secret by name via the in-container broker. */
  resolveSecret: (name: string) => Promise<string>;
  /** DNS lookup → resolved IP, for the rebind pin. Return null to skip the pin. */
  lookup: (host: string) => Promise<string | null>;
  allow: EgressAllowlist;
  now: () => number;
  /** Response body size cap (bytes). Default 1 MiB. */
  maxBytes?: number;
  /** Fetch timeout (ms). Default 5000. */
  timeoutMs?: number;
}

export interface PollOutcome {
  /** true ⟹ escalate; false ⟹ HEARTBEAT_OK (no model). */
  hit: boolean;
  /** When this is the FIRST poll for the key: record baseline, do NOT escalate. */
  baseline: boolean;
  /** New cursor to persist (present when hit or baseline). */
  cursor?: string;
  /** Human diff summary templated into the escalation prompt as {{diff}}. */
  diff?: string;
  /** Set ⟹ poll error (no escalation; one-shot operator notice + bounded retry). */
  error?: string;
}

// ── minimal JSONPath: $, .key, [*], [n] ────────────────────────────────
const TOKEN_RE = /\.([a-zA-Z0-9_]+)|\[(\*|\d+)\]/g;

export function extractLeaves(root: unknown, jsonpath: string): unknown[] {
  const path = jsonpath.startsWith("$") ? jsonpath.slice(1) : jsonpath;
  let nodes: unknown[] = [root];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(path)) !== null) {
    const key = m[1];
    const idx = m[2];
    const next: unknown[] = [];
    for (const node of nodes) {
      if (node == null) continue;
      if (key !== undefined) {
        if (typeof node === "object") next.push((node as Record<string, unknown>)[key]);
      } else if (idx === "*") {
        if (Array.isArray(node)) next.push(...node);
      } else if (idx !== undefined) {
        if (Array.isArray(node)) next.push(node[Number(idx)]);
      }
    }
    nodes = next;
  }
  return nodes.filter((n) => n !== undefined);
}

/** Reduce extracted leaves to a comparable cursor: numeric max, else count. */
export function cursorOf(leaves: unknown[]): { cursor: string; numeric: boolean; count: number } {
  const nums = leaves.map((l) => Number(l)).filter((n) => Number.isFinite(n));
  if (nums.length === leaves.length && nums.length > 0) {
    return { cursor: String(Math.max(...nums)), numeric: true, count: leaves.length };
  }
  // Non-numeric (or mixed): a count-based cursor detects "new items appeared".
  return { cursor: `n:${leaves.length}`, numeric: false, count: leaves.length };
}

function cursorAdvanced(prev: string | undefined, next: string, numeric: boolean): boolean {
  if (prev === undefined) return false; // first run handled by caller
  if (numeric) return Number(next) > Number(prev);
  return next !== prev;
}

function substituteSecrets(
  headers: Record<string, string>,
  secretValues: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\{\{([a-zA-Z0-9_\-/]+)\}\}/g, (_, name) => secretValues[name] ?? "");
  }
  return out;
}

export async function runHttpDiffPoll(
  spec: HttpDiffSpec,
  prevCursor: string | undefined,
  deps: HttpDiffDeps,
): Promise<PollOutcome> {
  // §6.1 gate BEFORE any network or secret resolution.
  const gate = checkHttpDiffEgress(spec.url, spec.secrets, deps.allow);
  if (!gate.ok) return { hit: false, baseline: false, error: `egress denied: ${gate.reason}` };

  const host = normalizeHost(new URL(spec.url).hostname);

  // DNS-rebind pin: resolve and re-check the IP against blocked ranges.
  try {
    const ip = await deps.lookup(host);
    if (ip && isBlockedAddress(ip)) return { hit: false, baseline: false, error: `resolved ip ${ip} blocked` };
  } catch (e) {
    return { hit: false, baseline: false, error: `dns lookup failed: ${(e as Error).message}` };
  }

  // Resolve secrets and inject into headers via {{name}} substitution.
  const secretValues: Record<string, string> = {};
  for (const name of spec.secrets) {
    try {
      secretValues[name] = await deps.resolveSecret(name);
    } catch (e) {
      return { hit: false, baseline: false, error: `secret ${name}: ${(e as Error).message}` };
    }
  }
  const headers = substituteSecrets(spec.headers ?? {}, secretValues);

  // Fenced fetch: no redirects, hard timeout, size cap.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  let json: unknown;
  try {
    const res = await deps.fetchImpl(spec.url, {
      method: spec.method,
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) return { hit: false, baseline: false, error: `http ${res.status}` };
    const text = await readCapped(res, deps.maxBytes ?? 1024 * 1024);
    json = JSON.parse(text);
  } catch (e) {
    return { hit: false, baseline: false, error: `fetch failed: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }

  const leaves = extractLeaves(json, spec.diff_jsonpath);
  const { cursor, numeric, count } = cursorOf(leaves);

  if (prevCursor === undefined) {
    // First run: baseline only, never escalate (the day-one-floods guard).
    return { hit: false, baseline: true, cursor };
  }
  if (cursorAdvanced(prevCursor, cursor, numeric)) {
    const diff = numeric
      ? `cursor ${cursor} > ${prevCursor} (${count} item(s))`
      : `${count} item(s), cursor ${prevCursor} → ${cursor}`;
    return { hit: true, baseline: false, cursor, diff };
  }
  return { hit: false, baseline: false, cursor };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`response ${buf.byteLength}B exceeds cap ${maxBytes}B`);
  return new TextDecoder().decode(buf);
}
