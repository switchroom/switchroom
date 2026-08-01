/**
 * Example switchroom.yaml configs, EMBEDDED IN THE BINARY.
 *
 * `import.meta.dirname` resolves to `/$bunfs/root` inside a `bun build
 * --compile` artifact, so `resolve(import.meta.dirname, "../../examples/…")`
 * points at `/examples/…` on the host — a path that does not exist. `apply
 * --example` was fixed by embedding the YAML as `with { type: "text" }`
 * imports; `setup`'s bootstrap path (`copyExampleConfig`) still read from disk
 * and therefore died with "Example config not found" on any static-binary
 * install, which is the first thing a `curl | sh` user runs (#4163).
 *
 * These live here, in one module, rather than in `apply.ts`, so there is
 * exactly one answer to "where do the examples come from" and a second call
 * site cannot re-introduce the disk read. They are deliberately NOT part of the
 * shipped-asset payload (scripts/build-asset-payload.mjs): text imports are
 * compiled in, and shipping a payload directory nothing reads is how a payload
 * silently rots.
 */

import switchroomExample from "../../examples/switchroom.yaml" with { type: "text" };
import minimalExample from "../../examples/minimal.yaml" with { type: "text" };

/** Embedded example configs, keyed by name. Mirrors files under examples/. */
export const EMBEDDED_EXAMPLES: Record<string, string> = {
  switchroom: switchroomExample,
  minimal: minimalExample,
};

/** The example `switchroom setup --non-interactive` bootstraps from. */
export const DEFAULT_EXAMPLE = "switchroom";

/** Names available to `--example` / the setup prompt, in stable order. */
export function exampleNames(): string[] {
  return Object.keys(EMBEDDED_EXAMPLES);
}

/**
 * The YAML for `name`, or `null` if there is no such example.
 *
 * Returns the embedded copy. There is no disk fallback: a contributor adding
 * `examples/foo.yaml` adds it here too, and that is a compile-time edit rather
 * than a runtime probe that behaves differently in dev and in the release
 * binary — which is exactly the divergence that hid this bug.
 */
export function readEmbeddedExample(name: string): string | null {
  return EMBEDDED_EXAMPLES[name] ?? null;
}
