/**
 * Validation contract for the #2726 rollout status IPC verbs — hostd asks the
 * caller agent's gateway to POST (terminal ping / first narration message) or
 * EDIT (later phases) an ORDINARY operator-DM message. A rogue process on the
 * same UDS must not inject a malformed payload: requestId + agentName required
 * and shaped, text required non-empty and bounded, messageId (edit) an integer.
 *
 * No Bun-native API → vitest per the mixed-runner gotcha.
 */
import { describe, it, expect } from "vitest";
import { validateClientMessage } from "../gateway/ipc-server.js";
import { RICH_MESSAGE_MAX_CHARS } from "../format.js";

const post = {
  type: "rollout_status_post",
  requestId: "ro-1",
  agentName: "overlord",
  text: "⏳ Rollout → v1.2.3 — applying",
};
const edit = {
  type: "rollout_status_edit",
  requestId: "ro-1",
  agentName: "overlord",
  messageId: 42,
  text: "✅ Rollout → v1.2.3 — done",
};

describe("validateClientMessage — rollout_status_post", () => {
  it("accepts a well-formed message", () => {
    expect(validateClientMessage(post)).toBe(true);
  });

  it("rejects a missing / empty / over-long requestId", () => {
    expect(validateClientMessage({ ...post, requestId: undefined })).toBe(false);
    expect(validateClientMessage({ ...post, requestId: "" })).toBe(false);
    expect(validateClientMessage({ ...post, requestId: "x".repeat(65) })).toBe(false);
  });

  it("rejects a missing / malformed agentName", () => {
    expect(validateClientMessage({ ...post, agentName: undefined })).toBe(false);
    expect(validateClientMessage({ ...post, agentName: "Bad Name" })).toBe(false);
  });

  it("rejects empty or over-long text", () => {
    expect(validateClientMessage({ ...post, text: "" })).toBe(false);
    expect(
      validateClientMessage({ ...post, text: "x".repeat(RICH_MESSAGE_MAX_CHARS + 1) }),
    ).toBe(false);
  });
});

describe("validateClientMessage — rollout_status_edit", () => {
  it("accepts a well-formed message", () => {
    expect(validateClientMessage(edit)).toBe(true);
  });

  it("rejects a non-integer messageId", () => {
    expect(validateClientMessage({ ...edit, messageId: 1.5 })).toBe(false);
    expect(validateClientMessage({ ...edit, messageId: "42" })).toBe(false);
    expect(validateClientMessage({ ...edit, messageId: undefined })).toBe(false);
  });

  it("rejects empty text", () => {
    expect(validateClientMessage({ ...edit, text: "" })).toBe(false);
  });
});
