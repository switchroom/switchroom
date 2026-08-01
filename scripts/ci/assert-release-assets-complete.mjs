#!/usr/bin/env node
/**
 * Half-ship gate, leg 2: "does the GitHub Release for this tag actually carry
 * every file `install.sh` will ask for?" (#3654)
 *
 * WHY THIS IS THE HIGH-VALUE GATE. `install.sh` resolves the version it
 * installs from `https://api.github.com/repos/<repo>/releases/latest`, and
 * that endpoint EXCLUDES drafts. So the moment a release is created
 * published, it becomes `latest` for every `curl | sh` user on earth — even
 * though the binaries take ~20 minutes to build and attach, and even if they
 * never attach at all. install.sh then dies on the asset download ("does this
 * release ship static binaries?"). Holding the release as a DRAFT until every
 * asset is attached keeps the PREVIOUS complete release serving installs, so
 * a failed build is invisible to users instead of breaking them.
 *
 * This script is the mechanical answer to "is it complete?", used by:
 *
 *   - `.github/workflows/release.yml`     → hold an incomplete PUBLISHED
 *     release back to draft before uploading; re-verify before un-drafting
 *   - `.github/workflows/npm-publish.yml` → refuse to publish the
 *     IRREVERSIBLE npm artifact for a tag whose release is incomplete
 *
 * SHAPE: pure comparison, no network. The caller pipes in the JSON from
 * `gh api repos/{repo}/releases` (the LIST endpoint, deliberately — see
 * below) and reads the exit code plus a JSON summary on stdout.
 *
 * WHY THE LIST ENDPOINT, NOT `/releases/tags/{tag}`: "Get a release by tag
 * name" returns PUBLISHED releases. A draft is exactly the state this gate
 * has to inspect, so looking it up by tag would 404 on the one case that
 * matters. The list endpoint includes drafts for any token with push access.
 *
 * WHY ONE PAGE IS ENOUGH (this repo passed 100 releases): the list endpoint
 * returns DRAFTS FIRST, then published releases newest-first — verified
 * against the live API, where a May draft sorts ahead of the July releases.
 * The release this gate inspects was created minutes earlier, so it is at
 * the top of page 1 either way. And the failure mode if that ever stopped
 * holding is exit 4 (not found) → the caller BLOCKS the release. Never a
 * silent pass, which is the only property that has to be guaranteed.
 *
 * WHY THE EXPECTED SET IS DERIVED, NOT LISTED: the required asset names come
 * from parsing `install.sh` via scripts/release-assets.mjs — the same module
 * `npm run lint` uses. Hard-coding them here would let the installer and the
 * gate drift apart, which is the whole failure class #3633 was about. Adding
 * a platform to install.sh automatically makes it required here.
 * (`loadInstallerContract` is node-stdlib only — no `yaml` import — so this
 * runs on a bare checkout with no node_modules.)
 *
 * Exit codes:
 *   0 — release found and every expected asset is attached
 *   3 — release found but assets are MISSING (summary lists which)
 *   4 — no release exists for this tag at all
 *   1 — bad input / bad configuration (never treated as "fine")
 *
 * stdout is always a one-object JSON summary so callers can branch on
 * `.draft` without re-parsing the API payload.
 */

import { loadInstallerContract } from "../release-assets.mjs";

export const EXIT = { complete: 0, badInput: 1, incomplete: 3, notFound: 4 };

/**
 * The files a release MUST carry, derived from install.sh.
 *
 * @param {{installShPath?: string}} [opts]
 * @returns {string[]}
 */
export function expectedAssets(opts = {}) {
  const { installer } = loadInstallerContract(opts);
  // The payload tarball (#4163) is as required as the binaries: a release that
  // carries four binaries and no payload installs a CLI that cannot scaffold a
  // single agent, which is a worse user experience than a download 404 because
  // it fails later, on `switchroom apply`, on the user's host.
  return [...installer.assets, installer.checksumsFile, installer.payloadAsset];
}

/**
 * Find the release for a tag in a `GET /repos/{repo}/releases` payload.
 *
 * Matches on `tag_name`, NOT on `name`/title: the title is free text an
 * operator can typo, the tag name is the identity the workflows and
 * install.sh both key on.
 *
 * @param {unknown} payload array of releases (or a single release object)
 * @param {string} tag
 * @returns {Record<string, any> | null}
 */
export function selectRelease(payload, tag) {
  const releases = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const matches = releases.filter((r) => r && typeof r === "object" && r.tag_name === tag);
  if (matches.length === 0) return null;
  // A tag maps to at most one release in GitHub's model; if the payload
  // somehow carries duplicates, prefer the PUBLISHED one — reporting the
  // draft as authoritative would understate what users can already see.
  return matches.find((r) => r.draft === false) ?? matches[0];
}

/**
 * Which expected assets are absent from the release.
 *
 * Only assets GitHub reports as `uploaded` count. An asset stuck in
 * `starting`/`new` state is a half-finished upload; treating it as present
 * would let the gate pass on a release whose download 404s.
 *
 * @param {string[]} expected
 * @param {Record<string, any>} release
 * @returns {string[]}
 */
export function missingAssets(expected, release) {
  const uploaded = new Set(
    (Array.isArray(release?.assets) ? release.assets : [])
      .filter((a) => a && (a.state === undefined || a.state === "uploaded"))
      .map((a) => a.name),
  );
  return expected.filter((name) => !uploaded.has(name));
}

/* c8 ignore start — CLI wiring, covered end-to-end by spawnSync tests. */
async function main() {
  const tag = process.env.EXPECT_TAG ?? "";
  if (!tag) {
    console.error("::error::assert-release-assets-complete: EXPECT_TAG is required");
    process.exit(EXIT.badInput);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  let payload;
  try {
    payload = raw.length > 0 ? JSON.parse(raw) : [];
  } catch {
    console.error("::error::assert-release-assets-complete: stdin was not JSON");
    process.exit(EXIT.badInput);
  }

  let expected;
  try {
    expected = expectedAssets();
  } catch (err) {
    // A parse failure in release-assets.mjs means the install.sh contract is
    // unreadable. Refuse rather than guess — an empty expected set would make
    // every release trivially "complete".
    console.error(`::error::assert-release-assets-complete: ${err.message}`);
    process.exit(EXIT.badInput);
  }

  const release = selectRelease(payload, tag);
  if (!release) {
    console.log(JSON.stringify({ tag, found: false, draft: null, expected, missing: expected }));
    console.error(
      `::error::no GitHub Release exists for ${tag}. Create it (draft) before the release pipeline runs — see skills/switchroom-release/SKILL.md step 2.`,
    );
    process.exit(EXIT.notFound);
  }

  const missing = missingAssets(expected, release);
  const summary = {
    tag,
    found: true,
    draft: release.draft === true,
    id: release.id ?? null,
    expected,
    missing,
  };
  console.log(JSON.stringify(summary));

  if (missing.length > 0) {
    console.error(
      `::notice::release ${tag} is INCOMPLETE — missing: ${missing.join(", ")} (draft=${summary.draft})`,
    );
    process.exit(EXIT.incomplete);
  }
  console.error(`::notice::release ${tag} carries all ${expected.length} expected assets`);
  process.exit(EXIT.complete);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
/* c8 ignore stop */
