/**
 * Behavioural proof for the /metrics endpoint-label cardinality patch
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image.
 *
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that patch block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it drives
 * the real `hindsight_api.metrics.normalize_http_endpoint` from the image
 * against unpatched upstream (must be RED — composite ids leak into the label)
 * and against upstream + the patch block applied (must be GREEN).
 *
 * THE DEFECT, in the real shipping source (`hindsight_api/metrics.py`):
 *
 *     _METRIC_UUID_RE = re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-...-[0-9a-f]{12}")
 *
 * `normalize_http_endpoint` runs that over `request.url.path` (api/http.py) to
 * bound the cardinality of the `endpoint` metric label. It is anchored to a `/`
 * on the LEFT but to nothing on the RIGHT, so it only templates a segment that
 * IS a bare UUID. Hindsight document ids are COMPOSITE — `<uuid>-r<uuid>-<uuid>`
 * with zero, one or two `-pNofM` pagination suffixes, and for agent-scoped
 * documents `agent-<hex>-r<uuid>-<uuid>`. So a uuid-leading id keeps everything
 * after its first UUID, and an `agent-`-prefixed id (no UUID directly after a
 * `/`) is not templated AT ALL.
 *
 * MEASURED on this fleet's live `switchroom-hindsight` before the fix: /metrics
 * served 23,303,354 bytes carrying 3,982 distinct `endpoint` values against 9
 * real route templates, and took 0.91s to generate. Because `generate_latest()`
 * runs synchronously on the serving loop, the 15-minute `hindsight-watch`
 * scrape logged `EVENT LOOP BLOCKED for >= 1.00s ... /health cannot be
 * scheduled` at exactly the scrape minutes. That makes it an availability bug,
 * not merely a fat payload.
 *
 * The properties this probe drives, none of which the patch TEXT can show:
 *
 *  1. COLLAPSE — a corpus of real document paths covering all four observed id
 *     shapes yields exactly ONE `endpoint` label value. This is the property
 *     that bounds the series count; a patch that fixed only the uuid-leading
 *     shape would still be RED here.
 *  2. NO OVER-MATCH ON SUB-ROUTES — `/documents/<id>/chunks` and
 *     `/documents/<id>/reprocess` stay DISTINCT from `/documents/<id>` and from
 *     each other. A `.*`-style over-broad fix passes property 1 and fails this
 *     one, merging genuinely different endpoints into a single meaningless
 *     series.
 *  3. NO OVER-MATCH ON STATIC ROUTES — every one of the route templates the
 *     image actually registers normalises IDENTICALLY under the patched and
 *     unpatched regexes. The route table is read out of the image's own source
 *     rather than hard-coded here, so it cannot go stale against an image bump.
 *  4. UPSTREAM'S OTHER ARMS SURVIVE — the `/banks/<id>` and numeric-id
 *     templating still work; the patch touches one of the three regexes.
 *  5. IDEMPOTENT — an already-templated path is a fixed point, so a path that
 *     somehow round-trips cannot mint a second series.
 *
 * The patch block is extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies it by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-mm-refresh-debounce-patch.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8",
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-metrics-cardinality-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/** The patch this file proves, named by its unique in-block marker. */
const PATCH_NAME = "metrics-endpoint-cardinality patch";

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by its unique patch name.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const hits = blocks.filter((b) => b.includes(PATCH_NAME));
  if (hits.length !== 1) {
    throw new Error(
      `Dockerfile.hindsight contains ${hits.length} "${PATCH_NAME}" RUN blocks ` +
        `(expected exactly 1) — if the patch was deliberately removed because ` +
        `upstream carries the fix, delete this test with it.`,
    );
  }
  return hits;
}

/**
 * Python probe. Exits 0 only when all five properties above hold; prints the
 * offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES: it imports the SHIPPING
 * `hindsight_api.metrics.normalize_http_endpoint` and counts the distinct
 * `endpoint` label values a realistic corpus produces. Nothing here greps the
 * patched source, and nothing re-implements the regex.
 *
 * Every document id in the corpus is VERBATIM from this fleet's live hindsight
 * (`GET /v1/default/banks/<bank>/documents`), so the shapes are observed, not
 * imagined.
 */
const PROBE = String.raw`
import json
import pathlib
import re
import sys

from hindsight_api.metrics import normalize_http_endpoint

failures = []


def fail(msg):
    failures.append(msg)


# Real document ids, read verbatim off the live fleet. Four shapes:
#   1-2. uuid-leading composite, one and two -pNofM pagination suffixes
#   3.   agent-scoped: NO uuid directly after the "/", so upstream templates
#        NOTHING and the entire raw id lands in the label
#   4.   a plain bare uuid (the only shape upstream ever handled)
REAL_IDS = [
    "c97ca37d-7350-4614-881f-86de20a592de-rd04165cc-28f2-4a5f-b26c-dda0d3f18a9a-dc76c2b4-65da-4e45-9632-2beb53ed9134-p3of3",
    "a7e62e47-03e2-4833-8b22-6d1f403eae41-r2006281d-a396-4a3f-bd94-4f2c4653ca3d-11c76e6c-c8c5-4e84-afa7-263ee3e8b02f-p3of10-p2of2",
    "0957f343-216a-4344-878f-193f0c969a18-rcc2a694d-9386-4d81-ae27-7362f26449fb-5c7bcc1f-46cd-450a-a2df-56451a83cce6-p1of2",
    "d1579518-fd0b-4b33-8779-3e6657cd9f94-r32754a36-e6bf-49a1-95b4-5e670117aa7d-4203a867-f700-45c6-8171-d98a901e5584",
    "agent-a0e48667beb7ea9ad-r4190b384-15ec-4892-86b0-99a954debcc3-67832fa2-ab5f-4c76-a202-9538c877cda5",
    "agent-a69065868fae49c82-r316d2330-c38d-4ef8-9ac2-bf07160e621b-94cc0f1d-82d0-4fe8-8587-958be449e62f-p5of7",
    "e303f6cc-c858-4e97-a25e-c4ed85621641",
    "7b8c4e93-2072-411a-9dd4-cf95e838b02a",
]
# Several real banks, because the bank segment is templated by a different arm
# and a corpus with one bank could hide a regression in the interaction.
BANKS = ["overlord", "marko", "gymbro", "finn", "kdogg"]

DOC_PATHS = [
    "/v1/default/banks/%s/documents/%s" % (b, i) for b in BANKS for i in REAL_IDS
]
TPL = "/v1/default/banks/{bank_id}/documents/{id}"

# ── 1. COLLAPSE: the whole corpus is ONE label value ──────────────────────
labels = sorted({normalize_http_endpoint(p) for p in DOC_PATHS})
print("DOC_LABEL_COUNT", len(labels))
print("DOC_LABELS", json.dumps(labels[:6]))
if labels != [TPL]:
    fail(
        "%d document paths produced %d distinct endpoint labels (expected 1 == %r); "
        "sample: %s" % (len(DOC_PATHS), len(labels), TPL, json.dumps(labels[:6]))
    )

# ── 2. NO OVER-MATCH ON SUB-ROUTES ────────────────────────────────────────
# A ".*"-style over-broad fix passes property 1 and fails here: /chunks and
# /reprocess would be swallowed into /documents/{id} and three genuinely
# different endpoints would share one meaningless series.
for suffix in ("chunks", "reprocess"):
    sub = sorted(
        {normalize_http_endpoint(p + "/" + suffix) for p in DOC_PATHS}
    )
    want = [TPL + "/" + suffix]
    print("SUB_LABELS_%s" % suffix.upper(), json.dumps(sub))
    if sub != want:
        fail("sub-resource /%s normalised to %s (expected %s)" % (suffix, json.dumps(sub), json.dumps(want)))

# ── 3. NO OVER-MATCH ON STATIC ROUTES ─────────────────────────────────────
# The route table is read out of the image's OWN source, so this cannot go
# stale against a base-image bump the way a hard-coded list would. The
# unpatched pattern is reconstructed here purely as the comparison baseline:
# on a path with no id in it, patched and unpatched MUST agree exactly.
UNPATCHED_UUID_RE = re.compile(
    r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)
BANK_RE = re.compile(r"(/banks/)[^/]+")
NUM_RE = re.compile(r"/\d+(?=/|$)")


def upstream_normalize(path):
    path = BANK_RE.sub(r"\g<1>{bank_id}", path)
    path = UNPATCHED_UUID_RE.sub("/{id}", path)
    return NUM_RE.sub("/{id}", path)


DECORATOR_RE = re.compile(
    r"""@\w+\.(?:get|post|put|patch|delete|head|options|api_route)\(\s*\n?\s*[fr]?["']([^"']+)["']"""
)
routes = set()
for f in pathlib.Path("/app/api/hindsight_api").rglob("*.py"):
    routes |= set(DECORATOR_RE.findall(f.read_text(errors="replace")))
routes = sorted(r for r in routes if r.startswith("/"))
print("ROUTE_COUNT", len(routes))
if len(routes) < 20:
    fail(
        "only %d route templates discovered in the image — the decorator scan "
        "went vacuous and property 3 proves nothing" % len(routes)
    )
drift = [
    (r, upstream_normalize(r), normalize_http_endpoint(r))
    for r in routes
    if upstream_normalize(r) != normalize_http_endpoint(r)
]
print("ROUTE_DRIFT", json.dumps(drift))
if drift:
    fail("the patch changes how registered route templates normalise: %s" % json.dumps(drift))

# ── 4. UPSTREAM'S OTHER TEMPLATING ARMS SURVIVE ───────────────────────────
OTHER = [
    ("/v1/default/banks/overlord/audit-logs/12345", "/v1/default/banks/{bank_id}/audit-logs/{id}"),
    ("/v1/default/banks/user-123/memories/recall", "/v1/default/banks/{bank_id}/memories/recall"),
    ("/health", "/health"),
    ("/metrics", "/metrics"),
    ("/v1/bank-template-schema", "/v1/bank-template-schema"),
]
for path, want in OTHER:
    got = normalize_http_endpoint(path)
    if got != want:
        fail("normalize_http_endpoint(%r) == %r, expected %r" % (path, got, want))

# ── 5. IDEMPOTENT ─────────────────────────────────────────────────────────
for once in [TPL, TPL + "/chunks", "/v1/default/banks/{bank_id}/memories/recall"]:
    twice = normalize_http_endpoint(once)
    if twice != once:
        fail("normalisation is not a fixed point: %r -> %r" % (once, twice))

print("FAILURES", json.dumps(failures))
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or
 * an absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-metcard-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8,
  )}`;
  try {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `switchroom.test=${TEST_PHASE}`,
        "--label",
        `switchroom.test.run=${RUN_ID}`,
        "--user",
        "root",
        "--network",
        "none",
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    if (patched) {
      for (const block of patchBlocks()) {
        // The block is self-verifying: it asserts its upstream anchor exists
        // exactly once and re-drives normalize_http_endpoint afterwards, so a
        // non-zero exit here means upstream drifted and the patch must be
        // re-authored (or deleted, if upstream now carries the fix).
        execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
          input: block,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight metrics-cardinality probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the one patch block it claims to prove", () => {
    expect(patchBlocks()).toHaveLength(1);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`,
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable",
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite",
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight metrics-cardinality patch changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" },
        )
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("unpatched upstream is RED — composite document ids leak into the endpoint label", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The defect, driven. 8 real document ids x 5 banks share ONE route, yet
      // upstream mints a distinct `endpoint` label for all but the two bare
      // UUIDs — which is the unbounded, never-evicted series growth that put
      // 3,982 label values and 23MB into the live /metrics payload.
      expect(stdout).toMatch(/^DOC_LABEL_COUNT 7$/m);
      // Specifically: the `agent-`-prefixed shape is not templated AT ALL, so
      // a whole raw document id appears verbatim in the label.
      expect(stdout).toContain(
        "documents/agent-a0e48667beb7ea9ad-r4190b384-15ec-4892-86b0-99a954debcc3-67832fa2-ab5f-4c76-a202-9538c877cda5",
      );
    }, 240_000);

    it("upstream + the baked patch block is GREEN on all five properties", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED",
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // 1. every real id shape collapses to the single route template.
      expect(stdout).toMatch(/^DOC_LABEL_COUNT 1$/m);
      expect(stdout).toContain(
        'DOC_LABELS ["/v1/default/banks/{bank_id}/documents/{id}"]',
      );
      // 2. sub-resource routes stay distinct (no `.*`-style over-match).
      expect(stdout).toContain(
        'SUB_LABELS_CHUNKS ["/v1/default/banks/{bank_id}/documents/{id}/chunks"]',
      );
      expect(stdout).toContain(
        'SUB_LABELS_REPROCESS ["/v1/default/banks/{bank_id}/documents/{id}/reprocess"]',
      );
      // 3. no registered route template normalises differently than upstream…
      expect(stdout).toContain("ROUTE_DRIFT []");
      // …and the scan that proves it was not vacuous.
      const routeCount = Number(
        /^ROUTE_COUNT (\d+)$/m.exec(stdout)?.[1] ?? "0",
      );
      expect(
        routeCount,
        "the route-template scan found too few routes to prove anything",
      ).toBeGreaterThanOrEqual(20);
    }, 240_000);
  },
);
