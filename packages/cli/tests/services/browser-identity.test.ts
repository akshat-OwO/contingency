import { describe, expect, it } from "vitest";

import {
  headedUserAgent,
  userAgentOverride,
} from "../../src/services/browser-identity.ts";

describe("headedUserAgent", () => {
  it("names headless Chromium the way headed Chrome does", () => {
    expect(
      headedUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36"
      )
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
    );
  });

  it("leaves a headed user agent unchanged", () => {
    const userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
    expect(headedUserAgent(userAgent)).toBe(userAgent);
  });
});

describe("userAgentOverride", () => {
  it("clears the override for the browser default identity", () => {
    // An empty string restores the context's user agent and Chromium's own
    // client hints; restating the string would erase the hints.
    expect(userAgentOverride()).toEqual({ userAgent: "" });
  });
});
