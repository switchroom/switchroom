/**
 * The 2026-07-28 silent drop, pinned as a test.
 *
 * `switchroom memory setup --recreate` rebuilds the hindsight container's env
 * from `hindsight.env` plus switchroom's managed defaults. Anything live on the
 * container and declared in neither source vanished with no error, no warning
 * and no diff. It happened three times; the third took
 * `HINDSIGHT_API_RERANKER_LOCAL_FP16=true` and
 * `HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128` off the reranker, so the local
 * cross-encoder dropped to fp32 (~2x the time per candidate) on the
 * interactive recall path, and it was found only by hand-diffing a `docker
 * inspect` snapshot taken minutes earlier.
 *
 * Every assertion below is about the OUTCOME an operator sees: given a key live
 * on the container and absent from the computed env, does the recreate path
 * name it and print its value. A test that only checked "the diff function was
 * called" would have passed happily through all three incidents.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  diffDroppedHindsightEnv,
  explainDroppedHindsightEnv,
  formatDroppedHindsightEnvReport,
  parseDockerEnvList,
  REDACTED_ENV_VALUE,
} from "./hindsight-env-drift.js";

/** A trimmed but realistic image baseline: none of this is operator config. */
const IMAGE_ENV = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "LANG=C.UTF-8",
  "PYTHON_VERSION=3.12.7",
  "HOME=/home/hindsight",
];

const ALL_CAPS = { gpu: true, localLlm: true };
const NO_CAPS = { gpu: false, localLlm: false };

describe("diffDroppedHindsightEnv", () => {
  it("reports a key live on the container that the next launch will not set", () => {
    // THE bug, reproduced. FP16 is on the running container; the computed env
    // (empty hindsight.env, GPU verdict unproven) does not contain it.
    const live = [
      ...IMAGE_ENV,
      "HINDSIGHT_API_RERANKER_LOCAL_FP16=true",
      "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128",
      "HINDSIGHT_API_WORKER_ID=switchroom-hindsight",
    ];
    const next: Array<[string, string]> = [
      ["HINDSIGHT_API_WORKER_ID", "switchroom-hindsight"],
    ];

    expect(diffDroppedHindsightEnv(live, next, IMAGE_ENV)).toEqual([
      { key: "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE", value: "128", redacted: false },
      { key: "HINDSIGHT_API_RERANKER_LOCAL_FP16", value: "true", redacted: false },
    ]);
  });

  it("is silent when the next launch sets every configured key", () => {
    const live = [...IMAGE_ENV, "HINDSIGHT_API_RERANKER_LOCAL_FP16=true"];
    const next: Array<[string, string]> = [
      ["HINDSIGHT_API_RERANKER_LOCAL_FP16", "true"],
    ];
    expect(diffDroppedHindsightEnv(live, next, IMAGE_ENV)).toEqual([]);
  });

  it("does not report image-inherited env as a drop", () => {
    // Without the image baseline this is ~20 phantom rows on every recreate,
    // and a warning that always fires is a warning nobody reads.
    expect(diffDroppedHindsightEnv(IMAGE_ENV, [], IMAGE_ENV)).toEqual([]);
  });

  it("DOES report an image var that was overridden, because that override is lost", () => {
    const live = ["PATH=/opt/custom/bin:/usr/bin", "LANG=C.UTF-8"];
    expect(diffDroppedHindsightEnv(live, [], IMAGE_ENV)).toEqual([
      { key: "PATH", value: "/opt/custom/bin:/usr/bin", redacted: false },
    ]);
  });

  it("a key whose VALUE changes is not a drop — the next launch still sets it", () => {
    const live = [...IMAGE_ENV, "HINDSIGHT_API_PORT=18888"];
    const next: Array<[string, string]> = [["HINDSIGHT_API_PORT", "19999"]];
    expect(diffDroppedHindsightEnv(live, next, IMAGE_ENV)).toEqual([]);
  });

  it("never prints a secret-shaped value", () => {
    // startHindsight embeds the LiteLLM API key inside ANTHROPIC_CUSTOM_HEADERS.
    // A "here is what you are dropping" dump must not leak it to the terminal.
    const live = ["ANTHROPIC_CUSTOM_HEADERS=x-litellm-api-key: Bearer sk-live-" + "abc123"];
    const [row] = diffDroppedHindsightEnv(live, [], IMAGE_ENV);
    expect(row).toEqual({
      key: "ANTHROPIC_CUSTOM_HEADERS",
      value: REDACTED_ENV_VALUE,
      redacted: true,
    });
    expect(JSON.stringify(row)).not.toContain("abc123");
  });

  it("splits on the FIRST '=' so a value containing '=' survives intact", () => {
    const live = ["HINDSIGHT_API_WORKER_CONSOLIDATION_BANK_PRIORITY=a=1,*:1"];
    expect(diffDroppedHindsightEnv(live, [], [])[0]!.value).toBe("a=1,*:1");
  });

  it("takes the LAST duplicate, matching what the container process sees", () => {
    expect(parseDockerEnvList(["K=first", "K=last"]).get("K")).toBe("last");
  });

  it("is a no-op with no live container (first install)", () => {
    expect(diffDroppedHindsightEnv([], [["A", "1"]], [])).toEqual([]);
  });
});

describe("explainDroppedHindsightEnv", () => {
  it("names the withheld capability gate for a managed GPU default", () => {
    // The diagnosis that was missing on 2026-07-28: these two keys ARE managed
    // defaults, they were withheld because the GPU verdict did not resolve.
    const why = explainDroppedHindsightEnv("HINDSIGHT_API_RERANKER_LOCAL_FP16", NO_CAPS);
    expect(why).toContain("GPU-gated");
  });

  it("says nothing when the gate is proven — the key is not gate-related then", () => {
    expect(
      explainDroppedHindsightEnv("HINDSIGHT_API_RERANKER_LOCAL_FP16", ALL_CAPS),
    ).toBeNull();
  });

  it("says nothing for a key switchroom does not manage", () => {
    expect(explainDroppedHindsightEnv("HINDSIGHT_API_MADE_UP", NO_CAPS)).toBeNull();
  });
});

describe("formatDroppedHindsightEnvReport", () => {
  const dropped = diffDroppedHindsightEnv(
    [
      ...IMAGE_ENV,
      "HINDSIGHT_API_RERANKER_LOCAL_FP16=true",
      "HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128",
    ],
    [],
    IMAGE_ENV,
  );

  it("prints every dropped key AND its live value", () => {
    // Both halves matter: the key alone tells the operator something broke,
    // the value is what they need to paste back.
    const text = formatDroppedHindsightEnvReport(dropped, NO_CAPS).join("\n");
    expect(text).toContain("HINDSIGHT_API_RERANKER_LOCAL_FP16=true");
    expect(text).toContain("HINDSIGHT_API_RERANKER_LOCAL_BATCH_SIZE=128");
  });

  it("emits a paste-ready hindsight.env block", () => {
    const text = formatDroppedHindsightEnvReport(dropped, NO_CAPS).join("\n");
    expect(text).toContain("hindsight:");
    expect(text).toContain("env:");
    expect(text).toContain('HINDSIGHT_API_RERANKER_LOCAL_FP16: "true"');
  });

  it("explains the withheld gate inline", () => {
    expect(formatDroppedHindsightEnvReport(dropped, NO_CAPS).join("\n")).toContain(
      "GPU-gated",
    );
  });

  it("keeps a redacted value out of the paste block too", () => {
    const secret = diffDroppedHindsightEnv(["ANTHROPIC_CUSTOM_HEADERS=Bearer " + "s3cr3t"], [], []);
    const text = formatDroppedHindsightEnvReport(secret, ALL_CAPS).join("\n");
    expect(text).not.toContain("s3cr3t");
    expect(text).toContain("ANTHROPIC_CUSTOM_HEADERS: <value>");
  });

  it("says nothing at all when nothing is dropped", () => {
    expect(formatDroppedHindsightEnvReport([], ALL_CAPS)).toEqual([]);
  });
});

describe("the guard is wired into the recreate path, and runs early enough to matter", () => {
  // A perfect diff function that nothing calls before `docker rm` is worth
  // nothing: by then the env it was meant to report is already gone. These
  // assertions are structural on purpose — the behavioural alternative would
  // have to drive `memory setup --recreate` against a live docker daemon,
  // which on this host means recreating the production hindsight container.
  //
  // Anchors are call sites, not bare identifiers: the import block sits at the
  // top of the file and `stopHindsight()` is also called by `--stop`, so a
  // naive indexOf would compare against the wrong occurrence and pass blind.
  const src = readFileSync(
    join(import.meta.dirname, "..", "cli", "memory.ts"),
    "utf-8",
  );

  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found in src/cli/memory.ts`).toBeGreaterThan(-1);
    return i;
  };

  const READS_LIVE_ENV = "getHindsightContainerEnv();";
  const REPORTS = "envDriftLines = formatDroppedHindsightEnvReport(";
  const PULLS = "pullHindsightImage(effectiveTag);";
  const REMOVES = "Removing existing switchroom-hindsight container";

  it("reads the live container env before the container is removed", () => {
    expect(at(READS_LIVE_ENV)).toBeLessThan(at(REMOVES));
  });

  it("reports the drop before the recreate touches anything at all", () => {
    // Before the pull too: a --strict-env refusal should not have spent
    // minutes downloading an image it is about to decline to run.
    expect(at(REPORTS)).toBeLessThan(at(PULLS));
    expect(at(REPORTS)).toBeLessThan(at(REMOVES));
  });

  it("refuses under --strict-env, and only after the report is printed", () => {
    expect(at("opts.strictEnv")).toBeGreaterThan(at(REPORTS));
    expect(at("opts.strictEnv")).toBeLessThan(at(REMOVES));
  });
});
