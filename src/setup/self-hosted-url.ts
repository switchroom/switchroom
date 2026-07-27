/**
 * Self-hosted / loopback URL predicates — the SINGLE definition of "does this
 * base URL terminate on this host or this LAN?".
 *
 * Extracted out of `hindsight.ts` (#3723) so `hindsight-context-budget.ts` can
 * read the same signal without an import cycle: `hindsight.ts` already imports
 * the budget module, so the budget module cannot import back. Before this
 * split, switchroom answered "is this lane talking to a small local model?"
 * from two different inputs — `hindsightLocalLlmEnabled` from the base URL,
 * `defaultContextWindowForProvider` from the provider NAME — with opposite
 * fail-safe directions, so a `provider: anthropic` lane pointed at
 * `http://127.0.0.1:4010` was throttled as local by one and budgeted for a
 * 200k window by the other. This module is dependency-free on purpose: both
 * callers import it, so they can never disagree.
 */

/**
 * True when `url` resolves to a host-loopback listener (localhost / 127.0.0.1 /
 * ::1). Used to decide whether hindsight must join the host network so the
 * container can reach a LiteLLM base the operator wrote as loopback.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    // `new URL("http://[::1]:4010").hostname` is "[::1]" — WITH the brackets.
    // Comparing the raw hostname against "::1" therefore never matched, so an
    // IPv6-loopback LiteLLM base was silently classified as remote and
    // hindsightNeedsHostNetwork() left the container on the bridge network
    // (the silent-retain outage class). Strip the brackets first.
    const h = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * True when `url` names an endpoint on this host or this LAN — loopback,
 * RFC1918 private space, link-local, `.local` mDNS, or Docker's
 * `host.docker.internal` bridge alias.
 *
 * This is the "finite slot pool" test, not the "reachable" test: what makes a
 * self-hosted LLM different from a cloud provider is that it serves a handful
 * of fixed slots, so filling them starves every other client on the box.
 * A hostname that is not provably private reads as cloud — the fail-safe
 * direction for the concurrency caps, since being wrong there just leaves
 * upstream's default in place.
 */
export function isSelfHostedHttpUrl(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (isLoopbackHttpUrl(url)) return true;
  if (host === "host.docker.internal" || host === "gateway.docker.internal") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (bare-IP form isLoopbackHttpUrl misses)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}
