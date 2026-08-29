import type { BrowserIdentity, Flow, Viewport } from "@contingency/protocol";
import { stringOnlyIdentity } from "@contingency/protocol";

/**
 * How a concrete browser identity reaches a Page. Create View and the Runner
 * both apply an identity through these payloads, so a headless Run exposes the
 * identity the authoring session did ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */

/** A real Android touchscreen reports more than one contact point. */
const TOUCH_POINTS = 5;

/**
 * The identity a Flow's Emulation declares. `browser` is the concrete answer;
 * a bare `userAgent` is a string-only desktop override, because inferring
 * mobile behaviour from a fragment such as `Mobile` would be a guess rather
 * than a migration rule (ADR 0013).
 */
export const flowBrowserIdentity = (
  emulation: Flow["emulation"]
): BrowserIdentity | undefined => {
  if (emulation?.browser !== undefined) {
    return emulation.browser;
  }
  return emulation?.userAgent === undefined
    ? undefined
    : stringOnlyIdentity(emulation.userAgent);
};

/** The client-hint metadata shape Chromium's own override takes. */
interface CdpUserAgentMetadata {
  readonly architecture: string;
  readonly bitness: string;
  readonly brands: { readonly brand: string; readonly version: string }[];
  readonly fullVersionList: {
    readonly brand: string;
    readonly version: string;
  }[];
  readonly mobile: boolean;
  readonly model: string;
  readonly platform: string;
  readonly platformVersion: string;
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
): {
  readonly platform?: string;
  readonly userAgent: string;
  readonly userAgentMetadata?: CdpUserAgentMetadata;
} => {
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
): {
  deviceScaleFactor: number;
  height: number;
  mobile: boolean;
  width: number;
} => ({
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
