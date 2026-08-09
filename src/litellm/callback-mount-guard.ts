/**
 * LiteLLM custom-callback mount coherence.
 *
 * `litellm-config.yaml` can name a *custom* callback as `<module>.<attr>` (we
 * run exactly one: `custom_pacing.pacer_instance`, the fleet request pacer).
 * LiteLLM resolves that with `importlib.import_module("<module>")` during
 * startup, so the module file MUST be bind-mounted into the proxy container or
 * the process aborts its lifespan with `ModuleNotFoundError` and crash-loops.
 * There is no degraded mode: the proxy never serves a request.
 *
 * That coupling has no enforcement point on the host, and it broke the fleet on
 * 2026-08-09. Coolify regenerates the deployed `docker-compose.yml` from
 * `services.docker_compose_raw` in its own database on every deploy. The pacer
 * and passthrough-patch mounts had only ever been hand-added to the GENERATED
 * file, so the v1.91.0 → v1.95.0 image bump silently dropped both, and the
 * proxy crash-looped with `No module named 'custom_pacing'` until the mounts
 * were restored in `docker_compose_raw` (the actual generator source).
 *
 * This module is the pure detection core for that invariant:
 *
 *   config declares a custom callback module  ⇒  compose mounts that module
 *
 * A violation means the proxy is already down, or is a landmine that detonates
 * on its next restart (the running container can still hold a mount the
 * regenerated compose no longer declares). Either way it belongs in the ledger
 * loudly, not in a 40-minute outage nobody can explain.
 *
 * STRICTLY PURE: text and parsed YAML in, violations out. No fs, no network.
 */

import { parse as parseYaml } from "yaml";

/** Where the proxy's config dir lands in the container. It is the process CWD
 *  and therefore on `sys.path`, which is why a bare `<module>.py` there is
 *  importable as `<module>`. */
export const CONTAINER_APP_DIR = "/app";

/** Basename of the deployed compose file Coolify regenerates, sibling to the
 *  live `litellm-config.yaml` in the same Coolify service directory. */
export const LIVE_COMPOSE_BASENAME = "docker-compose.yml";

/** The config keys that can carry callback references. `callbacks` is the one
 *  we use; the other two are accepted so a future move between them cannot
 *  silently drop the check. */
const CALLBACK_KEYS = ["callbacks", "success_callback", "failure_callback"] as const;

/**
 * Whether the compose could be read well enough to judge its mounts at all.
 * Lets the caller log a visible SKIP for "cannot tell" instead of an
 * affirmative OK — an unreadable artifact reported as a pass is the exact
 * silent-green failure this sensor exists to prevent.
 */
export function canReadComposeMounts(composeText: string | null): boolean {
  if (composeText == null) return false;
  return extractComposeBindTargets(composeText) !== null;
}

export interface MissingCallbackMount {
  /** The python module name that must be importable (e.g. `custom_pacing`). */
  module: string;
  /** The full callback reference as written in the config. */
  reference: string;
  /** The container path the module must be mounted at. */
  expectedTarget: string;
  /** Human-readable explanation for the ledger finding. */
  detail: string;
}

/**
 * Pull the custom callback MODULE names out of a parsed LiteLLM config.
 *
 * LiteLLM's built-in callbacks are bare tokens (`prometheus`, `datadog`,
 * `langfuse`) and need no mount. A custom one is an instance reference,
 * `<module>.<attr>` — the dot is what distinguishes them. Only the first
 * segment is the importable module; a dotted package (`pkg.mod.attr`) cannot be
 * satisfied by a single-file bind mount, so it is deliberately not reported
 * here (it would be a different deployment shape entirely).
 */
export function extractCustomCallbackModules(parsed: unknown): { module: string; reference: string }[] {
  const settings = (parsed as { litellm_settings?: unknown } | null)?.litellm_settings;
  if (settings == null || typeof settings !== "object") return [];

  const out: { module: string; reference: string }[] = [];
  const seen = new Set<string>();

  for (const key of CALLBACK_KEYS) {
    const raw = (settings as Record<string, unknown>)[key];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const reference = entry.trim();
      const parts = reference.split(".");
      // Bare token → built-in callback, nothing to mount.
      // More than one dot → a package path, not a single-file mount.
      if (parts.length !== 2) continue;
      const [module, attr] = parts;
      if (!module || !attr) continue;
      if (seen.has(module)) continue;
      seen.add(module);
      out.push({ module, reference });
    }
  }
  return out;
}

/**
 * Collect every bind-mount TARGET declared anywhere in a compose file.
 *
 * Coolify emits the short string form (`'host/path:/container/path'`) in the
 * generated file while its `docker_compose_raw` source uses the long object
 * form (`{type: bind, source, target}`); both appear in practice, so both are
 * read.
 *
 * Returns `null` for "cannot tell" — unparseable YAML, or no `services`
 * mapping — as distinct from an EMPTY SET, which is the real and dangerous
 * state of "this compose declares no mounts at all". Collapsing those two was
 * the near-miss in review: Coolify regeneration drops the whole hand-added
 * `volumes:` block, not a single line, so an empty set is precisely the outage
 * shape and must be reported, while `null` must stay quiet.
 */
export function extractComposeBindTargets(composeText: string): Set<string> | null {
  const targets = new Set<string>();
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch {
    return null;
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (services == null || typeof services !== "object") return null;

  for (const svc of Object.values(services as Record<string, unknown>)) {
    const volumes = (svc as { volumes?: unknown } | null)?.volumes;
    if (!Array.isArray(volumes)) continue;
    for (const v of volumes) {
      if (typeof v === "string") {
        // 'source:target' or 'source:target:ro' — the target is the second
        // colon-separated field. Windows drive letters are not a case here.
        const parts = v.split(":");
        if (parts.length >= 2 && parts[1]) targets.add(parts[1].trim());
      } else if (v != null && typeof v === "object") {
        const t = (v as { target?: unknown }).target;
        if (typeof t === "string" && t) targets.add(t.trim());
      }
    }
  }
  return targets;
}

/**
 * The invariant: every custom callback module named by the config is mounted
 * into the container at `/app/<module>.py`.
 *
 * Yields no violations when the compose is absent or unreadable — claiming a
 * violation we cannot substantiate would be worse than staying quiet. Use
 * `canReadComposeMounts` to tell that apart from a genuine pass, so the caller
 * can log a visible SKIP instead of an affirmative OK.
 *
 * A compose that parses but declares NO mounts is NOT "cannot tell" — it is a
 * violation, and the worst-case shape of the 2026-08-09 regression.
 */
export function detectMissingCallbackMounts(
  parsedConfig: unknown,
  composeText: string | null,
): MissingCallbackMount[] {
  const modules = extractCustomCallbackModules(parsedConfig);
  if (modules.length === 0 || composeText == null) return [];

  const targets = extractComposeBindTargets(composeText);
  if (targets === null) return [];

  const violations: MissingCallbackMount[] = [];
  for (const { module, reference } of modules) {
    const expectedTarget = `${CONTAINER_APP_DIR}/${module}.py`;
    if (targets.has(expectedTarget)) continue;
    violations.push({
      module,
      reference,
      expectedTarget,
      detail:
        `litellm_settings names custom callback '${reference}' but no bind mount targets ` +
        `${expectedTarget} — the proxy will abort startup with ` +
        `ModuleNotFoundError: No module named '${module}'. Coolify regenerates this compose ` +
        `from services.docker_compose_raw in its database, so the mount must be restored THERE ` +
        `(a hand edit to the generated file is wiped on the next deploy).`,
    });
  }
  return violations;
}
