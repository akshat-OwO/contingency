import { resolveUserAgent } from "@contingency/protocol";
import { expect, test } from "vitest";

import { flowBrowserIdentityWarnings } from "../../src/services/browser-identity.ts";

test("the CLI warns when Chromium runs a legacy engine identity", () => {
  const userAgent = resolveUserAgent("safari-mac", "141");

  expect(flowBrowserIdentityWarnings({ userAgent })).toEqual([
    expect.stringContaining("Safari — Mac"),
  ]);
});

test("the CLI warns for a legacy engine string in a concrete identity", () => {
  const userAgent = resolveUserAgent("firefox-windows", "141");
  if (userAgent === undefined) {
    throw new Error("Firefox Windows must declare a user agent");
  }

  expect(
    flowBrowserIdentityWarnings({
      browser: {
        hasTouch: false,
        mobile: false,
        userAgent,
      },
    })
  ).toEqual([expect.stringContaining("Firefox — Windows")]);
});

test("the CLI does not warn about custom or concrete identities", () => {
  expect(
    flowBrowserIdentityWarnings({ userAgent: "Acme Mobile Browser/1.0" })
  ).toEqual([]);
  expect(
    flowBrowserIdentityWarnings({
      browser: {
        hasTouch: false,
        mobile: false,
        userAgent: "Acme Browser/1.0",
      },
    })
  ).toEqual([]);
});
