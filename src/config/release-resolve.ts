/**
 * Release block → docker image tag resolver for the update flow.
 *
 * Pure function. The compose generator + the update CLI both call this
 * to convert a `release` block (either a channel pointer or a build
 * pin) into a single docker image tag string suffix.
 *
 * Resolution rules:
 *   - `{pin: "sha-abc1234"}` → `"sha-abc1234"` (literal pin wins)
 *   - `{pin: "v0.11.1"}`     → `"v0.11.1"`
 *   - `{channel: "dev"}`     → `"dev"`
 *   - `{channel: "rc"}`      → `"rc"`
 *   - `{channel: "latest"}`  → `"latest"`
 *   - `undefined`            → `"latest"` (back-compat default)
 *
 * Mutual exclusion of channel vs pin is enforced by ReleaseBlock's
 * Zod refinement upstream, so we don't re-check here.
 */

export interface ReleaseBlockShape {
  channel?: "dev" | "rc" | "latest";
  pin?: string;
}

/** Resolve a release block to its docker image tag suffix. */
export function resolveImageTag(release: ReleaseBlockShape | undefined): string {
  if (!release) return "latest";
  if (release.pin) return release.pin;
  if (release.channel) return release.channel;
  return "latest";
}

/**
 * Resolve the effective release block for a single apply / update run.
 *
 * Priority (highest first):
 *   1. CLI flag override (`--channel` / `--pin` on apply / update)
 *   2. Per-agent `release` block (REPLACES root entirely per schema)
 *   3. Root `release` block
 *   4. `{channel: "latest"}` (back-compat default — equiv to undefined)
 *
 * Per-agent vs root: PR A's schema specifies per-agent REPLACES root
 * entirely (no field merge). This helper preserves that contract — the
 * caller passes either the per-agent block (if present) OR the root
 * block, not both.
 */
export function resolveRelease(opts: {
  override?: ReleaseBlockShape;
  perAgent?: ReleaseBlockShape;
  root?: ReleaseBlockShape;
}): ReleaseBlockShape | undefined {
  if (opts.override) return opts.override;
  if (opts.perAgent) return opts.perAgent;
  if (opts.root) return opts.root;
  return undefined;
}
