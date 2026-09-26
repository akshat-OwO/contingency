import type { BrowserBotProtectionBlock } from "@contingency/protocol";

/**
 * The `Expires` date Cloudflare stamps on the block and error pages it serves
 * itself. An origin behind Cloudflare answers through the same `server`
 * header, so this date is what separates Cloudflare's own refusal from an
 * ordinary 403 the site's backend returned.
 */
const CLOUDFLARE_PAGE_EXPIRES = "Thu, 01 Jan 1970 00:00:01 GMT";

const BLOCK_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

/**
 * Which bot protection, if any, refused a response. Decided from the status
 * and headers alone: a blocked XHR's body is often gone by the time anyone
 * asks, and reading every body would cost a round trip per response.
 *
 * Cloudflare marks an interactive challenge with `cf-mitigated: challenge`.
 * A block page ("Attention Required!") carries no such header, but it is
 * HTML Cloudflare generated, with its fixed 1970 `Expires` date.
 */
export const botProtectionProvider = (
  status: number,
  headers: Readonly<Record<string, string>>
): BrowserBotProtectionBlock["provider"] | undefined => {
  if (headers.server?.toLowerCase() !== "cloudflare") {
    return;
  }
  if (headers["cf-mitigated"]?.toLowerCase() === "challenge") {
    return "cloudflare";
  }
  if (
    BLOCK_STATUSES.has(status) &&
    headers["content-type"]?.toLowerCase().startsWith("text/html") === true &&
    headers.expires === CLOUDFLARE_PAGE_EXPIRES
  ) {
    return "cloudflare";
  }
};
