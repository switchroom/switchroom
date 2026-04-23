/**
 * Timezone resolution for switchroom agents.
 *
 * Switchroom agents are long-lived Claude Code processes. Their inbound
 * prompts carry UTC timestamps (Telegram channel messages, scheduled
 * task triggers, session-start greetings). Without a local-time hint,
 * the LLM takes UTC as "now" and reasons wrong by up to a day at the
 * extremes — fine for a server-to-server bot, catastrophic for a
 * personal-assistant agent saying "good morning" at 10pm local.
 *
 * The resolver is a plain four-step cascade with server detection as
 * the final fallback. No I/O when an explicit value is present at any
 * cascade layer, and server detection is cheap (one file read plus a
 * readlink in the worst case). Pure function except for the probe
 * callbacks, which are injected for tests.
 *
 * Resolution order:
 *   1. agent.timezone        (explicit per-agent override)
 *   2. profile.timezone      (inherited via `extends:`)
 *   3. switchroom.timezone   (global default)
 *   4. server detection      (/etc/timezone → /etc/localtime → "UTC")
 *
 * The resolver intentionally does NOT read switchroom.defaults.timezone
 * because the full defaults-profile-agent merge has already happened
 * by the time the resolved AgentConfig arrives here — the defaults
 * value, if present, is already on agent.timezone via the cascade.
 *
 * Server detection on Linux checks /etc/timezone first (Debian / Ubuntu
 * convention). If that's missing, /etc/localtime is typically a symlink
 * into the zoneinfo database — we readlink it and extract the zone name
 * from the tail of the path (…/zoneinfo/Australia/Melbourne → the last
 * two segments). Both are best-effort and the final fallback is "UTC".
 */

import { readFileSync, readlinkSync } from "node:fs";
import type { AgentConfig, SwitchroomConfig } from "./schema.js";

export interface ResolveTimezoneOpts {
  /**
   * Read /etc/timezone (or equivalent). Return the trimmed string or
   * undefined if unavailable. Exposed for tests — production callers
   * never pass this.
   */
  readEtcTimezone?: () => string | undefined;
  /**
   * Read /etc/localtime as a symlink. Return the symlink target or
   * undefined if it isn't a symlink / doesn't exist. Exposed for tests.
   */
  readLocaltimeLink?: () => string | undefined;
}

function defaultReadEtcTimezone(): string | undefined {
  try {
    const raw = readFileSync("/etc/timezone", "utf-8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function defaultReadLocaltimeLink(): string | undefined {
  try {
    return readlinkSync("/etc/localtime");
  } catch {
    return undefined;
  }
}

/**
 * Extract the IANA zone name from a /etc/localtime symlink target.
 *
 * A typical link points at something like
 * `/usr/share/zoneinfo/Australia/Melbourne` or
 * `../usr/share/zoneinfo/America/Argentina/Buenos_Aires`. We take the
 * tail after `zoneinfo/` which covers both two- and three-segment
 * zones (Region/City and Region/Sub/City).
 *
 * Returns undefined when the target doesn't contain a `zoneinfo/`
 * segment, rather than returning something that will fail validation
 * downstream.
 */
export function extractZoneFromLocaltimeLink(target: string): string | undefined {
  const marker = "zoneinfo/";
  const idx = target.indexOf(marker);
  if (idx < 0) return undefined;
  const tail = target.slice(idx + marker.length);
  return tail.length > 0 ? tail : undefined;
}

/**
 * Probe the host for its configured timezone, returning "UTC" only as
 * the last resort. See file header for the cascade order the rest of
 * the resolver walks before falling here.
 */
export function detectServerTimezone(
  opts: ResolveTimezoneOpts = {},
): string {
  const readEtc = opts.readEtcTimezone ?? defaultReadEtcTimezone;
  const readLink = opts.readLocaltimeLink ?? defaultReadLocaltimeLink;

  const fromEtc = readEtc();
  if (fromEtc) return fromEtc;

  const linkTarget = readLink();
  if (linkTarget) {
    const extracted = extractZoneFromLocaltimeLink(linkTarget);
    if (extracted) return extracted;
  }

  return "UTC";
}

/**
 * Resolve an agent's effective timezone.
 *
 * Cascade: agent → profile-merged-in → switchroom.timezone → server
 * detection → "UTC". All but the first branch are handled implicitly:
 * by the time mergeAgentConfig + resolveAgentConfig have run on the
 * input, any profile-level or defaults-level timezone has already
 * landed on `resolvedAgent.timezone`. This function just layers the
 * global `switchroom.timezone` on top (which is NOT merged through the
 * agent cascade because it lives on the root block, not in defaults/
 * profile) and then falls back to server detection.
 */
export function resolveTimezone(
  config: SwitchroomConfig,
  resolvedAgent: AgentConfig,
  opts: ResolveTimezoneOpts = {},
): string {
  if (resolvedAgent.timezone) return resolvedAgent.timezone;
  // `switchroom` is required by SwitchroomConfigSchema, but a handful of
  // older test fixtures cast partial literals to SwitchroomConfig without
  // the root block. Tolerate the undefined read rather than breaking them.
  const global = config.switchroom?.timezone;
  if (global) return global;
  return detectServerTimezone(opts);
}

/**
 * Classify the cascade layer that produced the resolved timezone.
 *
 * Used by reconcile to decide whether to warn. We warn ONLY when the
 * resolved zone is UTC AND no explicit override appears in any config
 * layer — i.e. the result came from server detection and happens to be
 * UTC, which on most container hosts is a platform default rather than
 * a real expression of the user's locale.
 */
export type TimezoneSource = "agent" | "global" | "detected";

export function classifyTimezoneSource(
  config: SwitchroomConfig,
  resolvedAgent: AgentConfig,
): TimezoneSource {
  if (resolvedAgent.timezone) return "agent";
  if (config.switchroom?.timezone) return "global";
  return "detected";
}
