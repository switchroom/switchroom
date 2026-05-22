/**
 * config_propose_edit — PR 1b validation pipeline.
 *
 * Implements RFC §4 (`docs/rfcs/admin-agent-config-edit.md`). Pure
 * functions: no daemon state, no flock, no audit-log writes, no
 * approval card. The dispatcher (`server.ts`) calls
 * `validateConfigEdit()` and turns the verdict into a `HostdResponse`
 * + audit row.
 *
 * Pipeline (each stage rejects with a stable error code; stages run
 * in order and short-circuit on first failure):
 *
 *   1. Patch shape — single-file unified diff against the configured
 *      target path; ≤1 MB raw bytes; no path traversal or absolute
 *      paths other than the literal target; multi-hunk OK.
 *      → E_PATCH_INVALID_SHAPE
 *   2. Clean apply — `git apply --check` against a scratch copy of
 *      the live config. Catches context drift / operator hand-edits.
 *      → E_PATCH_APPLY_FAILED
 *   3a. YAML failsafe parse of the post-apply content; rejects `!!`
 *      tags, `&` anchors, `*` aliases, `<<:` merge keys BEFORE zod
 *      runs (those are code-execution / hidden-mutation primitives
 *      zod cannot defend against — RFC §4.3 is explicit on this).
 *      → E_YAML_UNSAFE_CONSTRUCT
 *   3b. Zod parse against the existing SwitchroomConfigSchema.
 *      → E_SCHEMA_INVALID
 *   4. Secrets-deref do-not-regress guard: any field that was a
 *      `vault:<key>` reference in the BEFORE config MUST still be a
 *      vault reference in the AFTER config (no inlining). No newly-
 *      introduced literal string matches a secret-shape heuristic
 *      (sk-/ghp_/xoxb-/AIza prefixes; long base64 in credential-
 *      named fields). Vault references themselves are fine — they
 *      are the entire point of the indirection.
 *      → E_SECRET_LEAK_DETECTED
 *
 * Success returns `{ ok: true }`; PR 1c will swap that for the
 * approval-card dispatch.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, normalize } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseDocument,
  isAlias,
  isScalar,
  isPair,
  isNode,
  visit,
  type Document,
  type Node,
} from "yaml";
import { SwitchroomConfigSchema } from "../config/schema.js";

/**
 * Successful validation. `postApplyContent` carries the post-patch
 * file bytes so the caller (#1623 apply path) can write them directly
 * without re-applying the diff — the validator already paid the cost
 * of running `git apply` against the live file.
 */
export type ValidationOk = { ok: true; postApplyContent: string };
export type ValidationFailure = {
  ok: false;
  code:
    | "E_PATCH_INVALID_SHAPE"
    | "E_PATCH_APPLY_FAILED"
    | "E_YAML_UNSAFE_CONSTRUCT"
    | "E_SCHEMA_INVALID"
    | "E_SECRET_LEAK_DETECTED";
  detail: string;
};
export type ValidationResult = ValidationOk | ValidationFailure;

/** Hard cap on raw unified-diff bytes. RFC §3.2 step 1. */
export const MAX_PATCH_BYTES = 1024 * 1024;

export interface ValidatorOptions {
  /** Live config file the patch is applied against (read fresh each call). */
  configPath: string;
  /** Canonical target path the diff is allowed to touch. Must equal
   *  what the wire schema pins — the validator double-checks. */
  targetPath: string;
  /** Raw unified diff body. LF-only is enforced. */
  unifiedDiff: string;
  /** Path to `git` binary; defaults to `git` on PATH. Test seam. */
  gitBin?: string;
}

function isTargetPathHeader(headerPath: string, targetBasename: string): boolean {
  if (headerPath === "/dev/null") return false;
  let p = headerPath;
  if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
  if (isAbsolute(p)) return false;
  if (p.includes("..")) return false;
  const norm = normalize(p);
  if (norm.includes("..") || isAbsolute(norm)) return false;
  return norm === targetBasename;
}

/** Stage 1 — RFC §4.1. */
function validateShape(
  unifiedDiff: string,
  targetPath: string,
): ValidationFailure | null {
  const byteLen = Buffer.byteLength(unifiedDiff, "utf8");
  if (byteLen > MAX_PATCH_BYTES) {
    return {
      ok: false,
      code: "E_PATCH_INVALID_SHAPE",
      detail: `patch exceeds ${MAX_PATCH_BYTES}-byte cap (${byteLen} bytes)`,
    };
  }
  if (unifiedDiff.includes("\r")) {
    return {
      ok: false,
      code: "E_PATCH_INVALID_SHAPE",
      detail: "patch must be LF-only (no CRLF / CR)",
    };
  }
  const lines = unifiedDiff.split("\n");
  const minusHeaders: string[] = [];
  const plusHeaders: string[] = [];
  let hunkCount = 0;
  for (const ln of lines) {
    if (ln.startsWith("--- ")) minusHeaders.push(ln.slice(4).trim());
    else if (ln.startsWith("+++ ")) plusHeaders.push(ln.slice(4).trim());
    else if (ln.startsWith("@@")) hunkCount++;
  }
  if (minusHeaders.length === 0 || plusHeaders.length === 0) {
    return {
      ok: false,
      code: "E_PATCH_INVALID_SHAPE",
      detail: "patch missing `---`/`+++` headers",
    };
  }
  if (hunkCount === 0) {
    return {
      ok: false,
      code: "E_PATCH_INVALID_SHAPE",
      detail: "patch contains no hunks",
    };
  }
  if (minusHeaders.length > 1 || plusHeaders.length > 1) {
    return {
      ok: false,
      code: "E_PATCH_INVALID_SHAPE",
      detail: "multi-file diff not allowed; single-file only",
    };
  }
  const targetBasename = targetPath.split("/").pop() ?? targetPath;
  for (const h of [...minusHeaders, ...plusHeaders]) {
    const path = h.split("\t")[0]!.trim();
    if (!isTargetPathHeader(path, targetBasename)) {
      return {
        ok: false,
        code: "E_PATCH_INVALID_SHAPE",
        detail: `header path "${path}" does not match target "${targetBasename}"`,
      };
    }
  }
  return null;
}

/** Stage 2 — RFC §4.2. */
function applyPatch(
  unifiedDiff: string,
  configPath: string,
  gitBin: string | undefined,
): { ok: true; after: string } | ValidationFailure {
  if (!existsSync(configPath)) {
    return {
      ok: false,
      code: "E_PATCH_APPLY_FAILED",
      detail: `target config not found at ${configPath}`,
    };
  }
  const liveContent = readFileSync(configPath, "utf8");
  const scratchDir = mkdtempSync(join(tmpdir(), "config-propose-edit-"));
  try {
    const basename = configPath.split("/").pop() ?? "switchroom.yaml";
    const scratchFile = join(scratchDir, basename);
    writeFileSync(scratchFile, liveContent);
    const patchFile = join(scratchDir, "proposal.patch");
    writeFileSync(patchFile, unifiedDiff);

    const bin = gitBin ?? "git";
    const baseArgs = [
      "apply",
      "--whitespace=nowarn",
      "--recount",
      "--unidiff-zero",
    ];
    const checkP1 = spawnSync(
      bin,
      [...baseArgs.slice(0, 1), "--check", ...baseArgs.slice(1), "-p1", patchFile],
      { cwd: scratchDir, encoding: "utf8", timeout: 10_000 },
    );
    let pStrip = "-p1";
    if (checkP1.status !== 0) {
      const checkP0 = spawnSync(
        bin,
        [...baseArgs.slice(0, 1), "--check", ...baseArgs.slice(1), "-p0", patchFile],
        { cwd: scratchDir, encoding: "utf8", timeout: 10_000 },
      );
      if (checkP0.status !== 0) {
        const stderr = (checkP1.stderr || "") + (checkP0.stderr || "");
        return {
          ok: false,
          code: "E_PATCH_APPLY_FAILED",
          detail: `git apply --check failed: ${stderr.trim().slice(0, 500)}`,
        };
      }
      pStrip = "-p0";
    }
    const real = spawnSync(
      bin,
      [...baseArgs, pStrip, patchFile],
      { cwd: scratchDir, encoding: "utf8", timeout: 10_000 },
    );
    if (real.status !== 0) {
      return {
        ok: false,
        code: "E_PATCH_APPLY_FAILED",
        detail: `git apply failed: ${(real.stderr || "").trim().slice(0, 500)}`,
      };
    }
    const after = readFileSync(scratchFile, "utf8");
    return { ok: true, after };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Stage 3a — failsafe-style YAML walk that rejects dangerous constructs. */
function failsafeParse(
  source: string,
): { ok: true; doc: Document.Parsed; data: unknown } | ValidationFailure {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(source, { merge: false, strict: true });
  } catch (err) {
    return {
      ok: false,
      code: "E_YAML_UNSAFE_CONSTRUCT",
      detail: `YAML parse error: ${(err as Error).message}`,
    };
  }
  if (doc.errors && doc.errors.length > 0) {
    return {
      ok: false,
      code: "E_YAML_UNSAFE_CONSTRUCT",
      detail: `YAML parse error: ${doc.errors[0]!.message}`,
    };
  }
  let rejection: ValidationFailure | null = null;
  visit(doc, (_key, node, _path) => {
    if (rejection) return visit.BREAK;
    if (isAlias(node)) {
      rejection = {
        ok: false,
        code: "E_YAML_UNSAFE_CONSTRUCT",
        detail: "YAML aliases (`*name`) are not allowed",
      };
      return visit.BREAK;
    }
    if (isNode(node)) {
      if ((node as Node).anchor) {
        rejection = {
          ok: false,
          code: "E_YAML_UNSAFE_CONSTRUCT",
          detail: `YAML anchors (\`&${(node as Node).anchor}\`) are not allowed`,
        };
        return visit.BREAK;
      }
      const tag = (node as Node).tag;
      if (typeof tag === "string" && tag.startsWith("!")) {
        rejection = {
          ok: false,
          code: "E_YAML_UNSAFE_CONSTRUCT",
          detail: `YAML explicit tags (\`${tag}\`) are not allowed`,
        };
        return visit.BREAK;
      }
    }
    if (isPair(node)) {
      const k = node.key;
      if (isScalar(k) && k.value === "<<") {
        rejection = {
          ok: false,
          code: "E_YAML_UNSAFE_CONSTRUCT",
          detail: "YAML merge keys (`<<:`) are not allowed",
        };
        return visit.BREAK;
      }
    }
    return undefined;
  });
  if (rejection) return rejection;
  // Defense-in-depth: textual scan in case the yaml package's
  // failsafe normalisation hid these constructs from the AST walk.
  if (/(^|\n)\s*<<\s*:/.test(source)) {
    return {
      ok: false,
      code: "E_YAML_UNSAFE_CONSTRUCT",
      detail: "YAML merge keys (`<<:`) are not allowed",
    };
  }
  const tagMatch = source.match(/(^|\s)!![A-Za-z_][\w/.\-:]*/);
  if (tagMatch) {
    return {
      ok: false,
      code: "E_YAML_UNSAFE_CONSTRUCT",
      detail: `YAML explicit tags (\`${tagMatch[0].trim()}\`) are not allowed`,
    };
  }
  return { ok: true, doc, data: doc.toJS() };
}

/** Stage 3b — zod against the existing schema. */
function schemaValidate(data: unknown): ValidationFailure | null {
  const result = SwitchroomConfigSchema.safeParse(data);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const where = issue?.path.join(".") || "(root)";
  return {
    ok: false,
    code: "E_SCHEMA_INVALID",
    detail: `schema validation failed at ${where}: ${issue?.message ?? "unknown"}`,
  };
}

function collectStrings(
  root: unknown,
  out: Map<string, string>,
  prefix = "",
): void {
  if (root === null || root === undefined) return;
  if (typeof root === "string") {
    out.set(prefix || "(root)", root);
    return;
  }
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      collectStrings(root[i], out, `${prefix}[${i}]`);
    }
    return;
  }
  if (typeof root === "object") {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      collectStrings(v, out, p);
    }
  }
}

const SECRET_PREFIX_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "openai-key", re: /^sk-[A-Za-z0-9_\-]{20,}$/ },
  { name: "anthropic-key", re: /^sk-ant-[A-Za-z0-9_\-]{20,}$/ },
  { name: "github-pat", re: /^ghp_[A-Za-z0-9]{20,}$/ },
  { name: "github-fine-grained", re: /^github_pat_[A-Za-z0-9_]{20,}$/ },
  { name: "slack-bot", re: /^xoxb-[A-Za-z0-9\-]{10,}$/ },
  { name: "slack-user", re: /^xoxp-[A-Za-z0-9\-]{10,}$/ },
  { name: "google-api", re: /^AIza[A-Za-z0-9_\-]{30,}$/ },
  { name: "aws-access-key", re: /^AKIA[A-Z0-9]{16,}$/ },
];

const CREDENTIAL_FIELD_RE =
  /(^|[._\-])(secret|token|password|api[_\-]?key|bot[_\-]?token|client[_\-]?secret|credential)s?($|[._\-])/i;

const VAULT_REF_RE = /^vault:[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/;

function masked(s: string): string {
  if (s.length <= 8) return "***";
  return `${s.slice(0, 3)}...${s.slice(-3)}`;
}

/** Stage 4 — RFC §4.4 secret-leak / vault-ref-regression guard. */
function secretLeakGuard(
  before: unknown,
  after: unknown,
): ValidationFailure | null {
  const beforeStrings = new Map<string, string>();
  const afterStrings = new Map<string, string>();
  collectStrings(before, beforeStrings);
  collectStrings(after, afterStrings);

  for (const [path, val] of beforeStrings) {
    if (!VAULT_REF_RE.test(val)) continue;
    if (!afterStrings.has(path)) continue;
    const newVal = afterStrings.get(path)!;
    if (!VAULT_REF_RE.test(newVal)) {
      return {
        ok: false,
        code: "E_SECRET_LEAK_DETECTED",
        detail:
          `field "${path}" was a vault reference (${val}) but the ` +
          `proposed change replaces it with a literal value ` +
          `(${masked(newVal)}); inlining a secret is not allowed`,
      };
    }
  }

  for (const [path, val] of afterStrings) {
    if (VAULT_REF_RE.test(val)) continue;
    if (beforeStrings.get(path) === val) continue;
    for (const { name, re } of SECRET_PREFIX_PATTERNS) {
      if (re.test(val)) {
        return {
          ok: false,
          code: "E_SECRET_LEAK_DETECTED",
          detail:
            `field "${path}" contains a literal ${name}-shaped value ` +
            `(${masked(val)}); use a vault:<key> reference instead`,
        };
      }
    }
    if (CREDENTIAL_FIELD_RE.test(path)) {
      if (val.length >= 40 && /^[A-Za-z0-9+/=_\-]+$/.test(val)) {
        return {
          ok: false,
          code: "E_SECRET_LEAK_DETECTED",
          detail:
            `field "${path}" is credential-named and the proposed ` +
            `value (${masked(val)}) looks like a literal secret; ` +
            `use a vault:<key> reference instead`,
        };
      }
    }
  }

  return null;
}

/** Run the full PR 1b pipeline. Pure: no side effects on the live config. */
export function validateConfigEdit(
  opts: ValidatorOptions,
): ValidationResult {
  const shapeErr = validateShape(opts.unifiedDiff, opts.targetPath);
  if (shapeErr) return shapeErr;
  const applied = applyPatch(opts.unifiedDiff, opts.configPath, opts.gitBin);
  if (!("ok" in applied) || applied.ok !== true) {
    return applied as ValidationFailure;
  }
  const parsedAfter = failsafeParse(applied.after);
  if (!("ok" in parsedAfter) || parsedAfter.ok !== true) {
    return parsedAfter as ValidationFailure;
  }
  const schemaErr = schemaValidate(parsedAfter.data);
  if (schemaErr) return schemaErr;
  let beforeData: unknown = {};
  try {
    const beforeRaw = existsSync(opts.configPath)
      ? readFileSync(opts.configPath, "utf8")
      : "";
    const beforeDoc = parseDocument(beforeRaw, { merge: false, strict: false });
    beforeData = beforeDoc.toJS();
  } catch {
    beforeData = {};
  }
  const leakErr = secretLeakGuard(beforeData, parsedAfter.data);
  if (leakErr) return leakErr;
  return { ok: true, postApplyContent: applied.after };
}
