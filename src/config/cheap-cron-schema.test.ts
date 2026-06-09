import { describe, expect, it } from "vitest";
import { CronConfigSchema, ScheduleEntrySchema } from "./schema.js";

describe("ScheduleEntrySchema — kind/poll superRefine", () => {
  it("accepts a plain prompt entry (kind defaults to prompt)", () => {
    expect(ScheduleEntrySchema.safeParse({ cron: "0 8 * * *", prompt: "hi" }).success).toBe(true);
  });

  it("rejects kind:poll with no poll spec", () => {
    const r = ScheduleEntrySchema.safeParse({ cron: "*/15 * * * *", prompt: "x", kind: "poll" });
    expect(r.success).toBe(false);
  });

  it("rejects a poll spec on a prompt entry", () => {
    const r = ScheduleEntrySchema.safeParse({
      cron: "0 8 * * *",
      prompt: "x",
      poll: { type: "http-diff", url: "https://api.brevo.com/x", diff_jsonpath: "$.a", state_key: "k" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts a well-formed http-diff poll entry", () => {
    const r = ScheduleEntrySchema.safeParse({
      cron: "*/15 * * * *",
      prompt: "New: {{diff}}",
      kind: "poll",
      poll: {
        type: "http-diff",
        url: "https://api.brevo.com/v3/contacts/lists/20/contacts",
        secrets: ["brevo_api_key"],
        diff_jsonpath: "$.contacts[*].id",
        state_key: "last_max_contact_id",
      },
    });
    expect(r.success).toBe(true);
  });

  it("accepts model/context routing fields", () => {
    const r = ScheduleEntrySchema.safeParse({ cron: "0 9 * * *", prompt: "s", model: "sonnet", context: "fresh" });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid context value", () => {
    expect(ScheduleEntrySchema.safeParse({ cron: "0 9 * * *", prompt: "s", context: "nope" }).success).toBe(false);
  });
});

describe("CronConfigSchema — egress allowlist", () => {
  it("parses egress hosts + secret bindings with defaults", () => {
    const r = CronConfigSchema.safeParse({ egress: { allowed_hosts: ["api.brevo.com"], secret_bindings: { brevo_api_key: "api.brevo.com" } } });
    expect(r.success).toBe(true);
  });
  it("defaults to empty allowlist when egress omitted", () => {
    const r = CronConfigSchema.parse({ egress: {} });
    expect(r.egress).toEqual({ allowed_hosts: [], secret_bindings: {} });
  });
});
