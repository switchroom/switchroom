import { PostHog } from "posthog-node";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStatePath } from "../config/paths.js";

const DEFAULT_KEY = "phc_qKY87cKWZm6ZyCtk7LcRd2cU8Sg42u7Ywhui5stYCegd";
const DEFAULT_HOST = "https://us.i.posthog.com";

let client: PostHog | null = null;
let initialized = false;
let cachedDistinctId: string | null = null;
let globalHandlersInstalled = false;

function telemetryDisabled(): boolean {
  const v = process.env.SWITCHROOM_TELEMETRY_DISABLED;
  return v === "1" || v === "true";
}

export function getDistinctId(): string {
  if (cachedDistinctId) return cachedDistinctId;
  const path = resolveStatePath("analytics-id");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf-8").trim();
      if (existing) {
        cachedDistinctId = existing;
        return existing;
      }
    }
  } catch {
    // fall through to create a new id
  }
  const id = randomUUID();
  cachedDistinctId = id;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id, "utf-8");
  } catch {
    // non-fatal — we'll generate a fresh id next run
  }
  return id;
}

export function getPostHog(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  if (telemetryDisabled()) return null;
  const apiKey = process.env.SWITCHROOM_POSTHOG_KEY ?? DEFAULT_KEY;
  const host = process.env.SWITCHROOM_POSTHOG_HOST ?? DEFAULT_HOST;
  if (!apiKey) return null;
  try {
    client = new PostHog(apiKey, {
      host,
      // Short-lived CLI: send events immediately rather than batching.
      flushAt: 1,
      flushInterval: 0,
      // We install explicit process-level listeners in
      // `installGlobalErrorHandlers()` — autocapture only fires inside a
      // `withContext` scope, which the CLI rarely uses, so enabling it
      // would either do nothing useful or double-report when combined
      // with the manual listeners.
      enableExceptionAutocapture: false,
      // IP is considered PII in our telemetry policy. See docs/posthog.md.
      disableGeoip: true,
    });
  } catch {
    client = null;
  }
  return client;
}

export async function captureEvent(
  event: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const ph = getPostHog();
  if (!ph) return;
  try {
    await ph.captureImmediate({
      distinctId: getDistinctId(),
      event,
      properties,
    });
  } catch {
    // Telemetry must never break the CLI.
  }
}

export async function captureException(
  error: unknown,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const ph = getPostHog();
  if (!ph) return;
  try {
    await ph.captureExceptionImmediate(error, getDistinctId(), properties);
  } catch {
    // Telemetry must never break the CLI.
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown(2000);
  } catch {
    // ignore
  }
}

/**
 * Install process-level handlers for uncaught exceptions and unhandled
 * rejections so they're reported to PostHog before the process dies.
 *
 * Node's default `uncaughtException` behaviour is to exit as soon as the
 * listener returns, so a fire-and-forget `captureException(...)` would
 * abandon the HTTP request mid-flight. We explicitly await delivery (with
 * a short timeout so a broken network can't block the exit forever) and
 * then call `process.exit(1)` ourselves.
 *
 * `unhandledRejection` does NOT exit the process by default, but losing
 * visibility into it is just as bad, so we apply the same pattern.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;

  const FLUSH_TIMEOUT_MS = 2000;

  const flushWithTimeout = async (
    error: unknown,
    kind: "uncaughtException" | "unhandledRejection"
  ): Promise<void> => {
    await Promise.race([
      captureException(error, { kind }),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
  };

  process.on("uncaughtException", (err) => {
    // Write to stderr immediately so the user sees the error even if the
    // PostHog send hangs up to FLUSH_TIMEOUT_MS.
    // eslint-disable-next-line no-console
    console.error(err);
    void flushWithTimeout(err, "uncaughtException").finally(() => {
      process.exit(1);
    });
  });

  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error(reason);
    void flushWithTimeout(reason, "unhandledRejection");
  });
}
