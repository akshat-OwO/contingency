import { describe, expect, it } from "vitest";

import {
  cookieSetArgs,
  normalizeAgentBrowserCookie,
} from "../../src/services/browser-storage";

describe("normalizeAgentBrowserCookie", () => {
  it("keeps only schema-valid SameSite values", () => {
    expect(
      normalizeAgentBrowserCookie({
        domain: "example.com",
        name: "valid",
        path: "/",
        sameSite: "Lax",
        value: "1",
      }).sameSite
    ).toBe("Lax");
    expect(
      normalizeAgentBrowserCookie({
        domain: "example.com",
        name: "invalid",
        path: "/",
        sameSite: "lax",
        value: "1",
      }).sameSite
    ).toBeUndefined();
  });
});

describe("cookieSetArgs", () => {
  it("passes through a dated cookie expiry", () => {
    expect(
      cookieSetArgs({
        domain: "example.com",
        expires: 1_700_000_000,
        httpOnly: false,
        name: "sid",
        path: "/",
        secure: false,
        value: "1",
      })
    ).toContain("--expires");
    expect(
      cookieSetArgs({
        domain: "example.com",
        expires: 1_700_000_000,
        httpOnly: false,
        name: "sid",
        path: "/",
        secure: false,
        value: "1",
      })
    ).toContain("1700000000");
  });

  it("omits the expiry flag for session cookies", () => {
    expect(
      cookieSetArgs({
        domain: "example.com",
        expires: -1,
        httpOnly: false,
        name: "sid",
        path: "/",
        secure: false,
        value: "1",
      })
    ).not.toContain("--expires");
  });
});
