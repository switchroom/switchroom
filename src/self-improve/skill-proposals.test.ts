import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  enqueueProposal,
  getProposal,
  readProposals,
  setProposalStatus,
  isSuppressed,
  proposalContentWords,
  jaccard,
  REJECTION_TTL_MS,
} from "./skill-proposals.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "skill-proposals-"));
}

const baseInput = {
  skill_slug: "deploy-checklist",
  is_new: true,
  lesson: "Always run the smoke suite before promoting a deploy",
  draft: {
    "SKILL.md":
      "---\nname: deploy-checklist\ndescription: deploy steps\n---\n\n" +
      "1. run smoke suite\n2. check dashboards\n3. promote\n",
  },
  evidence: "seen across 3 sessions",
};

describe("skill-proposals store", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it("round-trips an enqueued proposal", () => {
    const p = enqueueProposal(dir, baseInput);
    expect(p.id).toBeTruthy();
    expect(p.status).toBe("pending");
    const fetched = getProposal(dir, p.id);
    expect(fetched?.skill_slug).toBe("deploy-checklist");
    expect(fetched?.draft["SKILL.md"]).toContain("smoke suite");
  });

  it("collapses to latest status per id (last-writer-wins)", () => {
    const p = enqueueProposal(dir, baseInput);
    setProposalStatus(dir, p.id, "approved");
    const fetched = getProposal(dir, p.id);
    expect(fetched?.status).toBe("approved");
    expect(readProposals(dir)).toHaveLength(1);
  });

  it("rejecting writes a fingerprint that suppresses a re-proposal", () => {
    const p = enqueueProposal(dir, baseInput);
    setProposalStatus(dir, p.id, "rejected");
    expect(
      isSuppressed(dir, {
        lesson: baseInput.lesson,
        draft: baseInput.draft,
        skill_slug: baseInput.skill_slug,
      }),
    ).toBe(true);
  });

  it("does NOT suppress an improved redraft of the same slug (different content)", () => {
    const p = enqueueProposal(dir, baseInput);
    setProposalStatus(dir, p.id, "rejected");
    // Same slug, genuinely different procedure — a redraft must still surface
    // rather than being swallowed by a bare slug match for 90 days.
    expect(
      isSuppressed(dir, {
        lesson: "Roll back automatically when error rate spikes post-deploy",
        draft: {
          "SKILL.md":
            "---\nname: deploy-checklist\ndescription: y\n---\n\n" +
            "watch error budget canary automatic rollback alerting paging escalation incident",
        },
        skill_slug: "deploy-checklist",
      }),
    ).toBe(false);
  });

  it("does NOT suppress an unrelated proposal", () => {
    const p = enqueueProposal(dir, baseInput);
    setProposalStatus(dir, p.id, "rejected");
    expect(
      isSuppressed(dir, {
        lesson: "Compress images before uploading to the CDN",
        draft: {
          "SKILL.md":
            "---\nname: cdn-upload\ndescription: x\n---\nresize then upload webp variants daily",
        },
        skill_slug: "cdn-upload",
      }),
    ).toBe(false);
  });

  it("suppression expires after the TTL", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const p = enqueueProposal(dir, baseInput, { now: () => t0 });
    setProposalStatus(dir, p.id, "rejected", { now: () => t0 });
    const afterTtl = t0 + REJECTION_TTL_MS + 1;
    expect(
      isSuppressed(
        dir,
        {
          lesson: baseInput.lesson,
          draft: baseInput.draft,
          skill_slug: baseInput.skill_slug,
        },
        { now: () => afterTtl },
      ),
    ).toBe(false);
  });

  it("round-trips the optional origin field untouched", () => {
    const p = enqueueProposal(dir, {
      ...baseInput,
      origin: "failure-synthesis",
    });
    const fetched = getProposal(dir, p.id);
    expect(fetched?.origin).toBe("failure-synthesis");
  });

  it("reads a legacy record lacking origin (back-compat)", () => {
    // A record written before PR2 — no `origin`. It must
    // still parse, and absence of `origin` MUST read as skill-synthesis
    // (the documented default), materialized on read (#4428) so a consumer
    // branching on `origin === "skill-synthesis"` can never miss it.
    const legacy = {
      id: "legacy-1",
      created_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      skill_slug: "deploy-checklist",
      is_new: true,
      lesson: baseInput.lesson,
      draft: baseInput.draft,
      evidence: baseInput.evidence,
    };
    appendFileSync(join(dir, "skill-proposals.jsonl"), JSON.stringify(legacy) + "\n");
    const fetched = getProposal(dir, "legacy-1");
    expect(fetched).toBeTruthy();
    expect(fetched?.origin).toBe("skill-synthesis"); // absence ⇒ default, materialized
    expect(fetched?.is_new).toBe(true);
  });

  it("normalizes an un-normalized stored origin on read (#4428)", () => {
    // A hand-written / tampered JSONL line carrying an origin that is NOT one
    // of the valid provenance values. readProposals must collapse it to the
    // skill-synthesis default via the shared normalizer — the origin check a
    // consumer runs on the loaded record must never see the raw junk value.
    const tampered = {
      id: "tampered-1",
      created_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      skill_slug: "deploy-checklist",
      is_new: true,
      lesson: baseInput.lesson,
      draft: baseInput.draft,
      evidence: baseInput.evidence,
      origin: "hand-written-bogus-origin",
    };
    appendFileSync(
      join(dir, "skill-proposals.jsonl"),
      JSON.stringify(tampered) + "\n",
    );
    const fetched = getProposal(dir, "tampered-1");
    expect(fetched).toBeTruthy();
    // Without read-normalization this would surface the raw "hand-written-
    // bogus-origin" string and bypass the origin check.
    expect(fetched?.origin).toBe("skill-synthesis");
  });

  it("matches reworded proposals via content-word jaccard", () => {
    const a = proposalContentWords({
      lesson: "always run the smoke suite before promoting a deploy",
      draft: { "SKILL.md": "run smoke suite check dashboards promote" },
    });
    const b = proposalContentWords({
      lesson: "run the smoke suite first then promote the deploy",
      draft: { "SKILL.md": "smoke suite dashboards promote release" },
    });
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.5);
  });
});
