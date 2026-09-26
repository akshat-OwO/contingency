import { describe, expect, it } from "vitest";

import { botProtectionProvider } from "../../src/services/bot-protection.ts";

/** The headers 1mg.com's `create_token` returned when Cloudflare refused it (#266). */
const cloudflareBlockPage = {
  "cache-control":
    "private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
  "cf-ray": "a41027bc1dc4518d-DEL",
  "content-type": "text/html; charset=UTF-8",
  expires: "Thu, 01 Jan 1970 00:00:01 GMT",
  "referrer-policy": "same-origin",
  server: "cloudflare",
  "x-frame-options": "SAMEORIGIN",
};

describe("botProtectionProvider", () => {
  it("recognizes Cloudflare's own block page", () => {
    expect(botProtectionProvider(403, cloudflareBlockPage)).toBe("cloudflare");
  });

  it("recognizes a Cloudflare challenge by its mitigation header", () => {
    expect(
      botProtectionProvider(403, {
        "cf-mitigated": "challenge",
        "content-type": "text/html; charset=UTF-8",
        server: "cloudflare",
      })
    ).toBe("cloudflare");
  });

  it("leaves an origin's own 403 behind Cloudflare alone", () => {
    expect(
      botProtectionProvider(403, {
        "cf-ray": "a41027bc1dc4518d-DEL",
        "content-type": "application/json",
        server: "cloudflare",
      })
    ).toBeUndefined();
    expect(
      botProtectionProvider(403, {
        "cf-ray": "a41027bc1dc4518d-DEL",
        "content-type": "text/html; charset=UTF-8",
        expires: "Sat, 26 Sep 2026 06:19:07 GMT",
        server: "cloudflare",
      })
    ).toBeUndefined();
  });

  it("leaves successful responses and other servers alone", () => {
    expect(botProtectionProvider(200, cloudflareBlockPage)).toBeUndefined();
    expect(
      botProtectionProvider(403, { ...cloudflareBlockPage, server: "nginx" })
    ).toBeUndefined();
    expect(botProtectionProvider(403, {})).toBeUndefined();
  });
});
