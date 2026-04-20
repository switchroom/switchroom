/**
 * OpenTelemetry log forwarding to PostHog Logs.
 *
 * Gated on `SWITCHROOM_LOGS_ENABLED=1` because OpenTelemetry pulls several
 * MB of dependencies and only the long-running surfaces (web server, agent
 * runtimes) benefit from centralised logs. Short-lived CLI commands should
 * leave this disabled.
 *
 * Usage:
 *   import { initLogs, getLogger, shutdownLogs } from "./logs.js";
 *   initLogs("switchroom-web");
 *   const log = getLogger();
 *   log.emit({ severityText: "info", body: "server started", attributes: { port: 3000 } });
 *   // ... before exit: await shutdownLogs();
 */
import type { NodeSDK as NodeSDKType } from "@opentelemetry/sdk-node";
import type { Logger } from "@opentelemetry/api-logs";

const DEFAULT_KEY = "phc_qKY87cKWZm6ZyCtk7LcRd2cU8Sg42u7Ywhui5stYCegd";
const DEFAULT_HOST = "https://us.i.posthog.com";

let sdk: NodeSDKType | null = null;
let initialized = false;

function logsEnabled(): boolean {
  const v = process.env.SWITCHROOM_LOGS_ENABLED;
  return v === "1" || v === "true";
}

export async function initLogs(serviceName: string): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (!logsEnabled()) return;

  const apiKey = process.env.SWITCHROOM_POSTHOG_KEY ?? DEFAULT_KEY;
  const host = process.env.SWITCHROOM_POSTHOG_HOST ?? DEFAULT_HOST;
  if (!apiKey) return;

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPLogExporter } = await import(
      "@opentelemetry/exporter-logs-otlp-http"
    );
    const { BatchLogRecordProcessor } = await import(
      "@opentelemetry/sdk-logs"
    );
    const { resourceFromAttributes } = await import(
      "@opentelemetry/resources"
    );

    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": serviceName,
      }),
      logRecordProcessor: new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${host.replace(/\/$/, "")}/i/v1/logs`,
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        })
      ),
    });
    sdk.start();
  } catch {
    sdk = null;
  }
}

export async function getLogger(name = "switchroom"): Promise<Logger | null> {
  if (!sdk) return null;
  try {
    const { logs } = await import("@opentelemetry/api-logs");
    return logs.getLogger(name);
  } catch {
    return null;
  }
}

export async function shutdownLogs(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // ignore
  }
  sdk = null;
}
