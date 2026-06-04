/**
 * Microsoft Graph delegated scope sets (RFC #1873 §4.3).
 *
 * Extracted from `src/cli/auth-microsoft.ts` so both the host-CLI
 * connect path AND the Telegram-native device-code connect flow
 * (telegram-plugin/gateway) request the same scopes — they must not
 * drift, or a token minted by one path would surface different tools
 * than the other.
 *
 * `org_mode: false` (the default) covers personal MSA + standard work
 * surfaces (Mail / Calendar / OneDrive). `org_mode: true` opts in to
 * SharePoint (`Sites.ReadWrite.All`). `offline_access` is mandatory —
 * without it Microsoft returns no refresh token and the account can't
 * survive the first access-token expiry.
 *
 * All scopes here are user-consentable for personal Microsoft accounts
 * (no admin consent). On work/school tenants Mail.ReadWrite /
 * Files.ReadWrite.All may require a one-time tenant-admin approval —
 * the documented "personal-first, work best-effort" boundary.
 */

export const SCOPE_SET_DEFAULT = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Calendars.ReadWrite",
  "Files.ReadWrite.All",
];

export const SCOPE_SET_ORG_MODE = [...SCOPE_SET_DEFAULT, "Sites.ReadWrite.All"];

export function selectMicrosoftScopes(orgMode: boolean): string[] {
  return orgMode ? SCOPE_SET_ORG_MODE : SCOPE_SET_DEFAULT;
}
