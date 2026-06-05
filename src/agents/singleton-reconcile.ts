/**
 * Singleton image reconciliation.
 *
 * The three switchroom singletons — `vault-broker`, `approval-kernel`,
 * and `switchroom-auth-broker` — are declared `depends_on` of every
 * agent. The documented staggered-rollout recipe (edit `release.pin` →
 * `switchroom apply` → per-agent `agent restart <name> --wait --force`)
 * regenerates the compose file with the new image tag on EVERY service,
 * but the only docker-touching command in that recipe is
 * `docker compose up -d --force-recreate --no-deps agent-<name>`. The
 * `--no-deps` flag (correct, so a routine bounce doesn't bounce the
 * brokers) means a pin bump recreates every agent while the singletons
 * stay frozen on whatever image they were last recreated at — silently,
 * until something needs the newer broker code.
 *
 * Real incident (2026-06-05): the auth-broker ran v0.14.24 for two
 * weeks while the fleet rolled to v0.14.66, so `/connect microsoft`
 * failed with "provider 'microsoft' is not registered" — the broker
 * code predated the Microsoft provider by 42 versions.
 *
 * This module detects when a singleton's running image differs from the
 * compose-pinned image and recreates only the drifted ones via plain
 * `up -d --no-deps <svc>`. It's drift-aware (a no-op when in sync, so
 * it's cheap to call on every restart) and the same detection backs a
 * `doctor` check so the drift surfaces even if nobody recreates.
 *
 * All IO is injectable so the logic is unit-testable without docker.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

/**
 * Compose SERVICE names for the singletons (note: the auth-broker
 * service is already `switchroom-`-prefixed in the generated compose,
 * the other two are not — see `src/agents/compose.ts`).
 */
export const SINGLETON_SERVICES = [
  "vault-broker",
  "approval-kernel",
  "switchroom-auth-broker",
] as const;

export type SingletonService = (typeof SINGLETON_SERVICES)[number];

/** Map a singleton service name to its container name. */
export function singletonContainerName(svc: string): string {
  return svc.startsWith("switchroom-") ? svc : `switchroom-${svc}`;
}

export interface SingletonDrift {
  service: SingletonService;
  container: string;
  /** Running container's image, or null when absent / probe failed. */
  running: string | null;
  /** Compose-pinned image, or null when the service has no `image:`
   *  (e.g. `--build-local` mode emits `build:` instead). */
  pinned: string | null;
  /** True when the container should be (re)created: pinned is known and
   *  differs from running (covers the absent case: running=null). */
  needsRecreate: boolean;
}

export interface SingletonReconcileDeps {
  /** Path to the generated docker-compose.yml. */
  composeFile: string;
  /** Read the compose file (default: fs.readFileSync utf-8). */
  readCompose?: (path: string) => string;
  /** Inspect a container's image, null if absent (default: docker inspect). */
  inspectImage?: (container: string) => string | null;
  /** Recreate one service: `docker compose up -d --no-deps <svc>`. */
  recreate?: (service: string) => void;
  /** Progress/diagnostic sink (default: stderr). */
  log?: (msg: string) => void;
  /** docker binary (default "docker"). */
  dockerBin?: string;
  /** compose project (default "switchroom"). */
  project?: string;
}

/**
 * Parse the compose file and return the pinned `image:` per singleton
 * service. Services with no `image:` (build-local) are omitted.
 */
export function readPinnedSingletonImages(
  composeText: string,
): Partial<Record<SingletonService, string>> {
  let doc: { services?: Record<string, { image?: unknown }> } | undefined;
  try {
    doc = parseYaml(composeText) as typeof doc;
  } catch {
    return {};
  }
  const out: Partial<Record<SingletonService, string>> = {};
  for (const svc of SINGLETON_SERVICES) {
    const img = doc?.services?.[svc]?.image;
    if (typeof img === "string" && img.length > 0) out[svc] = img;
  }
  return out;
}

function defaultInspectImage(dockerBin: string, container: string): string | null {
  try {
    const out = execFileSync(
      dockerBin,
      ["inspect", "-f", "{{.Config.Image}}", container],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    // Container absent or probe failed — treat as "not running this image".
    return null;
  }
}

/**
 * Compare each singleton's running image to the compose-pinned image.
 * Pure read — no recreation. Backs both `reconcileSingletons` and the
 * `doctor` drift check.
 */
export function detectSingletonDrift(
  deps: SingletonReconcileDeps,
): SingletonDrift[] {
  const dockerBin = deps.dockerBin ?? "docker";
  const readCompose = deps.readCompose ?? ((p) => readFileSync(p, "utf-8"));
  const inspectImage =
    deps.inspectImage ?? ((c) => defaultInspectImage(dockerBin, c));

  let pinned: Partial<Record<SingletonService, string>> = {};
  try {
    pinned = readPinnedSingletonImages(readCompose(deps.composeFile));
  } catch {
    pinned = {};
  }

  return SINGLETON_SERVICES.map((service) => {
    const container = singletonContainerName(service);
    const running = inspectImage(container);
    const pin = pinned[service] ?? null;
    // Recreate when we KNOW the pinned image and it differs from what's
    // running (running=null → absent → also needs bring-up). When the
    // compose has no image (build-local), pin is null → never flagged.
    const needsRecreate = pin !== null && running !== pin;
    return { service, container, running, pinned: pin, needsRecreate };
  });
}

function defaultRecreate(
  dockerBin: string,
  project: string,
  composeFile: string,
  service: string,
): void {
  // Plain `up -d --no-deps <svc>` (NOT --force-recreate): compose
  // recreates only because the image: line changed, and we've already
  // confirmed drift. --no-deps so we don't recursively bounce agents.
  execFileSync(
    dockerBin,
    ["compose", "-p", project, "-f", composeFile, "up", "-d", "--no-deps", service],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  );
}

export interface ReconcileResult {
  drift: SingletonDrift[];
  recreated: SingletonService[];
  /** Services that drifted but whose recreate threw (best-effort). */
  failed: { service: SingletonService; error: string }[];
}

/**
 * Recreate any singleton whose running image drifted from the
 * compose-pinned image. Best-effort: a recreate failure is logged and
 * collected, never thrown, so it can't fail the agent restart it's
 * piggy-backing on. Returns what drifted / was recreated / failed.
 */
export function reconcileSingletons(
  deps: SingletonReconcileDeps,
): ReconcileResult {
  const dockerBin = deps.dockerBin ?? "docker";
  const project = deps.project ?? "switchroom";
  const log = deps.log ?? ((m) => process.stderr.write(m + "\n"));
  const recreate =
    deps.recreate ??
    ((svc: string) => defaultRecreate(dockerBin, project, deps.composeFile, svc));

  const drift = detectSingletonDrift(deps);
  const recreated: SingletonService[] = [];
  const failed: { service: SingletonService; error: string }[] = [];

  for (const d of drift) {
    if (!d.needsRecreate) continue;
    log(
      `singleton-reconcile: ${d.service} drift ${d.running ?? "<absent>"} → ${d.pinned} — recreating`,
    );
    try {
      recreate(d.service);
      recreated.push(d.service);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`singleton-reconcile: ${d.service} recreate FAILED: ${msg}`);
      failed.push({ service: d.service, error: msg });
    }
  }

  return { drift, recreated, failed };
}
