/**
 * How a concrete browser identity reaches a Page. Every session applies its
 * identity through these CDP payloads, so Teaching and Interactive Runs expose
 * the same identity ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */

import type {
  BrandVersion,
  BrowserIdentity,
  Viewport,
} from "@contingency/protocol";

/** A real Android touchscreen reports more than one contact point. */
const TOUCH_POINTS = 5;

/** The client-hint metadata shape Chromium's own override takes. */
interface CdpUserAgentMetadata {
  readonly architecture: string;
  readonly bitness: string;
  readonly brands: BrandVersion[];
  readonly fullVersionList: BrandVersion[];
  readonly mobile: boolean;
  readonly model: string;
  readonly platform: string;
  readonly platformVersion: string;
}

interface CdpUserAgentOverride {
  readonly platform?: string;
  readonly userAgent: string;
  readonly userAgentMetadata?: CdpUserAgentMetadata;
}

interface CdpDeviceMetricsOverride {
  readonly deviceScaleFactor: number;
  readonly height: number;
  readonly mobile: boolean;
  readonly width: number;
}

/**
 * `Emulation.setUserAgentOverride` parameters. An absent identity sends the
 * empty string, which clears the override rather than installing another:
 * switching a session back to the default drops the one it carried, and the
 * context's own user agent shows through with Chromium's real client hints.
 * Restating that string here instead would erase those hints — an override
 * without metadata reports no brands and sends no `Sec-CH-UA` at all, which no
 * person's Chrome does (#266). A legacy string-only identity has no hints to
 * declare, so it sends none.
 */
export const userAgentOverride = (
  identity?: BrowserIdentity
): CdpUserAgentOverride => {
  if (identity === undefined) {
    return { userAgent: "" };
  }
  const metadata = identity.userAgentMetadata;
  if (metadata === undefined) {
    return { userAgent: identity.userAgent };
  }
  const brands = (metadata.brands ?? []).map((brand) => ({ ...brand }));
  return {
    platform: metadata.platform,
    userAgent: identity.userAgent,
    userAgentMetadata: {
      architecture: metadata.architecture ?? "",
      bitness: metadata.bitness ?? "",
      brands,
      // Chromium sends the full-version list from the same brands when a
      // profile states no separate one, so the two hints cannot name
      // different browsers.
      fullVersionList: (metadata.fullVersionList ?? metadata.brands ?? []).map(
        (brand) => ({ ...brand })
      ),
      mobile: identity.mobile,
      model: metadata.model ?? "",
      platform: metadata.platform,
      platformVersion: metadata.platformVersion ?? "",
    },
  };
};

/**
 * The browser's own user agent as a person's Chrome sends it. Headless
 * Chromium names its product `HeadlessChrome`, and bot protection such as
 * Cloudflare's rejects that token outright (#266). The rest of the string is
 * already the one headed Chrome sends, so only the product token changes.
 */
export const headedUserAgent = (userAgent: string): string =>
  userAgent.replace("HeadlessChrome/", "Chrome/");

/**
 * `Emulation.setDeviceMetricsOverride` parameters. The `mobile` flag is what
 * makes Chromium lay a document out as a phone does — the visual viewport, the
 * layout width, and the mobile-shaped behaviour a site branches on — so it
 * travels with the identity rather than with the viewport control.
 */
export const deviceMetricsOverride = (
  identity: BrowserIdentity | undefined,
  viewport: Viewport
): CdpDeviceMetricsOverride => ({
  deviceScaleFactor: viewport.deviceScaleFactor,
  height: viewport.height,
  mobile: identity?.mobile ?? false,
  width: viewport.width,
});

/** `Emulation.setTouchEmulationEnabled` parameters. */
export const touchEmulation = (
  identity: BrowserIdentity | undefined
): { enabled: boolean; maxTouchPoints: number } =>
  identity?.hasTouch === true
    ? { enabled: true, maxTouchPoints: TOUCH_POINTS }
    : { enabled: false, maxTouchPoints: 1 };
