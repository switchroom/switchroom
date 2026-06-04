import { describe, expect, it } from "vitest";
import {
  SCOPE_SET_DEFAULT,
  SCOPE_SET_ORG_MODE,
  selectMicrosoftScopes,
} from "./scopes.js";

describe("selectMicrosoftScopes", () => {
  it("default mode returns the base set including offline_access + resource scopes", () => {
    const s = selectMicrosoftScopes(false);
    expect(s).toBe(SCOPE_SET_DEFAULT);
    // offline_access is mandatory or there's no refresh token.
    expect(s).toContain("offline_access");
    expect(s).toContain("Mail.ReadWrite");
    expect(s).toContain("Calendars.ReadWrite");
    expect(s).toContain("Files.ReadWrite.All");
    // SharePoint is NOT in the default set.
    expect(s).not.toContain("Sites.ReadWrite.All");
  });

  it("org mode adds SharePoint on top of the default set", () => {
    const s = selectMicrosoftScopes(true);
    expect(s).toBe(SCOPE_SET_ORG_MODE);
    expect(s).toContain("Sites.ReadWrite.All");
    for (const base of SCOPE_SET_DEFAULT) expect(s).toContain(base);
  });
});
