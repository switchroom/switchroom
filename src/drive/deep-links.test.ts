/**
 * Tests for open-in-Drive URL builders — RFC E §4.3.
 */

import { describe, expect, it } from "vitest";

import {
  classifyMimeType,
  openInDriveButton,
  openInDriveUrl,
} from "./deep-links.js";

describe("classifyMimeType", () => {
  it("classifies the four core Workspace mime types", () => {
    expect(classifyMimeType("application/vnd.google-apps.document")).toBe("doc");
    expect(classifyMimeType("application/vnd.google-apps.spreadsheet")).toBe("spreadsheet");
    expect(classifyMimeType("application/vnd.google-apps.presentation")).toBe("presentation");
    expect(classifyMimeType("application/vnd.google-apps.form")).toBe("form");
    expect(classifyMimeType("application/vnd.google-apps.drawing")).toBe("drawing");
  });

  it("falls back to 'file' for non-Workspace mime types", () => {
    expect(classifyMimeType("application/pdf")).toBe("file");
    expect(classifyMimeType("image/png")).toBe("file");
    expect(classifyMimeType("application/octet-stream")).toBe("file");
  });

  it("falls back to 'file' when mimeType is undefined", () => {
    expect(classifyMimeType(undefined)).toBe("file");
  });
});

describe("openInDriveUrl", () => {
  const id = "1abcDEFxyz789";

  it("builds the canonical edit URL for Google Docs", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.document" }),
    ).toBe(`https://docs.google.com/document/d/${id}/edit`);
  });

  it("builds the canonical edit URL for Sheets", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.spreadsheet" }),
    ).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit`);
  });

  it("builds the canonical edit URL for Slides", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.presentation" }),
    ).toBe(`https://docs.google.com/presentation/d/${id}/edit`);
  });

  it("builds the generic file viewer URL for unknown mime types", () => {
    expect(openInDriveUrl({ fileId: id, mimeType: "application/pdf" })).toBe(
      `https://drive.google.com/file/d/${id}/view`,
    );
  });

  it("builds the generic file viewer URL when mimeType is omitted", () => {
    expect(openInDriveUrl({ fileId: id })).toBe(
      `https://drive.google.com/file/d/${id}/view`,
    );
  });

  it("appends ?disco=<id> when discussionId is set", () => {
    const u = openInDriveUrl({
      fileId: id,
      mimeType: "application/vnd.google-apps.document",
      discussionId: "thread-abc-123",
    });
    expect(u).toBe(`https://docs.google.com/document/d/${id}/edit?disco=thread-abc-123`);
  });

  // ──── ID validation — defends against URL-smuggling via inline-keyboard buttons
  it("rejects fileId containing a slash (path-injection guard)", () => {
    expect(() => openInDriveUrl({ fileId: "abc/def" })).toThrow(/invalid characters/);
  });

  it("rejects fileId containing query / fragment characters", () => {
    expect(() => openInDriveUrl({ fileId: "abc?evil=1" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc#fragment" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc:def" })).toThrow(/invalid characters/);
  });

  it("rejects fileId containing whitespace", () => {
    expect(() => openInDriveUrl({ fileId: "abc def" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc\ndef" })).toThrow(/invalid characters/);
  });

  it("rejects empty fileId", () => {
    expect(() => openInDriveUrl({ fileId: "" })).toThrow(/must not be empty/);
  });

  it("rejects an entire URL passed as fileId", () => {
    expect(() =>
      openInDriveUrl({ fileId: "https://attacker.example.com/abc" }),
    ).toThrow(/invalid characters/);
  });

  it("validates discussionId same as fileId (no URL injection)", () => {
    expect(() =>
      openInDriveUrl({ fileId: "abc", discussionId: "thread/../etc" }),
    ).toThrow(/invalid characters/);
  });

  it("accepts the full Drive id charset (alnum + - + _)", () => {
    const wide = "1A_b-2C-d_3-EFG-hijklm-NOP-qrs_TUV-wxyz";
    expect(openInDriveUrl({ fileId: wide })).toContain(wide);
  });
});

describe("openInDriveButton", () => {
  it("returns the Telegram inline-keyboard {text, url} pair with the canonical button text", () => {
    const btn = openInDriveButton({
      fileId: "1abc",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(btn).toEqual({
      text: "📖 Open in Drive",
      url: "https://docs.google.com/document/d/1abc/edit",
    });
  });
});
