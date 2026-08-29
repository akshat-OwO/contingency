import { Schema } from "effect";

import type { Viewport } from "./viewport.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * One entry of a Chromium user-agent client-hint brand list, as
 * `Sec-CH-UA` sends it and `navigator.userAgentData.brands` reports it.
 */
export const BrandVersion = Schema.Struct({
  brand: nonEmptyString,
  version: nonEmptyString,
});
export type BrandVersion = typeof BrandVersion.Type;

/**
 * The Chromium client-hint metadata an identity declares. `mobile` is not a
 * field here: it belongs to the identity as a whole, because the same answer
 * has to reach the client hints, the device metrics, and the media the page
 * matches, and two copies of it could disagree.
 */
export const UserAgentMetadata = Schema.Struct({
  architecture: Schema.optional(Schema.String),
  bitness: Schema.optional(Schema.String),
  brands: Schema.optional(Schema.Array(BrandVersion)),
  fullVersionList: Schema.optional(Schema.Array(BrandVersion)),
  model: Schema.optional(Schema.String),
  platform: nonEmptyString,
  platformVersion: Schema.optional(Schema.String),
});
export type UserAgentMetadata = typeof UserAgentMetadata.Type;

/**
 * The concrete browser a Flow presents to a site: the legacy user-agent
 * string, the Chromium client-hint metadata beside it, whether the device is
 * mobile, and whether it has a touchscreen ([ADR
 * 0013](../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 *
 * The identity deliberately carries no viewport of its own. Viewport and
 * device scale factor stay on the Emulation's `viewport`, which is the single
 * durable answer both Create View and the Runner apply; selecting a mobile
 * identity writes that identity's defaults into it, and a later explicit
 * viewport edit overwrites them. Two viewports — one here, one there — could
 * disagree about the same page.
 */
export const BrowserIdentity = Schema.Struct({
  hasTouch: Schema.Boolean,
  mobile: Schema.Boolean,
  userAgent: nonEmptyString,
  userAgentMetadata: Schema.optional(UserAgentMetadata),
});
export type BrowserIdentity = typeof BrowserIdentity.Type;

/**
 * A user-agent string with no further declared signals: a desktop Chromium
 * wearing a different name. Unknown custom strings decode to exactly this,
 * because inferring mobile behaviour from a fragment such as `Mobile` is a
 * guess, not a migration rule (ADR 0013).
 */
export const stringOnlyIdentity = (userAgent: string): BrowserIdentity => ({
  hasTouch: false,
  mobile: false,
  userAgent,
});

/**
 * What one Create View profile applies beyond its user-agent string, and the
 * viewport selecting it starts from. `%s` in a version stands for the
 * browser's major version, matching the user-agent templates.
 */
export interface ProfileIdentity {
  readonly hasTouch: boolean;
  readonly mobile: boolean;
  readonly userAgentMetadata: UserAgentMetadata | undefined;
  /** The viewport and scale factor selecting this profile applies. */
  readonly viewport: Viewport | undefined;
}

/** The GREASE entry Chromium includes so parsers cannot hard-code the list. */
const NOT_A_BRAND: BrandVersion = { brand: "Not_A Brand", version: "24" };

const chromiumBrands = (
  ...extra: readonly BrandVersion[]
): readonly BrandVersion[] => [
  NOT_A_BRAND,
  { brand: "Chromium", version: "%s" },
  ...extra,
];

const androidMetadata = (model: string, browser: BrandVersion) => ({
  architecture: "",
  bitness: "",
  brands: chromiumBrands(browser),
  model,
  platform: "Android",
  platformVersion: "16.0.0",
});

const CHROME_BRAND: BrandVersion = { brand: "Google Chrome", version: "%s" };
const EDGE_BRAND: BrandVersion = { brand: "Microsoft Edge", version: "%s" };

/**
 * The concrete identity behind each Chromium-family mobile profile. Desktop
 * profiles are absent deliberately: they already presented a coherent desktop
 * Chromium, and giving them declared signals would change what existing Flows
 * emulate.
 */
const profileIdentities: Partial<Record<string, ProfileIdentity>> = {
  "chrome-android-mobile": {
    hasTouch: true,
    mobile: true,
    userAgentMetadata: androidMetadata("Pixel 10", CHROME_BRAND),
    viewport: { deviceScaleFactor: 3, height: 892, width: 412 },
  },
  "chrome-android-mobile-high-end": {
    hasTouch: true,
    mobile: true,
    userAgentMetadata: androidMetadata("Pixel 10 Pro XL", CHROME_BRAND),
    viewport: { deviceScaleFactor: 3.5, height: 956, width: 448 },
  },
  "chrome-android-tablet": {
    hasTouch: true,
    // A tablet reports touch and a tablet form factor, but not `mobile`:
    // Chrome on a tablet requests desktop-shaped documents.
    mobile: false,
    userAgentMetadata: androidMetadata("Pixel Tablet", CHROME_BRAND),
    viewport: { deviceScaleFactor: 2, height: 1600, width: 1024 },
  },
  "edge-android-mobile": {
    hasTouch: true,
    mobile: true,
    userAgentMetadata: androidMetadata("Pixel", EDGE_BRAND),
    viewport: { deviceScaleFactor: 2.6, height: 823, width: 412 },
  },
  "edge-android-tablet": {
    hasTouch: true,
    mobile: false,
    userAgentMetadata: androidMetadata("Nexus 7", EDGE_BRAND),
    viewport: { deviceScaleFactor: 2, height: 960, width: 600 },
  },
  "googlebot-smartphone": {
    hasTouch: true,
    mobile: true,
    userAgentMetadata: androidMetadata("Nexus 5X", CHROME_BRAND),
    viewport: { deviceScaleFactor: 2.6, height: 732, width: 412 },
  },
};

/** The identity a Create View profile applies, when it declares more than a string. */
export const profileIdentity = (
  profileId: string
): ProfileIdentity | undefined => profileIdentities[profileId];

/** The viewport selecting a profile applies, when it declares one. */
export const profileViewport = (profileId: string): Viewport | undefined =>
  profileIdentities[profileId]?.viewport;

const resolveBrands = (
  brands: readonly BrandVersion[] | undefined,
  majorVersion: string
): readonly BrandVersion[] | undefined =>
  brands?.map((entry) => ({
    brand: entry.brand,
    version: entry.version.replaceAll("%s", majorVersion),
  }));

/**
 * Fill a profile's client-hint metadata in against the browser actually
 * running, so the brands a site reads name the same Chromium version its
 * user-agent string does.
 */
export const resolveUserAgentMetadata = (
  metadata: UserAgentMetadata,
  majorVersion: string
): UserAgentMetadata => {
  const brands = resolveBrands(metadata.brands, majorVersion);
  const fullVersionList = resolveBrands(metadata.fullVersionList, majorVersion);
  return {
    ...metadata,
    ...(brands === undefined ? {} : { brands }),
    ...(fullVersionList === undefined ? {} : { fullVersionList }),
  };
};

/**
 * The identity a profile and a running browser produce together: one value
 * covering the string, the client hints, the mobile metrics, and touch.
 * Create View stores this in the Flow rather than the profile id, so what the
 * Flow means cannot change when the profile list does (ADR 0013).
 *
 * A profile that declares no further signals — every desktop identity, and any
 * custom string — resolves to the string alone.
 */
export const browserIdentityFor = (
  userAgent: string,
  profileId: string,
  majorVersion: string
): BrowserIdentity => {
  const identity = profileIdentity(profileId);
  if (identity === undefined) {
    return stringOnlyIdentity(userAgent);
  }
  return {
    hasTouch: identity.hasTouch,
    mobile: identity.mobile,
    userAgent,
    ...(identity.userAgentMetadata === undefined
      ? {}
      : {
          userAgentMetadata: resolveUserAgentMetadata(
            identity.userAgentMetadata,
            majorVersion
          ),
        }),
  };
};
