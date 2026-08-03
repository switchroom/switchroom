/**
 * Pin the docker/Dockerfile.voice misaki-G2P bake shape.
 *
 * The voice sidecar runs misaki's POS-aware English G2P in-process and feeds
 * the phoneme string to Kokoro with is_phonemes=True, which fixes English
 * heteronyms Kokoro's built-in espeak phonemizer mispronounces. The design has
 * two load-bearing invariants that a grep-on-file test can pin far more cheaply
 * than a full image build:
 *
 *   1. NO TORCH. misaki[en] pulls spacy-curated-transformers → torch, which
 *      would undo the entire no-torch reason the sidecar is on kokoro-onnx.
 *      This file asserts the torch-bearing packages never appear.
 *   2. The build-time heteronym GUARD is not vacuous — it asserts the actual,
 *      empirically-verified phoneme strings for two heteronym pairs, so a
 *      lexicon/tagger regression that collapsed both senses would fail the
 *      build instead of shipping a silent mispronunciation.
 *
 * These are structural tests (no docker required). The authoritative proof of
 * the two assumptions is the build-voice CI job actually executing the guard;
 * this file guards the SHAPE that keeps that guard meaningful.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.voice"),
  "utf8",
);

/**
 * Every `RUN` instruction as its own array of physical lines (continuations
 * folded in). Scoping the guard assertions to the instruction that actually
 * contains them — rather than a file-wide search — cannot drift vacuous the way
 * a positional slice can. (Same pattern as dockerfile-hindsight-bakes.test.ts.)
 */
function runInstructions(): string[][] {
  const lines = dockerfile.split("\n");
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^RUN\b/.test(lines[i])) continue;
    const block = [lines[i]];
    while (/\\\s*$/.test(block[block.length - 1]) && i + 1 < lines.length) {
      block.push(lines[++i]);
    }
    out.push(block);
  }
  return out;
}

/** The single RUN instruction carrying the misaki heteronym guard. */
function heteronymGuardRun(): string[] {
  const matches = runInstructions().filter((b) =>
    b.join("\n").includes("from misaki import en, espeak"),
  );
  expect(
    matches,
    "exactly one RUN instruction must carry the misaki heteronym guard",
  ).toHaveLength(1);
  return matches[0];
}

describe("Dockerfile.voice misaki-G2P shape", () => {
  it("keeps the existing whisper/kokoro/onnxruntime-gpu shape intact", () => {
    // The misaki additions must not disturb the STT/TTS base: kokoro-onnx is
    // still the ONNX inference path, and the CPU→GPU onnxruntime swap is the
    // confirmed root-cause fix for slow synth.
    expect(dockerfile).toMatch(/"kokoro-onnx==0\.5\.0"/);
    expect(dockerfile).toMatch(/pip3 uninstall -y onnxruntime\b/);
    expect(dockerfile).toMatch(/"onnxruntime-gpu==1\.20\.2"/);
  });

  it("installs base misaki pinned at 0.9.4 (torch-free English path)", () => {
    // Pinned exactly: misaki's main branch imports torch/transformers at the
    // top of en.py; 0.9.4 does not. A bump must re-verify that.
    expect(dockerfile).toMatch(/"misaki==0\.9\.4"/);
  });

  it("does NOT install the misaki[en] extra (it drags torch)", () => {
    // misaki[en] → spacy-curated-transformers → torch. Forbidden. Scoped to the
    // executable RUN lines: the comment above the pip layer names `misaki[en]`
    // to explain the exclusion, so a file-wide ban would fail on its own docs.
    const runText = runInstructions()
      .map((b) => b.join("\n"))
      .join("\n");
    expect(runText).not.toMatch(/misaki\[en\]/);
  });

  it("never installs torch / transformers / spacy-curated-transformers", () => {
    // The no-torch invariant. Scoped to the EXECUTABLE lines of the RUN
    // instructions (not the file), because the explanatory comments above the
    // pip layer legitimately NAME these packages to say why they're excluded —
    // a file-wide substring ban would fail on its own documentation. The RUN
    // blocks contain only install args, so a match here is a real install.
    const runText = runInstructions()
      .map((b) => b.join("\n"))
      .join("\n");
    // torch as a pip requirement (quoted, pinned, or with an extra) — never as
    // the English word in prose.
    expect(runText).not.toMatch(/["']torch(==|>=|<=|~=|\[|["'])/);
    expect(runText).not.toMatch(/spacy-curated-transformers/);
    expect(runText).not.toMatch(/spacy_curated_transformers/);
    expect(runText).not.toMatch(/["']transformers["\[=]/);
    // And the misaki[en] extra spelled inside an install line.
    expect(runText).not.toMatch(/misaki\[en\]/);
  });

  it("installs spaCy plus the click dep spaCy's CLI needs", () => {
    // misaki does `import spacy` at module load; spaCy's cli/_util.py does
    // `from click import NoSuchOption`, but typer 0.27 no longer hard-depends
    // on click, so it must be pinned explicitly (undeclared-dep, like the
    // requests/faster-whisper pin).
    expect(dockerfile).toMatch(/"spacy==3\.8\.7"/);
    expect(dockerfile).toMatch(/"click==/);
    expect(dockerfile).toMatch(/"num2words==0\.5\.14"/);
  });

  it("keeps numpy on the v2 line (the Kokoro ONNX path needs it)", () => {
    // A resolver wobble back to numpy 1.x would break the ONNX/TTS path.
    expect(dockerfile).toMatch(/"numpy>=2\.0\.2"/);
  });

  it("bakes en_core_web_sm as a wheel whose version matches the spacy pin", () => {
    // Baked as a wheel because misaki.en.G2P otherwise calls spacy.cli.download
    // at runtime — a network fetch + site-packages write that fails under the
    // non-root UID and breaks offline boots. spaCy refuses to load a model
    // whose major.minor differs from its own, so the two versions are coupled.
    const wheel = dockerfile.match(
      /en_core_web_sm-(\d+)\.(\d+)\.(\d+)-py3-none-any\.whl/,
    );
    expect(wheel, "the en_core_web_sm wheel URL must be present").not.toBeNull();
    const spacy = dockerfile.match(/"spacy==(\d+)\.(\d+)\.\d+"/);
    expect(spacy, "the spacy pin must be present").not.toBeNull();
    // major.minor of the model must equal major.minor of spaCy.
    expect(wheel![1]).toBe(spacy![1]);
    expect(wheel![2]).toBe(spacy![2]);
    // And it must be the explosion release URL, fetched at build time.
    expect(dockerfile).toMatch(
      /https:\/\/github\.com\/explosion\/spacy-models\/releases\/download\/en_core_web_sm-\d+\.\d+\.\d+\/en_core_web_sm-\d+\.\d+\.\d+-py3-none-any\.whl/,
    );
  });

  it("carries a NON-VACUOUS build-time heteronym guard", () => {
    // The guard must assert the exact phoneme substrings for BOTH senses of
    // BOTH heteronym pairs — verified empirically against misaki 0.9.4. A guard
    // that only imported misaki would pass even if every word collapsed to the
    // espeak fallback, so the literal phonemes are the load-bearing content.
    const block = heteronymGuardRun();
    const text = block.join("\n");

    // Constructed torch-free — the guard proves assumption (a) at build time.
    expect(text).toMatch(/en\.G2P\(trf=False/);
    expect(text).toMatch(/EspeakFallback\(british=False\)/);

    // live: verb /lˈɪv/ vs adjective /lˈIv/ (capital I = /aɪ/ in misaki).
    expect(text).toContain("lˈɪv");
    expect(text).toContain("lˈIv");
    // read: base /ɹˈid/ vs past /ɹˈɛd/.
    expect(text).toContain("ɹˈid");
    expect(text).toContain("ɹˈɛd");

    // The two senses of each pair must be DISTINCT literals — a guard asserting
    // the same string twice would be vacuous.
    expect("lˈɪv").not.toBe("lˈIv");
    expect("ɹˈid").not.toBe("ɹˈɛd");

    // The assertions must actually run against the G2P output, not just mention
    // the strings — pin the `in` membership asserts.
    expect(text).toMatch(/assert 'lˈɪv' in \w+ and 'lˈIv' in \w+/);
    expect(text).toMatch(/assert 'ɹˈid' in \w+ and 'ɹˈɛd' in \w+/);
  });

  it("runs the guard AFTER the pip install, on system python3", () => {
    // A guard that preceded the install would prove nothing. The guard RUN must
    // come after the RUN that installs misaki.
    const runs = runInstructions();
    const installIdx = runs.findIndex((b) =>
      b.join("\n").includes('"misaki==0.9.4"'),
    );
    const guardIdx = runs.findIndex((b) =>
      b.join("\n").includes("from misaki import en, espeak"),
    );
    expect(installIdx, "the misaki install RUN must exist").toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(installIdx);
  });
});
