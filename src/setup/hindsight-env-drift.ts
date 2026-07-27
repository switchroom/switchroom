/**
 * Detect environment that a Hindsight **recreate** is about to throw away.
 *
 * ## The bug this exists to make impossible
 *
 * `switchroom memory setup --recreate` removes the running container and
 * launches a new one whose env is rebuilt from scratch, from exactly two
 * sources: the operator's `hindsight.env` block in switchroom.yaml, and the
 * managed defaults in `src/setup/hindsight-perf-defaults.ts` /
 * `hindsight-pg-defaults.ts`. Anything that was set on the live container but
 * exists in NEITHER source is dropped — with no error, no warning and no diff.
 *
 * That is not hypothetical. It has bitten three times, and switchroom.yaml on
 * the dev fleet carries hand-written comment blocks for the first two ("existed
 * ONLY in the imperative recreate script", "existed NOWHERE in declarative
 * config"). The third, 2026-07-28, dropped
 * `HINDSIGHT_API_RERANKER_LOCAL_FP16=true` and
 * `HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128` off the live container. Without
 * FP16 the local cross-encoder reranks in fp32 — roughly 2x the time per
 * candidate on the *interactive* recall path. It was caught only because the
 * operator happened to take a `docker inspect` snapshot immediately before the
 * recreate and diffed `Config.Env` afterwards. Nobody would catch that
 * normally, which is the whole problem: a silent revert reads as "nothing
 * happened".
 *
 * ## Why detection, and NOT auto-carry-over
 *
 * The obvious "fix" is to copy the unknown vars onto the new container. That is
 * worse. It makes the imperative value permanent and *still* invisible: the
 * container drifts further from the declarative config on every recreate,
 * nothing ever lands in switchroom.yaml, and the next operator reading the yaml
 * still has a false picture. It also silently resurrects env an operator
 * deliberately removed.
 *
 * So this module reports and refuses to guess. The operator gets the key names
 * and their live values in a paste-ready form; putting them in `hindsight.env`
 * is a deliberate act, and after that the value is durable *and* legible.
 *
 * ## Why the image baseline matters
 *
 * A container's `Config.Env` is image env plus `-e` flags, undifferentiated:
 * `PATH`, `LANG`, `PYTHON_VERSION`, `HOME` and friends all appear there and are
 * in none of switchroom's computed pairs. Diffing naively would report ~20
 * phantom drops on every recreate, and a warning that always fires is a warning
 * nobody reads. Subtracting the *image's* own `Config.Env` — by exact `K=V`
 * identity, not by key — removes the inherited entries while still reporting an
 * image var that switchroom or an operator had OVERRIDDEN, since that override
 * really would be lost.
 *
 * Everything here is pure. The docker reads live in `hindsight.ts`
 * (`getHindsightContainerEnv`, `getHindsightImageEnv`) and the rendering
 * decision lives in `src/cli/memory.ts`.
 */

import {
  HINDSIGHT_PERF_DEFAULTS_GPU,
  HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM,
} from "./hindsight-perf-defaults.js";

/** One env var present on the live container and absent from the next one. */
export interface DroppedHindsightEnv {
  key: string;
  /** The value the LIVE container is running with. Redacted if secret-shaped. */
  value: string;
  /** True when {@link value} was redacted; the real value is never surfaced. */
  redacted: boolean;
}

/**
 * Keys whose values must never reach a console or a log.
 *
 * `ANTHROPIC_CUSTOM_HEADERS` is the concrete hazard: `startHindsight` puts the
 * LiteLLM API key inside it, so an unredacted "here is what you're dropping"
 * dump would print a live credential into the operator's terminal and into
 * whatever captures `switchroom update`'s output. Matched on the KEY, which is
 * the part we can reason about — a value-shaped heuristic would both miss and
 * over-trigger.
 */
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|HEADERS|AUTH)/i;

/** Placeholder printed instead of a secret-shaped value. */
export const REDACTED_ENV_VALUE = "<redacted — read it from `docker inspect`>";

/**
 * Parse a docker `Config.Env` array (`["K=V", …]`) into a map.
 *
 * Two details that matter: a value may itself contain `=` (split on the FIRST
 * one only), and docker keeps duplicates in the slice while the process sees
 * the LAST one — so a later entry wins here too. An entry with no `=` is
 * malformed and skipped rather than becoming a key with an empty value.
 */
export function parseDockerEnvList(env: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return out;
}

/**
 * Env vars live on the container that the next launch will NOT set.
 *
 * @param liveEnv     `Config.Env` of the running container.
 * @param nextEnv     The pairs the next launch will pass (`hindsightContainerEnvPairs`).
 * @param imageEnv    `Config.Env` of the image the live container was built
 *                    from. An entry matching the image EXACTLY (key and value)
 *                    is inherited, not configured, so it is not a drop.
 * @returns Sorted by key, so output is stable and diffable.
 */
export function diffDroppedHindsightEnv(
  liveEnv: readonly string[],
  nextEnv: ReadonlyArray<readonly [string, string]>,
  imageEnv: readonly string[] = [],
): DroppedHindsightEnv[] {
  const live = parseDockerEnvList(liveEnv);
  const image = parseDockerEnvList(imageEnv);
  const next = new Set(nextEnv.map(([k]) => k));

  const dropped: DroppedHindsightEnv[] = [];
  for (const [key, value] of live) {
    if (next.has(key)) continue;
    // Inherited from the image unchanged ⇒ the new container inherits it too.
    if (image.has(key) && image.get(key) === value) continue;
    const redacted = SECRET_KEY_PATTERN.test(key);
    dropped.push({ key, value: redacted ? REDACTED_ENV_VALUE : value, redacted });
  }
  return dropped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Capability gate a managed default sits behind, when it sits behind one. */
export type HindsightEnvGate = "gpu" | "localLlm";

const GATED_KEYS = new Map<string, HindsightEnvGate>([
  ...HINDSIGHT_PERF_DEFAULTS_GPU.map(([k]) => [k, "gpu"] as const),
  ...HINDSIGHT_PERF_DEFAULTS_LOCAL_LLM.map(([k]) => [k, "localLlm"] as const),
]);

/**
 * Why a key is being dropped, when switchroom can actually tell.
 *
 * A dropped key that switchroom MANAGES behind a capability gate is a very
 * different incident from a key switchroom has never heard of: it means the
 * host failed to prove the capability this run, so the managed default was
 * withheld. That is exactly what happened on 2026-07-28 — the two reranker keys
 * are GPU-gated managed defaults, and the GPU verdict did not resolve, so they
 * silently reverted to upstream's CPU values. Saying so converts a mystery into
 * a diagnosis; leaving it out sends the operator hunting in the wrong file.
 */
export function explainDroppedHindsightEnv(
  key: string,
  caps: { gpu: boolean; localLlm: boolean },
): string | null {
  const gate = GATED_KEYS.get(key);
  if (!gate) return null;
  const proven = gate === "gpu" ? caps.gpu : caps.localLlm;
  if (proven) return null;
  return gate === "gpu"
    ? "switchroom manages this key as a GPU-gated default, but this host did not prove a usable GPU this run (host-capabilities.json unreadable/absent, or no nvidia-container-toolkit), so the default was withheld"
    : "switchroom manages this key as a local-LLM-gated default, but the configured LLM endpoint did not resolve as local this run, so the default was withheld";
}

/**
 * Render the operator-facing report for a set of dropped keys.
 *
 * Returns plain lines (no colour, no chalk) so it is equally usable from the
 * CLI, a log, and a test assertion. Empty array ⇒ nothing to report.
 *
 * The yaml block is deliberately paste-ready: the recovery action is "put these
 * in `hindsight.env`", and an operator who has to retype eight keys from a
 * prose paragraph will skip one.
 */
export function formatDroppedHindsightEnvReport(
  dropped: readonly DroppedHindsightEnv[],
  caps: { gpu: boolean; localLlm: boolean },
): string[] {
  if (dropped.length === 0) return [];
  const n = dropped.length;
  const lines: string[] = [
    `⚠  ENV DRIFT: ${n} environment variable${n === 1 ? "" : "s"} set on the running ` +
      `switchroom-hindsight container ${n === 1 ? "is" : "are"} NOT in the env this recreate will launch with.`,
    "   They were set imperatively (a hand `docker run`, a `docker update`, an ad-hoc script)",
    "   and exist in neither `hindsight.env` in switchroom.yaml nor switchroom's managed defaults,",
    "   so this recreate WILL drop them. switchroom does not carry them over: that would keep the",
    "   value invisible instead of making it durable.",
    "",
  ];
  for (const { key, value, redacted } of dropped) {
    lines.push(`   - ${key}=${value}`);
    const why = explainDroppedHindsightEnv(key, caps);
    if (why) lines.push(`       ${why}.`);
    if (redacted) lines.push("       (value withheld: secret-shaped key)");
  }
  lines.push(
    "",
    "   To keep them, add to switchroom.yaml before recreating:",
    "",
    "     hindsight:",
    "       env:",
  );
  for (const { key, value, redacted } of dropped) {
    lines.push(`         ${key}: ${redacted ? "<value>" : JSON.stringify(value)}`);
  }
  lines.push(
    "",
    "   Only keys switchroom manages are honoured there — `switchroom doctor` flags the rest.",
    "   Re-run with --strict-env to refuse the recreate instead of warning.",
  );
  return lines;
}
