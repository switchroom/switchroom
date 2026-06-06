/**
 * Compute (and schema-validate) a proposed switchroom.yaml edit WITHOUT
 * writing it.
 *
 * The dashboard never writes the config itself — that would be a
 * self-elevation hole (an agent on host networking can forge the
 * dashboard's loopback auth; see config-diff.ts / the connection-access
 * handler). Instead it computes the edited YAML here, turns it into a
 * unified diff, and proposes it to hostd, which raises a Telegram
 * Allow/Deny card and is the SOLE writer. This module is the
 * compute-and-validate half: read current → apply a comment-preserving
 * YAML transform → parse + `SwitchroomConfigSchema` the result (the same
 * gate the loader runs) so an obviously-broken edit is rejected BEFORE
 * the operator is bothered with a card. No write, no lock.
 */

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { SwitchroomConfigSchema } from "../config/schema.js";

export class ConfigPlanError extends Error {}

/** A pure YAML-text transform (string in → string out). */
export type YamlTransform = (yamlText: string) => string;

export interface ConfigEditPlan {
  /** Current on-disk YAML. */
  before: string;
  /** Edited YAML (schema-valid). Equal to `before` when the transform
   *  was a no-op (already in the desired state). */
  after: string;
  /** False when after === before (nothing to propose). */
  changed: boolean;
}

/** Compose several transforms into one (applied left to right). */
export function composeTransforms(...transforms: YamlTransform[]): YamlTransform {
  return (text) => transforms.reduce((acc, t) => t(acc), text);
}

/**
 * Read `configPath`, apply `transform`, and validate the result against
 * the config schema. Returns the before/after text + whether it changed.
 * Throws {@link ConfigPlanError} (transform/parse/schema failure) — the
 * file is never touched.
 */
export function planConfigEdit(
  configPath: string,
  transform: YamlTransform,
): ConfigEditPlan {
  let before: string;
  try {
    before = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new ConfigPlanError(`could not read config: ${(err as Error).message}`);
  }

  let after: string;
  try {
    after = transform(before);
  } catch (err) {
    throw new ConfigPlanError(`config edit failed: ${(err as Error).message}`);
  }

  if (after === before) {
    return { before, after, changed: false };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(after);
  } catch (err) {
    throw new ConfigPlanError(
      `edit produced unparseable YAML: ${(err as Error).message}`,
    );
  }
  const check = SwitchroomConfigSchema.safeParse(parsed);
  if (!check.success) {
    throw new ConfigPlanError(
      `edit produced an invalid config: ${check.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return { before, after, changed: true };
}
