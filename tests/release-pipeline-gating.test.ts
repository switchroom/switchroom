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
}
interface Job {
  needs?: string | string[];
  if?: unknown;
  uses?: string;
  steps?: Step[];
  "continue-on-error"?: unknown;
}
interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, Job>;
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
 * The whole rule set, as a list of human-readable problems. Empty = the
 * pipeline cannot half-ship.
 */
export function auditGating(release: Workflow, npmPublish: Workflow): string[] {
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

  // R6 — nothing on the chain may swallow an upstream failure. `always()`
  // and `cancelled()` override the default all-needs-succeeded semantics;
  // `continue-on-error` turns a red step green.
  for (const [file, wf] of [
    ["release.yml", release],
    ["npm-publish.yml", npmPublish],
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

  return problems;
}

const RELEASE = load("release.yml");
const NPM = load("npm-publish.yml");
const DOCKER = load("docker-images.yml");

describe("release pipeline gating — the real workflows", () => {
  it("has no gating problems", () => {
    expect(auditGating(RELEASE, NPM)).toEqual([]);
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
function mutate(fn: (r: Workflow, n: Workflow) => void): string[] {
  const r = clone(RELEASE);
  const n = clone(NPM);
  fn(r, n);
  return auditGating(r, n);
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

  it("R8: interpolating a secret into a run body is caught", () => {
    const p = mutate((_r, n) => {
      const job = Object.values(n.jobs!)[0];
      stepsOf(job)[0]!.run = 'echo "${{ secrets.NPM_TOKEN }}" > /tmp/x';
    });
    expect(p.join("\n")).toMatch(/R8:.*interpolates/);
  });
});
