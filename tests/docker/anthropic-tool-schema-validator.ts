/**
 * Anthropic tool-schema validator — PR C smoke-test gate.
 *
 * Anthropic's beta tool-use API requires every tool's `input_schema` to
 * be a JSON Schema object with `"type": "object"` at the root and NO
 * top-level `oneOf` / `anyOf` / `allOf` combinators. Per-property
 * sub-schemas may not use root-level `oneOf` either (some clients
 * accept it, ours does not).
 *
 * Tool-schemas authored as discriminated unions (zod's `.union()`,
 * TypeBox `Union`, hand-written `oneOf` blocks) compile to schemas that
 * pass JSON-schema linting but get rejected by Anthropic's tool-use
 * validator at request time. By that point the tool is on the wire to
 * users and the agent silently loses access.
 *
 * The CI smoke test (Step 4 / `mcp-tools-list.smoke.test.ts`) lists
 * every tool from a running agent's MCP servers and runs each through
 * this validator. Any returned message fails the job before the image
 * promotes to `:dev` — see Step 5 for the gating wire-up.
 *
 * Reference sanitizer pattern: `src/cli/drive-mcp-launcher.ts` (PR
 * #1388) — same family of constraints, server-side guard.
 */

type AnyJsonSchema = Record<string, unknown>;

export interface ToolForValidation {
  name?: string;
  inputSchema?: AnyJsonSchema;
}

const FORBIDDEN_TOP_LEVEL_KEYS = ["oneOf", "anyOf", "allOf"] as const;

function validateSchemaShape(
  toolName: string,
  schema: AnyJsonSchema,
  path: string,
  out: string[],
  depth = 0,
): void {
  // Depth gate — schemas are rarely nested past 6 levels in real-world
  // tool definitions; bail before pathological inputs blow the stack.
  if (depth > 6) return;
  if (path === "root") {
    if (schema.type !== "object") {
      out.push(`${toolName}: root schema type=${JSON.stringify(schema.type)} (must be "object")`);
    }
  }
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (key in schema) {
      out.push(`${toolName}: ${path} contains forbidden combinator '${key}' — Anthropic tool-use rejects discriminated-union schemas`);
    }
  }
  const props = schema.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [propName, propSchema] of Object.entries(props as Record<string, unknown>)) {
      if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
        validateSchemaShape(
          toolName,
          propSchema as AnyJsonSchema,
          `${path}.properties.${propName}`,
          out,
          depth + 1,
        );
      }
    }
  }
}

/**
 * Validate a list of MCP tools. Returns one diagnostic per offending
 * tool; an empty array means all tools are Anthropic-compatible.
 */
export function validateAnthropicToolSchemas(
  tools: ReadonlyArray<ToolForValidation>,
): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    const name = tool.name ?? "<unnamed>";
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") {
      out.push(`${name}: missing inputSchema`);
      continue;
    }
    validateSchemaShape(name, schema as AnyJsonSchema, "root", out);
  }
  return out;
}
