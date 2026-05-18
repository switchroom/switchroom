/**
 * PR B tests: global-scope skill authoring (admin agents only) plus the
 * operator-overwrite guard (`.authored-by-<agent>` marker).
 *
 * Scope-resolution fixturing: instead of needing a real `/skills-rw`
 * mount, the lib functions accept a `globalRoot` override and the
 * underlying `resolveGlobalScopeRoot()` honours
 * `SWITCHROOM_SKILLS_RW_ROOT` as a fallback. Tests pass `globalRoot`
 * directly so they can use a fresh tmpdir per case.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillCreate,
  skillEdit,
  skillDelete,
  skillRead,
} from "./agent-config-skill-author.js";
import {
  authorshipMarkerName,
  globalScopeSkillDir,
} from "./skill-common.js";

const ADMIN = "alice";
const NON_ADMIN = "bob";
const PEER_ADMIN = "carrie";

function isAdmin(agent: string): boolean {
  return agent === ADMIN || agent === PEER_ADMIN;
}

function validSkillMd(name: string, desc = "a test skill"): string {
  return `---\nname: ${name}\ndescription: ${desc}\n---\n# body\n`;
}

describe("agent-config-skill-author (PR B: global scope + ownership)", () => {
  let perAgentRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    perAgentRoot = mkdtempSync(join(tmpdir(), "skill-author-perag-"));
    globalRoot = mkdtempSync(join(tmpdir(), "skill-author-global-"));
    process.env.SWITCHROOM_AGENT_NAME = ADMIN;
    delete process.env.SWITCHROOM_TURN_SOURCE;
  });
  afterEach(() => {
    for (const d of [perAgentRoot, globalRoot]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("global create writes under /skills-rw + drops the authorship marker", () => {
    const r = skillCreate({
      agent: ADMIN,
      name: "my-global",
      scope: "global",
      isAdmin,
      globalRoot,
      files: { "SKILL.md": validSkillMd("my-global") },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe(globalScopeSkillDir("my-global", globalRoot));
    expect(existsSync(join(r.path, "SKILL.md"))).toBe(true);
    expect(existsSync(join(r.path, authorshipMarkerName(ADMIN)))).toBe(true);
    // Peer agent's marker must NOT be present.
    expect(existsSync(join(r.path, authorshipMarkerName(PEER_ADMIN)))).toBe(false);
  });

  it("global create denied for non-admin agent", () => {
    process.env.SWITCHROOM_AGENT_NAME = NON_ADMIN;
    const r = skillCreate({
      agent: NON_ADMIN,
      name: "evil",
      scope: "global",
      isAdmin,
      globalRoot,
      files: { "SKILL.md": validSkillMd("evil") },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_SCOPE_DENIED");
  });

  it("global create denied when /skills-rw mount is missing", () => {
    const missing = join(globalRoot, "not-there");
    const r = skillCreate({
      agent: ADMIN,
      name: "no-mount",
      scope: "global",
      isAdmin,
      globalRoot: missing,
      files: { "SKILL.md": validSkillMd("no-mount") },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_GLOBAL_MOUNT_UNCONFIGURED");
    expect(r.exit).toBe(17);
  });

  it("global edit of own-authored skill succeeds", () => {
    const cr = skillCreate({
      agent: ADMIN, name: "mine", scope: "global", isAdmin, globalRoot,
      files: { "SKILL.md": validSkillMd("mine") },
    });
    if (!cr.ok) throw new Error("setup failed");
    const rd = skillRead({
      agent: ADMIN, name: "mine", file: "SKILL.md",
      scope: "global", isAdmin, globalRoot,
    });
    if (!rd.ok || !("version" in rd)) throw new Error("read failed");
    const ed = skillEdit({
      agent: ADMIN, name: "mine", file: "SKILL.md",
      content: validSkillMd("mine", "updated"),
      version: rd.version,
      scope: "global", isAdmin, globalRoot,
    });
    expect(ed.ok).toBe(true);
    expect(readFileSync(join(cr.path, "SKILL.md"), "utf-8")).toContain("updated");
  });

  it("global edit of peer-authored skill refused with E_SKILL_OPERATOR_OWNED", () => {
    // Peer ADMIN creates it (env-pinned as that agent for the call)...
    process.env.SWITCHROOM_AGENT_NAME = PEER_ADMIN;
    const cr = skillCreate({
      agent: PEER_ADMIN, name: "shared", scope: "global", isAdmin, globalRoot,
      files: { "SKILL.md": validSkillMd("shared") },
    });
    if (!cr.ok) throw new Error(`setup failed: ${cr.code} ${cr.message}`);
    // ...then ADMIN tries to edit it.
    process.env.SWITCHROOM_AGENT_NAME = ADMIN;
    const rd = skillRead({
      agent: ADMIN, name: "shared", file: "SKILL.md",
      scope: "global", isAdmin, globalRoot,
    });
    if (!rd.ok || !("version" in rd)) throw new Error("read failed");
    const ed = skillEdit({
      agent: ADMIN, name: "shared", file: "SKILL.md",
      content: validSkillMd("shared", "hijacked"),
      version: rd.version,
      scope: "global", isAdmin, globalRoot,
    });
    expect(ed.ok).toBe(false);
    if (ed.ok) return;
    expect(ed.code).toBe("E_SKILL_OPERATOR_OWNED");
    expect(ed.exit).toBe(18);
  });

  it("global edit of operator-curated skill (no marker) refused", () => {
    // Pre-place a skill dir with no authorship marker (operator-curated).
    const dir = globalScopeSkillDir("operator-skill", globalRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), validSkillMd("operator-skill"));
    const rd = skillRead({
      agent: ADMIN, name: "operator-skill", file: "SKILL.md",
      scope: "global", isAdmin, globalRoot,
    });
    if (!rd.ok || !("version" in rd)) throw new Error("read failed");
    const ed = skillEdit({
      agent: ADMIN, name: "operator-skill", file: "SKILL.md",
      content: validSkillMd("operator-skill", "hijacked"),
      version: rd.version,
      scope: "global", isAdmin, globalRoot,
    });
    expect(ed.ok).toBe(false);
    if (ed.ok) return;
    expect(ed.code).toBe("E_SKILL_OPERATOR_OWNED");
  });

  it("global delete of own-authored succeeds, of peer/operator refused", () => {
    // own
    const own = skillCreate({
      agent: ADMIN, name: "mine2", scope: "global", isAdmin, globalRoot,
      files: { "SKILL.md": validSkillMd("mine2") },
    });
    if (!own.ok) throw new Error("setup");
    const delOwn = skillDelete({
      agent: ADMIN, name: "mine2", scope: "global", isAdmin, globalRoot,
    });
    expect(delOwn.ok).toBe(true);

    // peer-authored
    process.env.SWITCHROOM_AGENT_NAME = PEER_ADMIN;
    const peer = skillCreate({
      agent: PEER_ADMIN, name: "peer-skill", scope: "global", isAdmin, globalRoot,
      files: { "SKILL.md": validSkillMd("peer-skill") },
    });
    if (!peer.ok) throw new Error(`setup: ${peer.code} ${peer.message}`);
    process.env.SWITCHROOM_AGENT_NAME = ADMIN;
    const delPeer = skillDelete({
      agent: ADMIN, name: "peer-skill", scope: "global", isAdmin, globalRoot,
    });
    expect(delPeer.ok).toBe(false);
    if (delPeer.ok) return;
    expect(delPeer.code).toBe("E_SKILL_OPERATOR_OWNED");

    // operator-curated (no marker)
    const opDir = globalScopeSkillDir("op-skill", globalRoot);
    mkdirSync(opDir, { recursive: true });
    writeFileSync(join(opDir, "SKILL.md"), validSkillMd("op-skill"));
    const delOp = skillDelete({
      agent: ADMIN, name: "op-skill", scope: "global", isAdmin, globalRoot,
    });
    expect(delOp.ok).toBe(false);
    if (delOp.ok) return;
    expect(delOp.code).toBe("E_SKILL_OPERATOR_OWNED");
  });

  it("agent-scope writes still ignore the marker entirely (no regression)", () => {
    const r = skillCreate({
      agent: ADMIN, name: "agent-scoped", root: perAgentRoot, isAdmin,
      files: { "SKILL.md": validSkillMd("agent-scoped") },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No marker in agent-scope dirs.
    expect(existsSync(join(r.path, authorshipMarkerName(ADMIN)))).toBe(false);
    // Edit works without marker.
    const rd = skillRead({
      agent: ADMIN, name: "agent-scoped", file: "SKILL.md", root: perAgentRoot,
    });
    if (!rd.ok || !("version" in rd)) throw new Error("read");
    const ed = skillEdit({
      agent: ADMIN, name: "agent-scoped", file: "SKILL.md",
      content: validSkillMd("agent-scoped", "updated"),
      version: rd.version, root: perAgentRoot,
    });
    expect(ed.ok).toBe(true);
  });
});
