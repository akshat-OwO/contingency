import {
  profileViewport,
  resolveIdentity,
  resolveUserAgent,
  selectableUserAgentProfiles,
  userAgentProfiles,
} from "@contingency/protocol";
import { expect, test } from "vitest";

const CHROMIUM_VERSION = "141.0.7390.54";

/**
 * A browser identity is what a site actually observes, so choosing Chrome on
 * Android has to move every signal together — the legacy string, the client
 * hints beside it, the mobile metrics, and touch — rather than only the string
 * ([ADR 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
test("Chrome Android Mobile resolves one coherent Chromium identity", () => {
  const identity = resolveIdentity("chrome-android-mobile", CHROMIUM_VERSION);

  expect(identity).toBeDefined();
  expect(identity?.userAgent).toContain("Android");
  expect(identity?.userAgent).toContain("Chrome/141");
  expect(identity?.userAgent).toContain("Mobile Safari");
  expect(identity?.mobile).toBe(true);
  expect(identity?.hasTouch).toBe(true);
  expect(identity?.userAgentMetadata?.platform).toBe("Android");
  expect(identity?.userAgentMetadata?.model).toBe("Pixel 10");
});

/**
 * The brands a site reads have to name the Chromium actually running: a
 * `Sec-CH-UA` claiming another version than the user-agent string is the
 * incoherence this ticket exists to remove.
 */
test("client-hint brands carry the running browser's major version", () => {
  const identity = resolveIdentity("chrome-android-mobile", CHROMIUM_VERSION);
  const brands = identity?.userAgentMetadata?.brands ?? [];

  expect(brands.map(({ brand }) => brand)).toContain("Google Chrome");
  for (const { brand, version } of brands) {
    if (brand === "Not_A Brand") {
      continue;
    }
    expect(version).toBe("141");
  }
});

/** Selecting a mobile identity brings its own device metrics with it. */
test("a mobile identity declares the viewport selecting it applies", () => {
  expect(profileViewport("chrome-android-mobile")).toEqual({
    deviceScaleFactor: 3,
    height: 892,
    width: 412,
  });
  expect(profileViewport("chrome-windows")).toBeUndefined();
});

/**
 * Desktop identities are untouched: they already presented a coherent desktop
 * Chromium, and declaring signals for them would change what existing Flows
 * emulate.
 */
test("desktop Chromium identities stay string-only", () => {
  const identity = resolveIdentity("chrome-windows", CHROMIUM_VERSION);

  expect(identity?.userAgent).toBe(
    resolveUserAgent("chrome-windows", CHROMIUM_VERSION)
  );
  expect(identity?.mobile).toBe(false);
  expect(identity?.hasTouch).toBe(false);
  expect(identity?.userAgentMetadata).toBeUndefined();
});

/** The browser's own identity is an absence, not an override. */
test("the default profile applies no identity at all", () => {
  expect(resolveIdentity("default", CHROMIUM_VERSION)).toBeUndefined();
});

/**
 * Chromium can wear a Safari or Firefox string but never reproduce those
 * engines, so Create View stops offering them for new work while existing
 * Flows naming them still decode.
 */
test("Safari and Firefox identities are no longer selectable", () => {
  const offered = selectableUserAgentProfiles.map(({ id }) => id);

  expect(offered).not.toContain("safari-iphone");
  expect(offered).not.toContain("firefox-windows");
  expect(offered).toContain("chrome-android-mobile");
  expect(offered).toContain("googlebot-smartphone");
  expect(userAgentProfiles.map(({ id }) => id)).toContain("safari-iphone");
  expect(resolveUserAgent("safari-iphone", CHROMIUM_VERSION)).toContain(
    "Safari"
  );
});
