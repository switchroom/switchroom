/**
 * Structural guard: a `v*` tag cannot half-ship (#3654).
 *
 * Until this landed, `docker-images`, `release` and `npm-publish` all fired
 * independently on the same tag push with nothing cross-gating them. A tag
 * could therefore put `switchroom@X.Y.Z` on npm — permanently, npm has no
 * undo — while the binary build was red, minting a version whose advertised
 * `curl | sh` install path points at release assets that do not exist.
 *
 * WHY A TEST AND NOT A CODE REVIEW. None of these workflows run on a pull
 * request: `release` and `npm-publish` are tag/dispatch-only. An edit that
 * re-adds a `push:` trigger to npm-publish, or drops a `needs:`, or slips an
 * `if: always()` onto the chain, is INVISIBLE until the next real release —
 * at which point the damage is an unpublishable npm version. The same
 * reasoning as tests/docker/manifest-jobs-no-buildx.test.ts.
 *
 * The rules are expressed as one pure `auditGating()` over the parsed
 * workflows, and every rule is proved by MUTATION: the real files must be
 * clean, and a copy weakened in the specific way a careless edit would
 * weaken it must go red. A rule that only asserted the happy path would pass
 * just as well with the gating deleted.
 *
 * Jobs are identified by what they DO (a step that uploads release assets, a
 * step that runs the classifier, a step that un-drafts), not by job id, so a
 * rename cannot silently disable a rule.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(import.meta.dirname, "..");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
}
type Permissions = string | Record<string, string> | undefined;
interface Job {
  needs?: string | string[];
  if?: unknown;
  uses?: string;
  steps?: Step[];
  env?: Record<string, unknown>;
  permissions?: Permissions;
  with?: Record<string, unknown>;
  strategy?: { matrix?: Record<string, unknown> };
  "continue-on-error"?: unknown;
}
interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
  env?: Record<string, unknown>;
  permissions?: Permissions;
}

function load(file: string): Workflow {
  return parse(readFileSync(resolve(REPO, ".github/workflows", file), "utf8")) as Workflow;
}
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function needsOf(job: Job): string[] {
  const n = job.needs;
  return Array.isArray(n) ? n : typeof n === "string" ? [n] : [];
}
function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? job.steps : [];
}
/** First job whose steps contain `needle` in a `run:` body. */
function jobDoing(wf: Workflow, needle: string): [string, Job] | undefined {
  return Object.entries(wf.jobs ?? {}).find(([, j]) => stepsOf(j).some((s) => (s.run ?? "").includes(needle)));
}
/**
 * Is `name` bound to a non-empty value for this step? GitHub layers env as
 * workflow < job < step, so a step inherits whatever the outer scopes set.
 * An empty binding is NOT a binding — the gate scripts read `?? ""` and
 * treat blank as absent, so `EXPECT_TAG: ""` fails exactly like omitting it.
 */
function envBound(wf: Workflow, job: Job, step: Step, name: string): boolean {
  for (const scope of [step.env, job.env, wf.env]) {
    const v = scope?.[name];
    if (v !== undefined && v !== null && String(v).trim() !== "") return true;
  }
  return false;
}

/**
 * The effective `contents:` scope of a job's GITHUB_TOKEN.
 *
 * Unlike `env:`, permissions do NOT layer: a job-level `permissions:` block
 * REPLACES the workflow-level one outright, and every scope it omits becomes
 * `none`. So this resolves job-first-or-workflow, never a merge of the two.
 * An absent block anywhere means "whatever the repo default happens to be",
 * which is not a guarantee — report it as `null` and let the caller fail
 * closed rather than assume write.
 */
function contentsScope(wf: Workflow, job: Job): string | null {
  const p: Permissions = job.permissions !== undefined ? job.permissions : wf.permissions;
  if (p === undefined || p === null) return null;
  if (typeof p === "string") {
    // The shorthand forms: `write-all` / `read-all` / `{}` (= none).
    if (p === "write-all") return "write";
    if (p === "read-all") return "read";
    return "none";
  }
  const v = p.contents;
  return typeof v === "string" ? v : "none";
}

/**
 * The body of every `if [[ … refs/tags/v* ]]` branch inside a `run:` block —
 * i.e. exactly the lines that decide which image tags a `v*` TAG PUSH
 * publishes. Comment lines are stripped: the branches carry prose about
 * `:latest` that must not be mistaken for an assignment of it.
 */
function tagPushBranches(wf: Workflow): { job: string; step: string; body: string }[] {
  const out: { job: string; step: string; body: string }[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    for (const s of stepsOf(job)) {
      const lines = (s.run ?? "").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!/refs\/tags\/v\*/.test(line) || !/^\s*(el)?if\b/.test(line)) continue;
        const body: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*(elif|else|fi)\b/.test(lines[j] as string)) break;
          if (/^\s*#/.test(lines[j] as string)) continue;
          body.push(lines[j] as string);
        }
        out.push({ job: id, step: s.name ?? "?", body: body.join("\n") });
      }
    }
  }
  return out;
}

/**
 * Every `switchroom-<name>` image docker-images.yml publishes on a tag push:
 * the `merge-dependents` matrix, plus `base`, plus each standalone build job
 * identified by its `file: docker/Dockerfile.<name>`.
 */
function dockerPublishedImages(docker: Workflow): string[] {
  const set = new Set<string>(["base"]);
  const md = docker.jobs?.["merge-dependents"];
  for (const n of (md?.strategy?.matrix?.image as unknown[] | undefined) ?? []) set.add(String(n));
  for (const job of Object.values(docker.jobs ?? {})) {
    for (const s of stepsOf(job)) {
      const m = /^docker\/Dockerfile\.([\w-]+)$/.exec(String((s as { with?: Record<string, unknown> }).with?.file ?? ""));
      if (m) set.add(m[1] as string);
    }
  }
  return [...set].sort();
}

/**
 * The whole rule set, as a list of human-readable problems. Empty = the
 * pipeline cannot half-ship.
 */
export function auditGating(
  release: Workflow,
  npmPublish: Workflow,
  docker: Workflow,
  promote: Workflow,
): string[] {
  const problems: string[] = [];
  const releaseJobs = Object.entries(release.jobs ?? {});

  // R1 — npm-publish must not be reachable from a tag push. This is the
  // trigger half of the guarantee: ordering that depends on nobody adding a
  // `push:` trigger back is not a guarantee.
  if (npmPublish.on && Object.prototype.hasOwnProperty.call(npmPublish.on, "push")) {
    problems.push(
      "R1: npm-publish.yml has a `push` trigger — a tag push would publish to npm in parallel with the " +
        "binary build again. npm cannot be un-published.",
    );
  }

  // R2 — and it must still be callable by the orchestrator.
  if (!npmPublish.on || !Object.prototype.hasOwnProperty.call(npmPublish.on, "workflow_call")) {
    problems.push("R2: npm-publish.yml has no `workflow_call` trigger — release.yml cannot invoke it.");
  }

  // Locate the pipeline's jobs by behaviour.
  const npmEntry = releaseJobs.find(([, j]) => (j.uses ?? "").endsWith("npm-publish.yml"));
  const uploadEntry = jobDoing(release, "gh release upload");
  const gateEntry = jobDoing(release, "classify-workflow-run.mjs");
  const undraftEntry = jobDoing(release, "--draft=false");

  if (!npmEntry) problems.push("R3: release.yml has no job that calls npm-publish.yml.");
  if (!uploadEntry) problems.push("R3: release.yml has no job that uploads release assets.");
  if (!gateEntry) problems.push("R3: release.yml has no job that gates on the docker-images run.");
  if (!undraftEntry) problems.push("R3: release.yml has no job that publishes the release out of draft.");

  // R4 — the irreversible leg waits for BOTH the assets and the image build.
  if (npmEntry && uploadEntry && gateEntry) {
    const n = needsOf(npmEntry[1]);
    for (const [id] of [uploadEntry, gateEntry]) {
      if (!n.includes(id)) {
        problems.push(
          `R4: the npm job (${npmEntry[0]}) does not \`needs: ${id}\` — npm could publish before that leg is green.`,
        );
      }
    }
  }

  // R5 — the release becomes visible to install.sh (which resolves
  // /releases/latest, and that endpoint skips drafts) only after every leg,
  // npm included, has succeeded. Exactly one job may do it.
  const undrafters = releaseJobs.filter(([, j]) => stepsOf(j).some((s) => (s.run ?? "").includes("--draft=false")));
  if (undrafters.length > 1) {
    problems.push(
      `R5: ${undrafters.length} jobs take the release out of draft (${undrafters
        .map(([id]) => id)
        .join(", ")}) — only the final one may.`,
    );
  }
  if (undraftEntry && npmEntry && !needsOf(undraftEntry[1]).includes(npmEntry[0])) {
    problems.push(
      `R5: the un-draft job (${undraftEntry[0]}) does not \`needs: ${npmEntry[0]}\` — the release could go ` +
        "public for a version that never reached npm.",
    );
  }
  // R9 — the job that pulls an incomplete PUBLISHED release back to draft
  // must run immediately (no `needs:`), and the asset upload must wait for
  // it. Give it a `needs:` on the build and the release sits on
  // `/releases/latest` with no binaries for the ~25 minutes the native macOS
  // legs take — which is the exact production breakage #3654 is about.
  const redraftEntry = jobDoing(release, "--draft=true");
  if (!redraftEntry) {
    problems.push("R9: release.yml has no job that pulls an incomplete published release back to draft.");
  } else {
    if (needsOf(redraftEntry[1]).length > 0) {
      problems.push(
        `R9: the re-draft guard (${redraftEntry[0]}) has \`needs: ${needsOf(redraftEntry[1]).join(", ")}\` — it must ` +
          "run immediately, or an incomplete release stays on /releases/latest for the whole build.",
      );
    }
    if (uploadEntry && !needsOf(uploadEntry[1]).includes(redraftEntry[0])) {
      problems.push(
        `R9: the upload job (${uploadEntry[0]}) does not \`needs: ${redraftEntry[0]}\` — assets could be attached ` +
          "to a release that was never checked for existence.",
      );
    }
  }

  if (undraftEntry && gateEntry && !needsOf(undraftEntry[1]).includes(gateEntry[0])) {
    problems.push(`R5: the un-draft job (${undraftEntry[0]}) does not \`needs: ${gateEntry[0]}\`.`);
  }

  // R15 — a tag push with NO GitHub Release must AUTO-HEAL, not skip (#4331).
  // v0.20.3/v0.20.4 were tagged, image-built and rolled, but the operator
  // skipped `gh release create`; `publish`/`npm`/`finalize` all `needs:` the
  // guard, so a guard that merely fails on "no release" silently strands the
  // irreversible npm publish (npm `latest` stuck at 0.20.2, users ETARGET).
  // The fix: guard auto-creates the release from CHANGELOG.md. This rule pins
  // the three properties that keep that safe:
  //   1. the auto-create EXISTS (`gh release create`),
  //   2. it is always a DRAFT (finalize is still the only publisher — never
  //      an early `/releases/latest` flip), and
  //   3. its notes come from the CHANGELOG extractor, never invented — a
  //      missing section makes the extractor exit non-zero and guard FAIL
  //      LOUDLY instead of shipping an empty release.
  // It must also live in the guard job itself (same job as the re-draft),
  // so it inherits guard's no-`needs:` early slot and the `upload needs
  // guard` edge R9 already asserts — i.e. it runs before any asset upload.
  const createEntry = jobDoing(release, "gh release create");
  if (!createEntry) {
    problems.push(
      "R15: release.yml has no job that auto-creates the GitHub Release when none exists — a tag push with the " +
        "manual `gh release create` skipped would fail the guard and silently skip npm (the v0.20.3/v0.20.4 defect).",
    );
  } else {
    const createStep = stepsOf(createEntry[1]).find((s) => (s.run ?? "").includes("gh release create"))!;
    // Strip shell comment lines before locating the invocation: the step's
    // prose (and the skill it cites) mentions `gh release create` too, and a
    // rule that read a comment would misfire on the real, correct command.
    const body = (createStep.run ?? "")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    // Scope the `--draft` check to the create INVOCATION itself — a line that
    // STARTS with `gh release create` (through its backslash line-
    // continuations), not the same command quoted inside an `echo` error
    // string or the `gh release edit --draft=true` re-draft in the same step.
    const createCmd = /^\s*gh release create(?:[^\n]*\\\n)*[^\n]*/m.exec(body)?.[0] ?? "";
    if (!/(^|\s)--draft(\s|$)/.test(createCmd)) {
      problems.push(
        `R15: the auto-create job (${createEntry[0]}) runs \`gh release create\` without \`--draft\` — an auto-created ` +
          "release would become /releases/latest immediately, breaking every `curl | sh` install until finalize.",
      );
    }
    if (!body.includes("extract-changelog-section.mjs")) {
      problems.push(
        `R15: the auto-create job (${createEntry[0]}) does not derive its notes from extract-changelog-section.mjs — ` +
          "an auto-created release must come from CHANGELOG.md (and FAIL LOUDLY when the section is absent), never be " +
          "invented with empty/auto notes.",
      );
    }
    if (redraftEntry && createEntry[0] !== redraftEntry[0]) {
      problems.push(
        `R15: the auto-create lives in job ${createEntry[0]}, not in the guard job (${redraftEntry[0]}) — it must run ` +
          "in the guard so it inherits the no-`needs:` early slot and the `upload needs guard` ordering R9 asserts.",
      );
    }
  }

  // R6 — nothing on the chain may swallow an upstream failure. `always()`
  // and `cancelled()` override the default all-needs-succeeded semantics;
  // `continue-on-error` turns a red step green.
  for (const [file, wf] of [
    ["release.yml", release],
    ["npm-publish.yml", npmPublish],
    // promote.yml joined the chain with #3685 — release.yml calls it to
    // move `:latest`, so the same swallow-nothing rule binds it.
    ["promote.yml", promote],
  ] as const) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      const cond = String(job.if ?? "");
      if (/\balways\s*\(/.test(cond) || /\bcancelled\s*\(/.test(cond)) {
        problems.push(`R6: ${file} job ${id} has \`if: ${cond.trim()}\` — that runs it past a failed dependency.`);
      }
      if (job["continue-on-error"] === true) {
        problems.push(`R6: ${file} job ${id} sets continue-on-error — a failed leg would report green.`);
      }
      for (const s of stepsOf(job)) {
        if ((s as Record<string, unknown>)["continue-on-error"] === true) {
          problems.push(`R6: ${file} job ${id} step "${s.name ?? "?"}" sets continue-on-error.`);
        }
      }
    }
  }

  // R7 — npm-publish re-proves the preconditions from inside its OWN run,
  // before the irreversible step, so a hand `workflow_dispatch` cannot
  // bypass the orchestrator's ordering.
  const publishJob = Object.values(npmPublish.jobs ?? {}).find((j) =>
    stepsOf(j).some((s) => (s.run ?? "").includes("npm publish ")),
  );
  if (!publishJob) {
    problems.push("R7: npm-publish.yml has no `npm publish` step to gate.");
  } else {
    const steps = stepsOf(publishJob);
    const idxOf = (needle: string) => steps.findIndex((s) => (s.run ?? "").includes(needle));
    const publishIdx = idxOf("npm publish ");
    for (const gate of ["assert-release-assets-complete.mjs", "classify-workflow-run.mjs"]) {
      const gi = idxOf(gate);
      if (gi === -1) {
        problems.push(`R7: npm-publish.yml never runs ${gate} — a direct dispatch could half-ship.`);
      } else if (gi > publishIdx) {
        problems.push(`R7: npm-publish.yml runs ${gate} AFTER \`npm publish\` — too late to refuse.`);
      }
    }
  }

  // R8 — no `${{ }}` inside a `run:` body. GitHub materialises expressions
  // into the shell script written to the runner's disk; for `secrets.*` that
  // defeats log masking, and for anything attacker-influenced it is script
  // injection. Both of these workflows hold write-scoped credentials.
  for (const [file, wf] of [
    ["release.yml", release],
    ["npm-publish.yml", npmPublish],
    // promote.yml too, since #3685: it is on the release path and holds
    // `packages: write`, and its `inputs.from` / `inputs.to` are
    // operator-supplied strings on the workflow_dispatch path.
    ["promote.yml", promote],
  ] as const) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      for (const s of stepsOf(job)) {
        if ((s.run ?? "").includes("${{")) {
          problems.push(
            `R8: ${file} job ${id} step "${s.name ?? "?"}" interpolates \`\${{ }}\` inside \`run:\` — pass it via \`env:\`.`,
          );
        }
      }
    }
  }

  // R10 — every caller of the completeness gate must bind `EXPECT_TAG`.
  // The script reads the tag to check from that variable and exits 1
  // ("EXPECT_TAG is required") when it is blank. Crucially that exit is
  // INDISTINGUISHABLE, to the shell wrapping it, from "assets are missing":
  // both callers branch on `rc -ne 0`. So forgetting the variable does not
  // skip the gate, it fails the gate — on every release, forever, with a
  // message blaming the assets. v0.19.20 shipped exactly this: the upload
  // step bound a step-local `TAG` while the assertion read `EXPECT_TAG`, so
  // `publish` went red with all five assets already correctly attached,
  // `npm` and `finalize` were skipped, and the release stranded as a draft
  // while `/releases/latest` kept serving the asset-less v0.19.19.
  //
  // R7 asserts the gate is CALLED and called early enough; R10 asserts the
  // call can actually run. Neither implies the other.
  for (const [file, wf] of [
    ["release.yml", release],
    ["npm-publish.yml", npmPublish],
  ] as const) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      for (const s of stepsOf(job)) {
        if (!(s.run ?? "").includes("assert-release-assets-complete.mjs")) continue;
        if (!envBound(wf, job, s, "EXPECT_TAG")) {
          problems.push(
            `R10: ${file} job ${id} step "${s.name ?? "?"}" runs assert-release-assets-complete.mjs without ` +
              "binding a non-empty `EXPECT_TAG` — the script exits 1 and the caller misreports it as missing assets.",
          );
        }
      }
    }
  }

  // R11 — every job that runs the completeness gate must hold
  // `contents: write`, because that is what lets it SEE A DRAFT.
  //
  // `GET /repos/{o}/{r}/releases` returns draft releases only to a caller
  // with push access; to a `contents: read` token the drafts simply are not
  // in the payload. The release is a DRAFT at every point this gate runs —
  // `finalize` is the only thing that un-drafts it, and it runs last — so a
  // read-scoped caller gets `found:false` for a release that exists and is
  // complete, and exits 4 ("no release exists for this tag").
  //
  // That exit is INDISTINGUISHABLE, to every wrapper on this chain, from
  // "the assets are missing": all of them branch on `rc -ne 0`. So the wrong
  // permission does not skip the gate, it fails the gate — on every release,
  // forever, blaming the assets. Exactly the shape of the R10 defect, one
  // axis over: R10 is about the ENV a gate call needs, R11 is about the
  // PERMISSION the same call needs. Neither implies the other.
  //
  // v0.19.21 shipped this. The proof is a three-way control inside one run
  // (30189755957) — same script, same endpoint, same tag, differing only in
  // this permission:
  //     guard   (contents: write) → {"found":true,"draft":true,...}
  //     publish (contents: write) → {"found":true,"draft":true,"missing":[]}
  //     npm     (contents: read)  → {"found":false,"draft":null,...}
  // All five assets were attached; npm refused to publish anyway and
  // `finalize` was skipped, stranding the release as a draft while
  // `/releases/latest` kept serving the asset-less v0.19.19.
  //
  // It stayed latent until then because before #3654 releases were created
  // PUBLISHED, and a published release is visible to any token. The
  // draft-until-finalize model is what made `contents: read` insufficient.
  for (const [file, wf] of [
    ["release.yml", release],
    ["npm-publish.yml", npmPublish],
  ] as const) {
    for (const [id, job] of Object.entries(wf.jobs ?? {})) {
      if (!stepsOf(job).some((s) => (s.run ?? "").includes("assert-release-assets-complete.mjs"))) continue;
      const scope = contentsScope(wf, job);
      if (scope !== "write") {
        problems.push(
          `R11: ${file} job ${id} runs assert-release-assets-complete.mjs with \`contents: ${scope ?? "(unset)"}\` — ` +
            "the releases LIST endpoint hides DRAFTS from a token without push access, so the gate reports " +
            "`found:false` for a complete release and blocks every release.",
        );
      }
    }
  }

  // R11 (caller half) — a job that CALLS npm-publish.yml must itself grant
  // `contents: write`. A caller job's `permissions:` block is a CAP on the
  // token the reusable workflow receives, not a default it can exceed, so
  // raising the permission inside npm-publish.yml alone is a silent no-op:
  // the callee would still run read-scoped and the gate would still go red.
  // Both halves or neither.
  if (Object.values(npmPublish.jobs ?? {}).some((j) => stepsOf(j).some((s) => (s.run ?? "").includes("assert-release-assets-complete.mjs")))) {
    for (const [id, job] of releaseJobs) {
      if (!(job.uses ?? "").endsWith("npm-publish.yml")) continue;
      const scope = contentsScope(release, job);
      if (scope !== "write") {
        problems.push(
          `R11: release.yml job ${id} calls npm-publish.yml with \`contents: ${scope ?? "(unset)"}\` — a caller job's ` +
            "permissions CAP the called workflow's token, so npm-publish.yml's own `contents: write` is neutered " +
            "and its draft-visibility gate fails closed on every release.",
        );
      }
    }
  }

  // ── #3685: `:latest` must follow the RELEASE, not the tag push ────────
  //
  // docker-images.yml keeps its own `tags: ["v*"]` trigger and runs in
  // parallel with this pipeline, with no dependency on the binary build,
  // the release assets or npm. While it also moved `:latest` there, a tag
  // whose `release` run went red still left `ghcr.io/<owner>/switchroom-*:
  // latest` pointing at that version — the one half-ship #3654 explicitly
  // left open. Same reason this file exists at all: none of it is
  // observable on a PR, and the next time anyone finds out is a release.

  // R12 — a `v*` tag push publishes the VERSION tag only.
  const tagBranches = tagPushBranches(docker);
  if (tagBranches.length < 4) {
    problems.push(
      `R12: docker-images.yml has ${tagBranches.length} \`refs/tags/v*\` tag-assignment branches; expected at ` +
        "least 4 (merge-base, merge-dependents, build-hindsight, build-voice). The rule cannot be checked " +
        "against branches that no longer exist — re-point it at whatever replaced them.",
    );
  }
  for (const b of tagBranches) {
    if (/latest/.test(b.body)) {
      problems.push(
        `R12: docker-images.yml job ${b.job} step "${b.step}" assigns \`:latest\` on a \`v*\` tag push — that ` +
          "moves it on the TAG, not on the release succeeding, so a red release leaves :latest broken. " +
          "release.yml's promote job owns :latest now.",
      );
    }
    if (!/TAG_VERSION/.test(b.body)) {
      problems.push(
        `R12: docker-images.yml job ${b.job} step "${b.step}" no longer publishes the \`:vX.Y.Z\` version tag on a ` +
          "tag push — release.yml's images-gate and the :latest promotion both depend on it existing.",
      );
    }
  }

  // R13 — and release.yml is what moves it, strictly after the release is
  // published. `needs: <the un-draft job>` inherits the whole green chain
  // (assets + images-gate + npm), so this one edge is the guarantee.
  if (!promote.on || !Object.prototype.hasOwnProperty.call(promote.on, "workflow_call")) {
    problems.push("R13: promote.yml has no `workflow_call` trigger — release.yml cannot invoke it.");
  }
  const latestEntry = releaseJobs.find(([, j]) => (j.uses ?? "").endsWith("promote.yml"));
  if (!latestEntry) {
    problems.push(
      "R13: release.yml has no job that promotes the release's image tag to `:latest`. With R12 in force nothing " +
        "else does, so `:latest` would freeze at the last main push forever.",
    );
  } else {
    const [id, job] = latestEntry;
    const to = String(job.with?.to ?? "");
    const from = String(job.with?.from ?? "");
    if (to !== "latest") {
      problems.push(`R13: the promotion job (${id}) promotes to '${to}', not 'latest'.`);
    }
    if (!from.includes("github.ref_name")) {
      problems.push(
        `R13: the promotion job (${id}) promotes from '${from}' rather than this run's tag — :latest must land on ` +
          "the image built for the tag being released.",
      );
    }
    if (undraftEntry && !needsOf(job).includes(undraftEntry[0])) {
      problems.push(
        `R13: the promotion job (${id}) does not \`needs: ${undraftEntry[0]}\` — :latest could move for a release ` +
          "that is still a draft, or whose npm/asset legs failed. That is the #3685 defect with a new owner.",
      );
    }
    // R13 (gating half) — `needs:` only ORDERS the job; the `if:` decides
    // whether it runs at all. Those are independent, and only the `needs:`
    // half was asserted when #3735 landed.
    //
    // The hole it leaves is silent by construction. Narrow the promotion
    // job's `if:` to the dispatch clause alone — `github.event_name ==
    // 'workflow_dispatch' && inputs.dry_run == false`, a plausible tidy-up
    // since the comment above the job advertises exactly that recovery
    // lever — and the job never runs on a tag push. Every leg stays green,
    // the release publishes, `:vX.Y.Z` ships, and `:latest` never advances
    // again. Nothing fails; you find out by diffing manifest digests.
    //
    // Asserted as equality with the un-draft job's own `if:` rather than a
    // literal expression, because the requirement really is relative:
    // `:latest` must move in exactly the circumstances the release is
    // published in — no more (a dry run must not move it) and no less (a
    // real tag push must). Pinning it to `finalize` also catches DRIFT —
    // change the release's trigger gating and forget the promotion's and
    // this fires, which is what a hardcoded string would miss.
    // Normalised before comparing, because two spellings GitHub treats as
    // identical must not fail the rule — a rule that reds on a cosmetic edit
    // gets silenced rather than fixed. Both conditions are folded YAML
    // scalars whose continuation lines are more-indented, so YAML really does
    // preserve their newlines and a re-wrap really does change the parsed
    // string; and `if: ${{ expr }}` is exactly equivalent to `if: expr`,
    // which is the form most actions linters and most humans reach for.
    const normalizeIf = (x: unknown) =>
      String(x ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1")
        .trim();
    if (undraftEntry) {
      const promoteIf = normalizeIf(job.if);
      const undraftIf = normalizeIf(undraftEntry[1].if);
      // Only meaningful while the un-draft job HAS a gate to copy. If neither
      // has one, that is the un-draft job's defect, not the promotion's —
      // fall through to the equality branch so the message blames the right
      // job instead of pointing at an ungated `finalize` as the model.
      if (promoteIf === "" && undraftIf !== "") {
        problems.push(
          `R13: the promotion job (${id}) has no \`if:\` — it must carry the same EXPLICIT gate as the un-draft ` +
            `job (${undraftEntry[0]}). It is skipped today only because \`needs: ${undraftEntry[0]}\` propagates ` +
            "that job's skip, which is one refactor of the `needs:` edge away from not holding.",
        );
      } else if (promoteIf !== undraftIf) {
        problems.push(
          `R13: the promotion job (${id}) has \`if: ${promoteIf}\` but the un-draft job (${undraftEntry[0]}) has ` +
            `\`if: ${undraftIf}\` — :latest must move in exactly the cases the release is published in. Narrowing ` +
            "this one leaves :latest silently frozen on tag pushes with every leg still green.",
        );
      }
    }
  }

  // R14 — promote.yml's matrix must cover every image docker-images
  // publishes on a tag. An image missing from it is one whose `:latest`
  // silently stops advancing at release time: nothing fails, the tag just
  // never moves. `web` was exactly this — in docker-images' dependents
  // matrix, absent from promote.yml — harmless while promote was
  // dispatch-only, a real hole once the release path depends on it.
  const expectedImages = dockerPublishedImages(docker);
  const promoteImages = [
    ...((promote.jobs?.promote?.strategy?.matrix?.image as unknown[] | undefined) ?? []).map(String),
  ].sort();
  const uncovered = expectedImages.filter((n) => !promoteImages.includes(n));
  if (uncovered.length > 0) {
    problems.push(
      `R14: promote.yml's matrix omits [${uncovered.join(", ")}], which docker-images.yml publishes on a tag — ` +
        "their `:latest` would silently stop advancing at release time.",
    );
  }

  return problems;
}

const RELEASE = load("release.yml");
const NPM = load("npm-publish.yml");
const DOCKER = load("docker-images.yml");
const PROMOTE = load("promote.yml");

describe("release pipeline gating — the real workflows", () => {
  it("has no gating problems", () => {
    expect(auditGating(RELEASE, NPM, DOCKER, PROMOTE)).toEqual([]);
  });

  it("keeps npm-publish unreachable from a tag push, and callable by release.yml", () => {
    expect(Object.keys(NPM.on ?? {}).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  });

  it("still fires the orchestrator itself on a v* tag", () => {
    // If release.yml stopped triggering on the tag, nothing would drive the
    // pipeline and npm would simply never publish — a different half-ship.
    const push = (RELEASE.on as { push?: { tags?: string[] } })?.push;
    expect(push?.tags).toContain("v*");
  });

  it("still relies on docker-images firing on the same tag", () => {
    // The images gate polls for that run. If docker-images stopped
    // triggering on tags, the gate would (correctly) fail closed and block
    // every release — so this asserts the assumption it is built on.
    const push = (DOCKER.on as { push?: { tags?: string[] } })?.push;
    expect(push?.tags).toContain("v*");
  });

  it("gates the images wait on the docker-images workflow specifically", () => {
    const gate = jobDoing(RELEASE, "classify-workflow-run.mjs");
    expect(gate).toBeDefined();
    const body = stepsOf(gate![1])
      .map((s) => s.run ?? "")
      .join("\n");
    expect(body).toContain("workflows/docker-images.yml/runs");
    expect(body).toContain("head_sha=");
  });

  it("preserves the native-runner property release.yml exists for (#3634)", () => {
    // The orchestration rework must not quietly move the macOS legs onto a
    // Linux runner: a cross-compiled arm64 Mach-O ships unsigned and is
    // SIGKILLed on exec, and the codesign step is `if:`-gated on the runner.
    const targets = (RELEASE.jobs?.build as unknown as { strategy?: { matrix?: { target?: { asset: string; runner: string }[] } } })
      ?.strategy?.matrix?.target;
    expect(targets).toBeDefined();
    for (const t of targets!) {
      const wantMac = t.asset.includes("macos");
      expect(t.runner.startsWith("macos-")).toBe(wantMac);
    }
  });
});

/** Deep-clone the real workflows and weaken them the way a careless edit would. */
function mutate(fn: (r: Workflow, n: Workflow, d: Workflow, p: Workflow) => void): string[] {
  const r = clone(RELEASE);
  const n = clone(NPM);
  const d = clone(DOCKER);
  const p = clone(PROMOTE);
  fn(r, n, d, p);
  return auditGating(r, n, d, p);
}

describe("release pipeline gating — every rule is proved by mutation", () => {
  it("R1: re-adding a push trigger to npm-publish is caught", () => {
    const p = mutate((_r, n) => {
      (n.on as Record<string, unknown>).push = { tags: ["v*"] };
    });
    expect(p.join("\n")).toMatch(/R1:/);
  });

  it("R2: removing workflow_call from npm-publish is caught", () => {
    const p = mutate((_r, n) => {
      delete (n.on as Record<string, unknown>).workflow_call;
    });
    expect(p.join("\n")).toMatch(/R2:/);
  });

  it("R4: dropping the images gate from the npm job's needs is caught", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("npm-publish.yml"))!;
      job.needs = needsOf(job).filter((x) => x !== "images-gate");
    });
    expect(p.join("\n")).toMatch(/R4:.*images-gate/);
  });

  it("R4: dropping the asset-upload job from the npm job's needs is caught", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("npm-publish.yml"))!;
      job.needs = needsOf(job).filter((x) => x !== "publish");
    });
    expect(p.join("\n")).toMatch(/R4:.*publish/);
  });

  it("R5: un-drafting without waiting for npm is caught", () => {
    const p = mutate((r) => {
      const [, job] = jobDoing(r, "--draft=false")!;
      job.needs = needsOf(job).filter((x) => x !== "npm");
    });
    expect(p.join("\n")).toMatch(/R5:.*npm/);
  });

  it("R5: un-drafting from a second, earlier job is caught", () => {
    const p = mutate((r) => {
      const [, upload] = jobDoing(r, "gh release upload")!;
      stepsOf(upload).push({ name: "sneaky", run: 'gh release edit "$TAG" --draft=false' });
    });
    expect(p.join("\n")).toMatch(/R5: 2 jobs take the release out of draft/);
  });

  it("R6: `if: always()` anywhere on the chain is caught", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("npm-publish.yml"))!;
      job.if = "always()";
    });
    expect(p.join("\n")).toMatch(/R6:.*always/);
  });

  it("R6: `!cancelled()` — the idiom used elsewhere in this repo — is caught here", () => {
    const p = mutate((r) => {
      const [, gate] = jobDoing(r, "classify-workflow-run.mjs")!;
      gate.if = "${{ !cancelled() }}";
    });
    expect(p.join("\n")).toMatch(/R6:.*cancelled/);
  });

  it("R6: continue-on-error on the gate job or its step is caught", () => {
    expect(
      mutate((r) => {
        jobDoing(r, "classify-workflow-run.mjs")![1]["continue-on-error"] = true;
      }).join("\n"),
    ).toMatch(/R6:.*continue-on-error/);
    expect(
      mutate((r) => {
        const s = stepsOf(jobDoing(r, "classify-workflow-run.mjs")![1])[1] as Record<string, unknown>;
        s["continue-on-error"] = true;
      }).join("\n"),
    ).toMatch(/R6:.*continue-on-error/);
  });

  it("R7: removing npm-publish's own release-completeness gate is caught", () => {
    const p = mutate((_r, n) => {
      const job = Object.values(n.jobs!)[0];
      job.steps = stepsOf(job).filter((s) => !(s.run ?? "").includes("assert-release-assets-complete.mjs"));
    });
    expect(p.join("\n")).toMatch(/R7: npm-publish\.yml never runs assert-release-assets-complete/);
  });

  it("R7: removing npm-publish's own docker-images gate is caught", () => {
    const p = mutate((_r, n) => {
      const job = Object.values(n.jobs!)[0];
      job.steps = stepsOf(job).filter((s) => !(s.run ?? "").includes("classify-workflow-run.mjs"));
    });
    expect(p.join("\n")).toMatch(/R7: npm-publish\.yml never runs classify-workflow-run/);
  });

  it("R7: moving a gate after `npm publish` is caught", () => {
    const p = mutate((_r, n) => {
      const job = Object.values(n.jobs!)[0];
      const steps = stepsOf(job);
      const i = steps.findIndex((s) => (s.run ?? "").includes("classify-workflow-run.mjs"));
      const [gate] = steps.splice(i, 1);
      steps.push(gate);
    });
    expect(p.join("\n")).toMatch(/R7:.*AFTER `npm publish`/);
  });

  it("R9: making the re-draft guard wait on the build is caught", () => {
    const p = mutate((r) => {
      jobDoing(r, "--draft=true")![1].needs = ["bundle"];
    });
    expect(p.join("\n")).toMatch(/R9: the re-draft guard .* must\s+run immediately/s);
  });

  it("R9: uploading assets without waiting for the guard is caught", () => {
    const p = mutate((r) => {
      const [, upload] = jobDoing(r, "gh release upload")!;
      upload.needs = needsOf(upload).filter((x) => x !== "guard");
    });
    expect(p.join("\n")).toMatch(/R9: the upload job/);
  });

  it("R9: deleting the re-draft guard entirely is caught", () => {
    const p = mutate((r) => {
      const [id] = jobDoing(r, "--draft=true")!;
      delete r.jobs![id];
    });
    expect(p.join("\n")).toMatch(/R9: release\.yml has no job that pulls an incomplete published release back/);
  });

  // ── R15: the v0.20.3/v0.20.4 regression, reproduced ────────────────────
  //
  // Those tags shipped with no GitHub Release because `gh release create` was
  // skipped, and the pre-#4331 guard FAILED on that instead of healing it —
  // so `publish`/`npm`/`finalize` were skipped and npm `latest` silently
  // stayed at 0.20.2. Each mutation removes one property of the auto-heal.
  const guardCreateStep = (r: Workflow): Step =>
    stepsOf(jobDoing(r, "gh release create")![1]).find((s) => (s.run ?? "").includes("gh release create"))!;

  it("R15: removing the auto-create so a missing release fails instead of healing is caught", () => {
    const p = mutate((r) => {
      const s = guardCreateStep(r);
      // Neuter only the create invocation; the `--draft=true` re-draft in the
      // same step stays, so this is the "guard no longer heals" regression and
      // NOT an R9 re-draft-guard removal.
      s.run = s.run!.replace(/gh release create/g, "gh release SKIP");
    });
    expect(p.join("\n")).toMatch(/R15: release\.yml has no job that auto-creates the GitHub Release/);
  });

  it("R15: auto-creating WITHOUT --draft (an instant /releases/latest flip) is caught", () => {
    const p = mutate((r) => {
      const s = guardCreateStep(r);
      s.run = s.run!.replace("--draft --target", "--target");
    });
    expect(p.join("\n")).toMatch(/R15: the auto-create job .* without `--draft`/);
  });

  it("R15: inventing notes instead of deriving them from CHANGELOG.md is caught", () => {
    const p = mutate((r) => {
      const s = guardCreateStep(r);
      s.run = s.run!.replace(/extract-changelog-section\.mjs/g, "invent-notes.mjs");
    });
    expect(p.join("\n")).toMatch(/R15: the auto-create job .* extract-changelog-section\.mjs/);
  });

  it("R15: moving the auto-create out of the guard job is caught", () => {
    const p = mutate((r) => {
      // Splice the create invocation into `publish` (which runs AFTER guard,
      // so a missing release would already have failed the guard) — the heal
      // must live in the guard itself.
      const guardStep = guardCreateStep(r);
      const createCmd = /gh release create(?:[^\n]*\\\n)*[^\n]*/.exec(guardStep.run!)![0];
      guardStep.run = guardStep.run!.replace(/gh release create/g, "gh release SKIP");
      const [, upload] = jobDoing(r, "gh release upload")!;
      stepsOf(upload)[0]!.run = `${createCmd}\nnode scripts/ci/extract-changelog-section.mjs --tag x\n${stepsOf(upload)[0]!.run ?? ""}`;
    });
    expect(p.join("\n")).toMatch(/R15: the auto-create lives in job .*, not in the guard job/);
  });

  it("R8: interpolating a secret into a run body is caught", () => {
    const p = mutate((_r, n) => {
      const job = Object.values(n.jobs!)[0];
      stepsOf(job)[0]!.run = 'echo "${{ secrets.NPM_TOKEN }}" > /tmp/x';
    });
    expect(p.join("\n")).toMatch(/R8:.*interpolates/);
  });

  // The exact v0.19.20 regression: `publish` bound `TAG`, the assertion read
  // `EXPECT_TAG`. Reproduced as a mutation so it can never come back.
  it("R10: the v0.19.20 regression — the upload step binding `TAG` instead of `EXPECT_TAG` — is caught", () => {
    const p = mutate((r) => {
      const [, upload] = jobDoing(r, "gh release upload")!;
      const step = stepsOf(upload).find((s) => (s.run ?? "").includes("assert-release-assets-complete.mjs"))!;
      const tag = step.env!.EXPECT_TAG;
      delete step.env!.EXPECT_TAG;
      step.env!.TAG = tag;
    });
    expect(p.join("\n")).toMatch(/R10:.*release\.yml.*EXPECT_TAG/);
  });

  it("R10: binding EXPECT_TAG to an empty value is caught (blank is not a binding)", () => {
    const p = mutate((r) => {
      const [, upload] = jobDoing(r, "gh release upload")!;
      const step = stepsOf(upload).find((s) => (s.run ?? "").includes("assert-release-assets-complete.mjs"))!;
      step.env!.EXPECT_TAG = "";
    });
    expect(p.join("\n")).toMatch(/R10:.*EXPECT_TAG/);
  });

  it("R10: dropping EXPECT_TAG from npm-publish's own completeness gate is caught", () => {
    const p = mutate((_r, n) => {
      for (const job of Object.values(n.jobs!)) {
        for (const s of stepsOf(job)) {
          if ((s.run ?? "").includes("assert-release-assets-complete.mjs")) delete s.env?.EXPECT_TAG;
        }
      }
    });
    expect(p.join("\n")).toMatch(/R10:.*npm-publish\.yml.*EXPECT_TAG/);
  });

  // ── R11: the v0.19.21 regression ───────────────────────────────────────
  //
  // Reconstructing the tag's ACTUAL configuration is the proof that matters.
  // `git show v0.19.21:.github/workflows/{release,npm-publish}.yml` differs
  // from the fixed files in exactly these two lines, so setting them back
  // reproduces the tree that died — and R11 is the only rule that fires on
  // it, which is also how we know it went undetected before.
  it("R11: the v0.19.21 tree — `contents: read` on both halves of the npm call — is caught", () => {
    const p = mutate((r, n) => {
      (r.jobs!.npm.permissions as Record<string, string>).contents = "read";
      (n.permissions as Record<string, string>).contents = "read";
    });
    expect(p.join("\n")).toMatch(/R11: npm-publish\.yml job publish runs assert-release-assets-complete\.mjs with `contents: read`/);
    expect(p.join("\n")).toMatch(/R11: release\.yml job npm calls npm-publish\.yml with `contents: read`/);
    // …and nothing else. The pipeline was otherwise clean, which is exactly
    // why two tags died before anyone could see this.
    expect(p.filter((x) => !x.startsWith("R11:"))).toEqual([]);
  });

  it("R11: fixing only npm-publish.yml, leaving the caller capped at read, is caught", () => {
    // The half-fix that looks right and does nothing: the callee asks for
    // write, the caller's block never grants it.
    const p = mutate((r) => {
      (r.jobs!.npm.permissions as Record<string, string>).contents = "read";
    });
    expect(p.join("\n")).toMatch(/R11: release\.yml job npm calls npm-publish\.yml .*CAP/s);
  });

  it("R11: fixing only the caller, leaving npm-publish.yml at read, is caught", () => {
    const p = mutate((_r, n) => {
      (n.permissions as Record<string, string>).contents = "read";
    });
    expect(p.join("\n")).toMatch(/R11: npm-publish\.yml job publish runs assert-release-assets-complete/);
  });

  it("R11: downgrading the un-draft job so it can no longer see the draft is caught", () => {
    // `finalize` has never executed in any release to date; it re-runs the
    // same gate on the same draft and would fail the same way.
    const p = mutate((r) => {
      (jobDoing(r, "--draft=false")![1].permissions as Record<string, string>).contents = "read";
    });
    expect(p.join("\n")).toMatch(/R11: release\.yml job finalize/);
  });

  it("R11: dropping a gate job's permissions block entirely is caught (repo default is not a guarantee)", () => {
    const p = mutate((r) => {
      delete jobDoing(r, "gh release upload")![1].permissions;
    });
    // Falls back to release.yml's workflow-level `contents: read`.
    expect(p.join("\n")).toMatch(/R11: release\.yml job publish .*`contents: read`/);
  });

  // Guards R11 against over-firing on the legal shorthand: `write-all` really
  // does grant contents:write, and a rule that flagged it would push people
  // toward silencing the rule rather than fixing the permission.
  it("R11: the `write-all` shorthand satisfies the rule", () => {
    const p = mutate((r) => {
      jobDoing(r, "gh release upload")![1].permissions = "write-all";
    });
    expect(p.join("\n")).not.toMatch(/R11:/);
  });

  // Guards the rule against under-firing on the OTHER shorthand.
  it("R11: the `read-all` shorthand is caught", () => {
    const p = mutate((r) => {
      jobDoing(r, "gh release upload")![1].permissions = "read-all";
    });
    expect(p.join("\n")).toMatch(/R11: release\.yml job publish .*`contents: read`/);
  });

  // Permissions do NOT layer the way env does: a job block REPLACES the
  // workflow block, so a job that sets only `actions: read` silently drops
  // contents to `none`. Pin that, because it is the subtle way this defect
  // returns.
  it("R11: a job block that omits `contents:` drops it to none, and is caught", () => {
    const p = mutate((r) => {
      jobDoing(r, "--draft=false")![1].permissions = { actions: "read" };
    });
    expect(p.join("\n")).toMatch(/R11: release\.yml job finalize .*`contents: none`/);
  });

  // ── R12/R13/R14: the #3685 defect, reproduced ──────────────────────────
  //
  // The pre-#3685 tree is the mutation that matters: putting `-t
  // "${IMAGE}:latest"` back into docker-images' tag branch IS the bug, and
  // R12 is the only rule that fires on it — which is also why it survived
  // #3654 unnoticed.
  it("R12: the pre-#3685 tree — docker-images moving `:latest` on a tag push — is caught", () => {
    const p = mutate((_r, _n, d) => {
      const step = stepsOf(d.jobs!["merge-base"]!).find((s) => (s.run ?? "").includes("refs/tags/v*"))!;
      step.run = step.run!.replace(
        'TAG_ARGS=(-t "${IMAGE}:${TAG_VERSION}")',
        'TAG_ARGS=(-t "${IMAGE}:${TAG_VERSION}" -t "${IMAGE}:latest")',
      );
    });
    expect(p.join("\n")).toMatch(/R12: docker-images\.yml job merge-base .*assigns `:latest` on a `v\*` tag push/s);
  });

  it("R12: the same regression in the hindsight/voice `tags=` form is caught", () => {
    const p = mutate((_r, _n, d) => {
      const step = stepsOf(d.jobs!["build-voice"]!).find((s) => (s.run ?? "").includes("refs/tags/v*"))!;
      step.run = step.run!.replace(
        'echo "tags=${IMAGE}:${TAG_VERSION}" >> "$GITHUB_OUTPUT"',
        'echo "tags=${IMAGE}:${TAG_VERSION},${IMAGE}:latest" >> "$GITHUB_OUTPUT"',
      );
    });
    expect(p.join("\n")).toMatch(/R12: docker-images\.yml job build-voice/);
  });

  it("R12: dropping the version tag from a tag push is caught too", () => {
    // The over-correction: publishing nothing on a tag would starve both
    // images-gate and the :latest promotion.
    const p = mutate((_r, _n, d) => {
      const step = stepsOf(d.jobs!["merge-dependents"]!).find((s) => (s.run ?? "").includes("refs/tags/v*"))!;
      step.run = step.run!.replace('TAG_VERSION="${GITHUB_REF#refs/tags/}"', ":").replace(
        'TAG_ARGS=(-t "${IMAGE}:${TAG_VERSION}")',
        'TAG_ARGS=(-t "${IMAGE}:x")',
      );
    });
    expect(p.join("\n")).toMatch(/R12: docker-images\.yml job merge-dependents .*no longer publishes/s);
  });

  it("R12: deleting the tag branches outright cannot vacuously pass", () => {
    const p = mutate((_r, _n, d) => {
      for (const job of Object.values(d.jobs!)) {
        for (const s of stepsOf(job)) {
          if (s.run) s.run = s.run.replace(/refs\/tags\/v\*/g, "refs/heads/nope");
        }
      }
    });
    expect(p.join("\n")).toMatch(/R12: docker-images\.yml has 0 `refs\/tags\/v\*` tag-assignment branches/);
  });

  it("R13: deleting the :latest promotion job is caught", () => {
    const p = mutate((r) => {
      const id = Object.entries(r.jobs!).find(([, j]) => (j.uses ?? "").endsWith("promote.yml"))![0];
      delete r.jobs![id];
    });
    expect(p.join("\n")).toMatch(/R13: release\.yml has no job that promotes/);
  });

  it("R13: promoting :latest without waiting for the release to be published is caught", () => {
    // The tempting "move it early so the fleet gets it sooner" edit — which
    // reinstates #3685 inside release.yml instead of docker-images.yml.
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!;
      job.needs = ["bundle"];
    });
    expect(p.join("\n")).toMatch(/R13: the promotion job \(images-latest\) does not `needs: finalize`/);
  });

  // The gating half of R13. `needs:` and `if:` are independent: the mutation
  // below leaves `needs: finalize`, `with.from`, `with.to` and every other
  // asserted property untouched, so before this rule existed the whole file
  // stayed green while `:latest` stopped advancing on every future release.
  it("R13: narrowing the promotion job's `if:` so it never fires on a tag push is caught", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!;
      // The plausible edit: keep only the dispatch clause, because the job's
      // own comment names `gh workflow run promote.yml` as the recovery
      // lever. A tag push then skips it silently, forever.
      job.if = "github.event_name == 'workflow_dispatch' && inputs.dry_run == false";
    });
    expect(p.join("\n")).toMatch(/R13: the promotion job \(images-latest\) has `if: .*` but the un-draft job \(finalize\) has/s);
    // …and this is the ONLY rule that fires on it. That is the proof the
    // hole was real: every other assertion in this file passes on a tree
    // whose `:latest` never moves again.
    expect(p.filter((x) => !x.startsWith("R13: the promotion job (images-latest) has `if:"))).toEqual([]);
  });

  it("R13: deleting the promotion job's `if:` entirely is caught", () => {
    // Not because an ungated job would run on a dry run — `needs: finalize`
    // means a skipped `finalize` skips this too, so the immediate behaviour
    // is unchanged. It is caught because that safety is INHERITED from one
    // `needs:` edge rather than stated, and the whole point of R13 is that
    // `needs:` and `if:` are separate guarantees.
    const p = mutate((r) => {
      delete Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!.if;
    });
    expect(p.join("\n")).toMatch(/R13: the promotion job \(images-latest\) has no `if:`/);
  });

  it("R13: with BOTH `if:`s gone, the un-draft job is blamed rather than the promotion", () => {
    // The empty-`if:` message tells you to copy the un-draft job's gate. If
    // that job has none either, following it literally could never clear the
    // error — so this case must fall through to the equality branch, which
    // names both jobs and the real defect.
    const p = mutate((r) => {
      delete Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!.if;
      delete jobDoing(r, "--draft=false")![1].if;
    });
    expect(p.join("\n")).not.toMatch(/R13: the promotion job \(images-latest\) has no `if:`/);
  });

  it("R13: tightening the un-draft job's gating without the promotion job's is caught as drift", () => {
    const p = mutate((r) => {
      jobDoing(r, "--draft=false")![1].if = "github.event_name == 'push'";
    });
    expect(p.join("\n")).toMatch(/R13: the promotion job \(images-latest\) has `if:/);
    // Nothing else reads `finalize`'s `if:`, so this must be the only firing.
    expect(p.filter((x) => !x.startsWith("R13: the promotion job (images-latest) has `if:"))).toEqual([]);
  });

  // Guards the rule against over-firing: the two conditions are written as
  // folded YAML scalars, so re-wrapping one changes the parsed whitespace
  // without changing the expression. A rule that failed on a reflow would
  // get silenced rather than fixed.
  it("R13: re-wrapping the promotion job's `if:` without changing it stays clean", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!;
      job.if = `  ${String(job.if).replace(/\s+/g, "\n   ")}\n`;
    });
    expect(p.join("\n")).not.toMatch(/R13:/);
  });

  // The other cosmetic edit that must stay clean, and the likelier one:
  // GitHub treats `if: ${{ expr }}` and `if: expr` as the same condition,
  // and the wrapped form is what most actions linters and most humans write.
  it("R13: wrapping the promotion job's `if:` in `${{ }}` changes nothing and stays clean", () => {
    const p = mutate((r) => {
      const job = Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!;
      job.if = `\${{ ${String(job.if)} }}`;
    });
    expect(p.join("\n")).not.toMatch(/R13:/);
  });

  it("R13: promoting the wrong source or destination tag is caught", () => {
    expect(
      mutate((r) => {
        Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!.with!.to = "rc";
      }).join("\n"),
    ).toMatch(/R13: the promotion job \(images-latest\) promotes to 'rc'/);
    expect(
      mutate((r) => {
        Object.values(r.jobs!).find((j) => (j.uses ?? "").endsWith("promote.yml"))!.with!.from = "dev";
      }).join("\n"),
    ).toMatch(/R13: the promotion job \(images-latest\) promotes from 'dev'/);
  });

  it("R13: removing workflow_call from promote.yml is caught", () => {
    const p = mutate((_r, _n, _d, pr) => {
      delete (pr.on as Record<string, unknown>).workflow_call;
    });
    expect(p.join("\n")).toMatch(/R13: promote\.yml has no `workflow_call` trigger/);
  });

  it("R14: the `web` gap — an image docker-images tags but promote.yml does not — is caught", () => {
    // promote.yml really did ship without `web` while docker-images'
    // merge-dependents matrix had it. Dispatch-only, that was cosmetic;
    // on the release path it means switchroom-web:latest stops advancing.
    const p = mutate((_r, _n, _d, pr) => {
      const m = pr.jobs!.promote!.strategy!.matrix as { image: string[] };
      m.image = m.image.filter((i) => i !== "web");
    });
    expect(p.join("\n")).toMatch(/R14: promote\.yml's matrix omits \[web\]/);
  });

  it("R14: a new image in docker-images that promote.yml never learns about is caught", () => {
    const p = mutate((_r, _n, d) => {
      (d.jobs!["merge-dependents"]!.strategy!.matrix as { image: string[] }).image.push("newthing");
    });
    expect(p.join("\n")).toMatch(/R14: promote\.yml's matrix omits \[newthing\]/);
  });

  it("R8: interpolating an operator-supplied input into promote.yml's run body is caught", () => {
    const p = mutate((_r, _n, _d, pr) => {
      stepsOf(pr.jobs!.promote!)[1]!.run = 'echo "${{ inputs.from }}"';
    });
    expect(p.join("\n")).toMatch(/R8: promote\.yml/);
  });

  // Guards the rule against over-firing: GitHub really does inherit env from
  // the job and workflow scopes, so a valid outer binding must stay clean.
  it("R10: an EXPECT_TAG inherited from the job scope satisfies the rule", () => {
    const p = mutate((r) => {
      const [, upload] = jobDoing(r, "gh release upload")!;
      const step = stepsOf(upload).find((s) => (s.run ?? "").includes("assert-release-assets-complete.mjs"))!;
      delete step.env!.EXPECT_TAG;
      upload.env = { EXPECT_TAG: "${{ github.ref_name }}" };
    });
    expect(p.join("\n")).not.toMatch(/R10:/);
  });
});
