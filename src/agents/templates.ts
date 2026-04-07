import { readFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the templates directory (project-level). */
const TEMPLATES_ROOT = resolve(__dirname, "../../templates");

/**
 * Resolve the path for a named template directory.
 * Falls back to "default" if the requested template doesn't exist.
 */
export function getTemplatePath(templateName: string): string {
  const requested = resolve(TEMPLATES_ROOT, templateName);
  // Check that the template dir exists AND has at least one .hbs file
  if (existsSync(requested) && hasTemplateFiles(requested)) {
    return requested;
  }
  const fallback = resolve(TEMPLATES_ROOT, "default");
  if (existsSync(fallback)) {
    return fallback;
  }
  throw new Error(`Template not found: ${templateName} (searched ${TEMPLATES_ROOT})`);
}

function hasTemplateFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".hbs") || f === "skills");
  } catch {
    return false;
  }
}

/** Path to the shared _base template directory. */
export function getBaseTemplatePath(): string {
  return resolve(TEMPLATES_ROOT, "_base");
}

/**
 * Read a .hbs file and render it with the given context.
 */
export function renderTemplate(
  templatePath: string,
  context: Record<string, unknown>,
): string {
  const source = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(source);
  return template(context);
}

/**
 * Recursively copy files from a template's skills/ directory into the destination.
 * Skips files that already exist at the destination (idempotent).
 */
export function copySkills(templatePath: string, destPath: string): void {
  const skillsSrc = join(templatePath, "skills");
  if (!existsSync(skillsSrc)) {
    return;
  }
  copyDirRecursive(skillsSrc, destPath);
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Idempotent: don't overwrite existing files
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Register a "json" helper for Handlebars to emit raw JSON
Handlebars.registerHelper("json", (value: unknown) => {
  return new Handlebars.SafeString(JSON.stringify(value, null, 2));
});
