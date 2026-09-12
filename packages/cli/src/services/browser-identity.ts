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
 * `Emulation.setUserAgentOverride` parameters. An absent identity restores the
 * browser's own string, so switching a session back to the default actually
 * clears the override it carried rather than leaving the last one installed.
 * An identity with no declared client hints sends none, which leaves Chromium
 * reporting its own — the honest answer for a string-only override.
 */
export const userAgentOverride = (
  identity: BrowserIdentity | undefined,
  defaultUserAgent: string
): CdpUserAgentOverride => {
  if (identity === undefined) {
    return { userAgent: defaultUserAgent };
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
