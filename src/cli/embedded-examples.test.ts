/**
 * Example configs are EMBEDDED, never read from disk (#4163).
 *
 * `switchroom setup` is the first thing a `curl … | sh` user runs, and its
 * bootstrap read `examples/switchroom.yaml` relative to `import.meta.dirname`
 * — which inside a `bun build --compile` binary is the bunfs root, so the read
 * resolved to `/examples/switchroom.yaml` and setup died with "Example config
 * not found" on every static-binary install. `apply --example` had already
 * been fixed by embedding; `setup` had not, because the two kept their own
 * copies of the lookup.
 *
 * These assert the embedding is real and COMPLETE — that no example file can
 * exist on disk without an embedded counterpart — because a partial embedding
 * fails exactly the same way, just for one example instead of all of them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import {
  DEFAULT_EXAMPLE,
  EMBEDDED_EXAMPLES,
  exampleNames,
  readEmbeddedExample,
} from "./embedded-examples.js";

const EXAMPLES_DIR = join(import.meta.dirname, "..", "..", "examples");

describe("embedded examples", () => {
  it("embeds EVERY examples/*.yaml in the repo", () => {
    // The failure this catches: someone adds examples/foo.yaml, wires it into
    // the `--example` help text, and it works in dev (disk) but 'not found' in
    // the release binary.
    const onDisk = readdirSync(EXAMPLES_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""))
      .sort();
    expect(exampleNames().sort()).toEqual(onDisk);
  });

  it("names an example that exists on disk for every embedded key", () => {
    // The CONTENT cannot be asserted here: vitest does not implement the
    // `with { type: "text" }` import attribute and hands back the module path
    // instead of the file body. Both real build paths (`bun build` for the npm
    // bundle, `bun build --compile` for the released binary) inline it, and
    // that is covered end-to-end by tests/install/static-binary.test.ts, which
    // compiles a real binary and reads the config it writes.
    for (const name of exampleNames()) {
      const onDisk = readFileSync(join(EXAMPLES_DIR, `${name}.yaml`), "utf8");
      const doc = parse(onDisk) as { agents?: unknown };
      expect(doc.agents, `${name}.yaml must be a usable config`).toBeDefined();
    }
  });

  it("the default example is one of the embedded ones", () => {
    expect(EMBEDDED_EXAMPLES[DEFAULT_EXAMPLE]).toBeDefined();
  });

  it("returns null for an unknown name instead of falling back to disk", () => {
    expect(readEmbeddedExample("nope")).toBeNull();
    // …and specifically does not resolve a real file by another route.
    expect(readEmbeddedExample("../examples/switchroom")).toBeNull();
  });
});
