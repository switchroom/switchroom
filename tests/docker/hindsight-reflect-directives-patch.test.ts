/**
 * Behavioural proof for the reflect-directive-isolation patch
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight image
 * (switchroom #3967, upstream vectorize-io/hindsight#1269 / #3031).
 * `dockerfile-hindsight-bakes.test.ts` pins the *shape* of that block
 * (grep-on-file, runs everywhere). This file proves the *outcome*: it runs the
 * same probe against unpatched upstream (must be RED) and against upstream +
 * the patch block applied (must be GREEN).
 *
 * v0.8.6 RE-ANCHORING (upstream #3013). The reflect rework wrapped this fetch in
 * an `if apply_all_directives: / else:` pair (memory_engine.py:10145-10167) and
 * exposed a per-request `apply_all_directives` flag on MCP (mcp_tools.py:1023,
 * :1118) and HTTP (api/http.py:959). The flag DEFAULTS TO FALSE and the
 * else-branch is the old fetch byte-for-byte, so the defect below is unchanged
 * — which is why the patch was re-anchored rather than retired. This probe now
 * selects the else-branch structurally and additionally asserts the opt-in
 * branch stays untouched, so "the patch leaked into the opt-in path" is a red
 * test rather than a silent widening.
 *
 * THE DEFECT. `reflect_async` loads its directives with `isolation_mode=True`,
 * and `list_directives` turns that flag into a hard
 * `tags IS NULL OR tags = '{}'` filter whenever the caller supplied no tags. So
 * an untagged reflect — the common case, and the only shape switchroom's
 * `reflect` tool issues — silently drops every directive carrying at least one
 * tag. Measured on this fleet 2026-07-29: 172 active directives, 94 untagged.
 * 45% of the operator's standing rules never reached a reflect prompt (reggie
 * 3 of 20, test-harness 2 of 19, gymbro 4 of 11, overlord 10 of 22, `default`
 * 0 of 9). Switchroom's RECALL path already worked around this client-side
 * (`vendor/hindsight-memory/scripts/lib/directives.py`); reflect never got the
 * equivalent.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE BAKES TEST. The bakes assertions are
 * unanchored substring matches, so a patch that applies and lands INERT keeps
 * every one of them green. The failure that matters here is a single token:
 * `isolation_mode=False` reverting to `True`, or upstream widening the
 * `if not tags and not tag_groups and isolation_mode` condition so the flag
 * starts binding on tagged reflects too. Only loading real directives out of a
 * real database and reading which ones come back catches that.
 *
 * WHAT IT DRIVES, and what it deliberately does not. The probe runs the REAL
 * `MemoryEngine.list_directives` against a REAL PostgreSQL (pg0, bundled in the
 * image, started offline) whose schema comes from the REAL alembic migrations,
 * with the directives inserted by the REAL `create_directive`. The kwargs it
 * passes are not hard-coded: they are read out of `reflect_async`'s own AST, so
 * the probe asks exactly what reflect asks, which is what makes it flip RED/GREEN
 * with the patch. The rows that come back are then fed to the REAL
 * `_build_directives_applied()` (the trace field) and the REAL
 * `build_directives_section()` (the system-prompt block), and the assertions are
 * on those two outputs — i.e. on which directives actually reach the trace and
 * the prompt.
 *
 * It stops short of an end-to-end `reflect()` call for one reason: that would
 * need a live LLM, and the probe container runs `--network none`. Everything
 * between the database and the prompt is real; only the model call is absent,
 * and no assertion here depends on what a model would have said.
 *
 * The patch block is extracted from the Dockerfile itself rather than duplicated
 * here, so this test cannot drift from what actually ships. It applies it by
 * `docker exec` (not `docker build`) so it runs on daemons without buildx, and
 * it never touches the production `switchroom-hindsight` container.
 *
 * SKIP DISCIPLINE: identical to `hindsight-recall-isolation-patches.test.ts`.
 * Locally, with no docker or no cached image, this skips (never pull a 6.4GB
 * third-party image onto a dev box). In CI the `hindsight-probe` job pulls the
 * pinned digest and sets SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1, under which an
 * unavailable docker/image is a HARD FAILURE, never a green skip. Both runs
 * assert a `PROBE_EXECUTED` sentinel so a probe that dies early can never be
 * mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { execFileAsync } from "./_exec-async.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8"
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-reflect-directives-patch";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

const PATCH_NAME = "reflect-directive-isolation patch";

/**
 * The patch block under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' ... PYEOF` heredocs by its unique patch name.
 */
function patchBlock(): string {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const matches = blocks.filter((b) => b.includes(PATCH_NAME));
  if (matches.length !== 1) {
    throw new Error(
      `Dockerfile.hindsight contains ${matches.length} RUN blocks mentioning ` +
        `"${PATCH_NAME}" (expected exactly 1) — if it was deliberately removed, ` +
        `delete this test with it.`
    );
  }
  return matches[0];
}

/**
 * Python probe. Exits 0 only when a no-tags reflect loads BOTH directives and
 * both reach the trace and the system prompt, AND tag scoping is untouched;
 * prints the offending assertions otherwise.
 */
const PROBE = String.raw`
import ast
import asyncio
import inspect
import os
import textwrap
import uuid

failures = []


def fail(msg):
    failures.append(msg)


DB_URL = "postgresql://postgres:postgres@127.0.0.1:5432/postgres"
os.environ["HINDSIGHT_API_DATABASE_URL"] = DB_URL
# No LLM is ever called: the probe stops at the prompt, not at synthesis. These
# exist only so MemoryEngine can be constructed with --network none.
os.environ.setdefault("HINDSIGHT_API_LLM_PROVIDER", "openai")
os.environ.setdefault("HINDSIGHT_API_LLM_API_KEY", "unused-no-llm-call-in-this-probe")
os.environ.setdefault("HINDSIGHT_API_LLM_MODEL", "unused-no-llm-call-in-this-probe")

from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.reflect.agent import _build_directives_applied
from hindsight_api.engine.reflect.prompts import build_directives_section
from hindsight_api.models import RequestContext

# =====================================================================
# What reflect ACTUALLY passes to list_directives, read out of the shipping
# source. Nothing below hard-codes the flag: the probe drives the real query
# with whatever reflect_async really asks for, which is what makes it RED on
# unpatched upstream and GREEN once patched.
# =====================================================================
tree = ast.parse(textwrap.dedent(inspect.getsource(MemoryEngine.reflect_async)))


def _directive_calls(nodes):
    return [
        n
        for n in nodes
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "list_directives"
    ]


calls = _directive_calls(ast.walk(tree))
if len(calls) != 2:
    fail(
        f"expected exactly 2 list_directives calls in reflect_async, found {len(calls)} "
        "- v0.8.6 (upstream #3013) split the fetch into an "
        "if apply_all_directives: / else: pair; re-author the patch and this probe together"
    )
    print("PROBE_EXECUTED")
    print("FAILURES", failures)
    raise SystemExit(1)

# The DEFAULT branch is the one under test. apply_all_directives is a
# per-request opt-in that defaults to False (mcp_tools.py:1023/:1118,
# api/http.py:959), so the else-branch is what every ordinary reflect takes —
# and it is byte-for-byte the pre-0.8.6 defective fetch. Selected structurally
# from the if/else rather than by index, so a reordering upstream cannot
# silently point this probe at the opt-in branch.
branch = [
    n
    for n in ast.walk(tree)
    if isinstance(n, ast.If)
    and isinstance(n.test, ast.Name)
    and n.test.id == "apply_all_directives"
    and _directive_calls(ast.walk(n))
]
if len(branch) != 1:
    fail(
        f"expected exactly 1 if-apply_all_directives guarding the directive fetch, "
        f"found {len(branch)} - upstream restructured the reflect directive fetch again"
    )
    print("PROBE_EXECUTED")
    print("FAILURES", failures)
    raise SystemExit(1)

default_calls = _directive_calls(ast.walk(ast.Module(body=branch[0].orelse, type_ignores=[])))
optin_calls = _directive_calls(ast.walk(ast.Module(body=branch[0].body, type_ignores=[])))
if len(default_calls) != 1 or len(optin_calls) != 1:
    fail(
        f"expected 1 directive fetch per branch, found opt-in={len(optin_calls)} "
        f"default={len(default_calls)}"
    )
    print("PROBE_EXECUTED")
    print("FAILURES", failures)
    raise SystemExit(1)

# THE OPT-IN BRANCH MUST STAY UPSTREAM'S. The patch deliberately touches only
# the else-branch: apply_all_directives=True explicitly means "ignore tag
# scope entirely", which is strictly wider than what this fix does. If the
# patch ever bled into this branch, the two would become indistinguishable and
# the flag would stop meaning anything.
optin_kwargs = sorted(kw.arg for kw in optin_calls[0].keywords)
print("OPTIN_DIRECTIVE_KWARGS", optin_kwargs)
if optin_kwargs != ["active_only", "bank_id", "isolation_mode", "request_context"]:
    fail(
        "the apply_all_directives=True branch is no longer upstream's untouched "
        f"no-tag fetch: {optin_kwargs}"
    )

call = default_calls[0]
kwarg_names = [kw.arg for kw in call.keywords]
print("REFLECT_DIRECTIVE_KWARGS", kwarg_names)

iso = [kw.value for kw in call.keywords if kw.arg == "isolation_mode"]
if len(iso) != 1 or not isinstance(iso[0], ast.Constant) or not isinstance(iso[0].value, bool):
    fail("reflect_async no longer passes a literal bool isolation_mode to list_directives")
    print("PROBE_EXECUTED")
    print("FAILURES", failures)
    raise SystemExit(1)
REFLECT_ISOLATION_MODE = iso[0].value
print("REFLECT_ISOLATION_MODE", REFLECT_ISOLATION_MODE)

# reflect forwards its own tag scoping through. If that stops being true, the
# blast-radius assertions below stop meaning what they say.
for expected in ("tags", "tags_match", "tag_groups", "active_only"):
    if expected not in kwarg_names:
        fail(f"reflect_async no longer forwards {expected} to list_directives")


class ProbeEmbeddings(Embeddings):
    """Deterministic stand-in. Directive loading never embeds anything; this
    exists only so MemoryEngine can be constructed offline."""

    @property
    def provider_name(self):
        return "switchroom-probe"

    @property
    def dimension(self):
        return 8

    async def initialize(self):
        return None

    def encode(self, texts):
        return [[0.0] * 8 for _ in texts]


UNTAGGED = ("switchroom-probe-untagged", "Always answer in English.")
TAGGED = ("switchroom-probe-tagged", "End every response with [VERIFIED].")
BOTH = sorted([UNTAGGED[0], TAGGED[0]])


async def main():
    from hindsight_api.migrations import run_migrations

    # Real schema, from the image's own alembic revisions.
    run_migrations(DB_URL, "/app/api/hindsight_api/alembic")

    engine = MemoryEngine(
        embeddings=ProbeEmbeddings(),
        cross_encoder=None,
        run_migrations=False,
        skip_llm_verification=True,
    )
    await engine.initialize()
    rc = RequestContext()
    bank = "switchroom-reflect-directives-" + uuid.uuid4().hex[:8]
    await engine._ensure_bank_exists(bank, request_context=rc)

    # One untagged and one tagged directive, both ACTIVE. Inserted through the
    # real write path so their stored shape is whatever upstream stores.
    await engine.create_directive(bank, UNTAGGED[0], UNTAGGED[1], request_context=rc)
    await engine.create_directive(bank, TAGGED[0], TAGGED[1], tags=["scoped"], request_context=rc)

    async def load(tags):
        """reflect's directive fetch, verbatim: the same kwargs reflect_async
        passes, including the isolation_mode it actually ships with."""
        return await engine.list_directives(
            bank,
            tags=tags,
            tags_match="any",
            tag_groups=None,
            active_only=True,
            request_context=rc,
            isolation_mode=REFLECT_ISOLATION_MODE,
        )

    # ---- the defect: an UNTAGGED reflect (the common case) ----
    loaded = await load(None)
    names = sorted(d["name"] for d in loaded)
    print("UNTAGGED_REFLECT_LOADED", names)
    if names != BOTH:
        fail(
            f"an untagged reflect loaded {len(loaded)} of 2 active directives {names} "
            "- a directive with any tag is silently dropped from synthesis "
            "(vectorize-io/hindsight#1269)"
        )

    # ---- the outcome that matters: the trace field and the system prompt ----
    applied = _build_directives_applied(loaded)
    applied_names = sorted(d.name for d in applied)
    print("DIRECTIVES_APPLIED", applied_names)
    if applied_names != BOTH:
        fail(
            f"reflect's directives_applied trace carries {len(applied)} directive(s) "
            f"{applied_names}; '{TAGGED[0]}' never reached it"
        )

    section = build_directives_section(loaded)
    in_prompt = sorted(n for n, c in (UNTAGGED, TAGGED) if c in section)
    print("PROMPT_DIRECTIVE_TEXTS", in_prompt)
    if in_prompt != BOTH:
        fail(
            "the reflect system prompt's DIRECTIVES (MANDATORY) section carries "
            f"{in_prompt} - the model is never shown the dropped rule"
        )

    # ---- blast radius: a TAGGED reflect must be unchanged either way ----
    # The flag is only consulted inside "if not tags and not tag_groups and
    # isolation_mode", so these two lines read identically patched and unpatched.
    # They are what proves the patch narrow rather than merely effective.
    matching = sorted(d["name"] for d in await load(["scoped"]))
    print("MATCHING_TAG_REFLECT_LOADED", matching)
    if matching != BOTH:
        fail(
            f"a reflect tagged ['scoped'] loaded {matching}, expected both the untagged "
            "directive and the matching tagged one"
        )

    other = sorted(d["name"] for d in await load(["unrelated"]))
    print("OTHER_TAG_REFLECT_LOADED", other)
    if other != [UNTAGGED[0]]:
        fail(
            f"a reflect tagged ['unrelated'] loaded {other} - tag scoping must be "
            "untouched by this patch; only the NO-tags path changes"
        )

    await engine.close()


asyncio.run(main())
print("PROBE_EXECUTED")
print("FAILURES", failures)
raise SystemExit(1 if failures else 0)
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

/** Path to the bundled embedded-postgres binary inside the image. */
const PG0 =
  "/app/api/.venv/lib/python3.11/site-packages/pg0/bin/pg0";

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
async function runProbe(patched: boolean): Promise<ProbeResult> {
  const name = `sr-hs-refdir-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8
  )}`;
  try {
    await execFileAsync("docker", [
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
        "600",
      ]);

    if (patched) {
      // The block is self-verifying: it asserts its upstream anchors exist
      // exactly once and re-asserts the result, so a non-zero exit here means
      // upstream drifted and the patch must be re-authored.
      await execFileAsync("docker", ["exec", "-i", name, "python3", "-"], { input: patchBlock() });
    }

    // A real database, bundled in the image and started offline. postgres
    // refuses to run as root, so this and the probe run as `hindsight`.
    await execFileAsync("docker", ["exec", "-u", "hindsight", "-e", "HOME=/home/hindsight", name, PG0, "start"]);

    const res = await execFileAsync("docker", [
        "exec",
        "-i",
        "-u",
        "hindsight",
        "-e",
        "HOME=/home/hindsight",
        "-w",
        "/app/api",
        name,
        "/app/api/.venv/bin/python",
        "-",
      ], { input: PROBE });
    return { status: 0, stdout: res.stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      await execFileAsync("docker", ["rm", "-f", name]);
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight reflect-directives probe is real, not a silent skip", () => {
  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("extracts exactly the one patch block it claims to prove", () => {
    expect(patchBlock()).toContain(PATCH_NAME);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable"
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite"
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight reflect-directive-isolation patch changes real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" }
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

    it("unpatched upstream is RED: a tagged directive never reaches reflect", async () => {
      const { status, stdout } = await runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // The call site, as it ships.
      expect(stdout).toContain("REFLECT_ISOLATION_MODE True");
      // The defect, driven against a real database: 1 of 2 active directives.
      expect(stdout).toContain(
        "UNTAGGED_REFLECT_LOADED ['switchroom-probe-untagged']"
      );
      // …and therefore absent from BOTH observable surfaces.
      expect(stdout).toContain(
        "DIRECTIVES_APPLIED ['switchroom-probe-untagged']"
      );
      expect(stdout).toContain(
        "PROMPT_DIRECTIVE_TEXTS ['switchroom-probe-untagged']"
      );
      expect(stdout).toContain(
        "a directive with any tag is silently dropped from synthesis"
      );
      // The tagged paths already behave correctly upstream — the patch must not
      // be credited with fixing them, and must not break them.
      expect(stdout).toContain(
        "MATCHING_TAG_REFLECT_LOADED ['switchroom-probe-tagged', 'switchroom-probe-untagged']"
      );
      expect(stdout).toContain(
        "OTHER_TAG_REFLECT_LOADED ['switchroom-probe-untagged']"
      );
    }, 300_000);

    it("upstream + the baked patch block is GREEN, and tag scoping is untouched", async () => {
      const { status, stdout } = await runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // The flag reflect actually passes, after the patch.
      expect(stdout).toContain("REFLECT_ISOLATION_MODE False");
      // The fix: an untagged reflect now loads BOTH active directives …
      expect(stdout).toContain(
        "UNTAGGED_REFLECT_LOADED ['switchroom-probe-tagged', 'switchroom-probe-untagged']"
      );
      // … and both reach the trace field and the system prompt, which is the
      // outcome the whole patch exists for.
      expect(stdout).toContain(
        "DIRECTIVES_APPLIED ['switchroom-probe-tagged', 'switchroom-probe-untagged']"
      );
      expect(stdout).toContain(
        "PROMPT_DIRECTIVE_TEXTS ['switchroom-probe-tagged', 'switchroom-probe-untagged']"
      );
      // Blast radius: byte-identical to the unpatched run on both tagged paths.
      // A patch that also widened tagged reflect would go red here.
      expect(stdout).toContain(
        "MATCHING_TAG_REFLECT_LOADED ['switchroom-probe-tagged', 'switchroom-probe-untagged']"
      );
      expect(stdout).toContain(
        "OTHER_TAG_REFLECT_LOADED ['switchroom-probe-untagged']"
      );
      // reflect still forwards its own scoping — the patch changes the flag and
      // nothing else about the call.
      expect(stdout).toContain(
        "REFLECT_DIRECTIVE_KWARGS ['bank_id', 'tags', 'tags_match', 'tag_groups', " +
          "'active_only', 'request_context', 'isolation_mode']"
      );
    }, 300_000);
  }
);
