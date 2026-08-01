/**
 * `switchroom doctor` section: the shipped-asset payload (#4163).
 *
 * A `bun build --compile` binary embeds only the JS bundle. `profiles/`,
 * `skills/`, `vendor/hindsight-memory/` and the web `ui/` are NOT in it, so a
 * `curl … | sh` install fetches them as a separate release artifact and stages
 * them at `<prefix>/share/switchroom`. Two failure modes follow, and both are
 * silent without a check:
 *
 *   MISSING   — no payload at all. `switchroom apply` dies with "Profile not
 *               found: default (searched …)" and `sync-bundled-skills` used to
 *               no-op while still reporting success (#4160/#4161).
 *   SKEWED    — payload from a different release than the running CLI. This is
 *               the WORSE one: everything appears to work while agents are
 *               scaffolded from templates the CLI no longer matches. It cannot
 *               arise from `switchroom update` (the payload is installed first,
 *               from the same tag, and repaired on every run — see
 *               `installAssetPayload`), so seeing it here means something
 *               outside that path touched the share directory.
 *
 * Scope: this only applies to installs whose assets come from an on-disk
 * payload. An npm/dev checkout and the Docker images ship the directories
 * inside the package/image and carry no manifest, so a missing manifest there
 * is normal, not a finding — hence the `skip` when the payload layout is not in
 * use. Getting that wrong would turn doctor permanently amber for every
 * contributor.
 */

import type { CheckResult } from "./doctor.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import {
  PROFILES_ASSET,
  assetPayloadSkew,
  resolveShippedAsset,
  type ShippedAssetProbe,
} from "../util/shipped-assets.js";

export interface AssetPayloadCheckOpts {
  /** Test seam — the layout to probe. Defaults to this process's. */
  probe?: ShippedAssetProbe;
  /** Test seam — override the running CLI's version. */
  cliVersion?: string;
  /** Test seam — manifest reader. */
  readText?: (path: string) => string | null;
}

export function runAssetPayloadChecks(
  opts: AssetPayloadCheckOpts = {},
): CheckResult[] {
  const probe: ShippedAssetProbe = opts.probe ?? {
    bundleDir: import.meta.dirname,
    execPath: process.execPath,
  };
  const cliVersion = opts.cliVersion ?? SWITCHROOM_VERSION;

  // Which layout is actually serving assets right now? `profiles/` is the
  // representative asset — it is the one `apply` cannot proceed without.
  const profiles = resolveShippedAsset(PROFILES_ASSET, probe);
  const bundled =
    profiles.source === "npm" ||
    profiles.source === "image" ||
    profiles.source === "env";
  if (bundled) {
    return [
      {
        name: "shipped-asset payload",
        status: "skip",
        detail:
          `assets are bundled with this install (${profiles.source}: ` +
          `${profiles.path}) — no separate payload to verify`,
      },
    ];
  }

  const skew = assetPayloadSkew({ cliVersion, probe, readText: opts.readText });
  if (skew.status === "matched") {
    return [
      {
        name: "shipped-asset payload",
        status: "ok",
        detail: `${skew.payloadVersion} at ${skew.manifestPath}`,
      },
    ];
  }

  // Every remaining status is a fail. A CLI that cannot scaffold, or that
  // scaffolds from templates of another release, is a broken install — not a
  // "worth a look" warning. `switchroom update` is the in-band repair for all
  // three, because it reinstalls the payload for the running release even when
  // the binary itself is already current.
  return [
    {
      name: "shipped-asset payload",
      status: "fail",
      detail: skew.message,
      fix: "switchroom update",
    },
  ];
}
