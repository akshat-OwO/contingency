import { Schema } from "effect";

import { optionalNullable } from "./optional-field.ts";
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
  architecture: optionalNullable(Schema.String),
  bitness: optionalNullable(Schema.String),
  brands: optionalNullable(Schema.Array(BrandVersion)),
  fullVersionList: optionalNullable(Schema.Array(BrandVersion)),
  model: optionalNullable(Schema.String),
  platform: nonEmptyString,
  platformVersion: optionalNullable(Schema.String),
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
  userAgentMetadata: optionalNullable(UserAgentMetadata),
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

export const UserAgentProfileId = Schema.Literals([
  "default",
  "chrome-android-mobile",
  "chrome-android-mobile-high-end",
  "chrome-android-tablet",
  "chrome-iphone",
  "chrome-ipad",
  "chrome-chrome-os",
  "chrome-mac",
  "chrome-windows",
  "firefox-android-mobile",
  "firefox-android-tablet",
  "firefox-iphone",
  "firefox-ipad",
  "firefox-mac",
  "firefox-windows",
  "googlebot",
  "googlebot-desktop",
  "googlebot-smartphone",
  "edge-chromium-windows",
  "edge-chromium-mac",
  "edge-iphone",
  "edge-ipad",
  "edge-android-mobile",
  "edge-android-tablet",
  "safari-ipad",
  "safari-iphone",
  "safari-mac",
]);
export type UserAgentProfileId = typeof UserAgentProfileId.Type;

export interface UserAgentProfile {
  readonly group: string;
  readonly id: UserAgentProfileId;
  readonly label: string;
  /**
   * Whether Create View offers this identity for new work. Safari, Firefox,
   * and the iOS browsers are not selectable: every one of them is WebKit or
   * Gecko, so Chromium can wear their string but never reproduce their
   * engine, and promising otherwise would mean reopening [ADR
   * 0016](../../../docs/adr/0016-runs-are-chromium-only.md). Existing Flows
   * naming them keep running as legacy string-only overrides.
   */
  readonly selectable: boolean;
  readonly template: string | undefined;
}

export interface MatchedUserAgentProfile {
  readonly browserVersion: string;
  readonly profile: UserAgentProfile;
}

/**
 * Every identity the product knows, selectable or not. The full list stays
 * available for decoding, so a Flow naming a legacy profile still resolves.
 */
export const userAgentProfiles: readonly UserAgentProfile[] = [
  {
    group: "Default",
    id: "default",
    label: "Browser default",
    selectable: true,
    template: undefined,
  },
  {
    group: "Chrome",
    id: "chrome-android-mobile",
    label: "Chrome — Android Mobile",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-android-mobile-high-end",
    label: "Chrome — Android Mobile (high-end)",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-android-tablet",
    label: "Chrome — Android Tablet",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-iphone",
    label: "Chrome — iPhone",
    selectable: false,
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/%s Mobile/15E148 Safari/604.1",
  },
  {
    group: "Chrome",
    id: "chrome-ipad",
    label: "Chrome — iPad",
    selectable: false,
    template:
      "Mozilla/5.0 (iPad; CPU OS 26_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/%s Mobile/15E148 Safari/604.1",
  },
  {
    group: "Chrome",
    id: "chrome-chrome-os",
    label: "Chrome — Chrome OS",
    selectable: true,
    template:
      "Mozilla/5.0 (X11; CrOS x86_64 10066.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-mac",
    label: "Chrome — Mac",
    selectable: true,
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Chrome",
    id: "chrome-windows",
    label: "Chrome — Windows",
    selectable: true,
    template:
      "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36",
  },
  {
    group: "Firefox",
    id: "firefox-android-mobile",
    label: "Firefox — Android Mobile",
    selectable: false,
    template:
      "Mozilla/5.0 (Android 4.4; Mobile; rv:70.0) Gecko/70.0 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-android-tablet",
    label: "Firefox — Android Tablet",
    selectable: false,
    template:
      "Mozilla/5.0 (Android 4.4; Tablet; rv:70.0) Gecko/70.0 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-iphone",
    label: "Firefox — iPhone",
    selectable: false,
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4",
  },
  {
    group: "Firefox",
    id: "firefox-ipad",
    label: "Firefox — iPad",
    selectable: false,
    template:
      "Mozilla/5.0 (iPad; CPU iPhone OS 8_3 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) FxiOS/1.0 Mobile/12F69 Safari/600.1.4",
  },
  {
    group: "Firefox",
    id: "firefox-mac",
    label: "Firefox — Mac",
    selectable: false,
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:70.0) Gecko/20100101 Firefox/70.0",
  },
  {
    group: "Firefox",
    id: "firefox-windows",
    label: "Firefox — Windows",
    selectable: false,
    template:
      "Mozilla/5.0 (Windows NT 10.0; WOW64; rv:70.0) Gecko/20100101 Firefox/70.0",
  },
  {
    group: "Googlebot",
    id: "googlebot",
    label: "Googlebot",
    selectable: true,
    template:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    group: "Googlebot",
    id: "googlebot-desktop",
    label: "Googlebot Desktop",
    selectable: true,
    template:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/%s Safari/537.36",
  },
  {
    group: "Googlebot",
    id: "googlebot-smartphone",
    label: "Googlebot Smartphone",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    group: "Microsoft Edge",
    id: "edge-chromium-windows",
    label: "Microsoft Edge (Chromium) — Windows",
    selectable: true,
    template:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 Edg/%s",
  },
  {
    group: "Microsoft Edge",
    id: "edge-chromium-mac",
    label: "Microsoft Edge (Chromium) — Mac",
    selectable: true,
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/%s Safari/604.1 Edg/%s",
  },
  {
    group: "Microsoft Edge",
    id: "edge-iphone",
    label: "Microsoft Edge — iPhone",
    selectable: false,
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.1 EdgiOS/44.5.0.10 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Microsoft Edge",
    id: "edge-ipad",
    label: "Microsoft Edge — iPad",
    selectable: false,
    template:
      "Mozilla/5.0 (iPad; CPU OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 EdgiOS/44.5.2 Mobile/15E148 Safari/605.1.15",
  },
  {
    group: "Microsoft Edge",
    id: "edge-android-mobile",
    label: "Microsoft Edge — Android Mobile",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 8.1.0; Pixel Build/OPM4.171019.021.D1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36 EdgA/42.0.0.2057",
  },
  {
    group: "Microsoft Edge",
    id: "edge-android-tablet",
    label: "Microsoft Edge — Android Tablet",
    selectable: true,
    template:
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 7 Build/MOB30X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Safari/537.36 EdgA/42.0.0.2057",
  },
  {
    group: "Safari",
    id: "safari-ipad",
    label: "Safari — iPad iOS 13.2",
    selectable: false,
    template:
      "Mozilla/5.0 (iPad; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Safari",
    id: "safari-iphone",
    label: "Safari — iPhone iOS 13.2",
    selectable: false,
    template:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
  },
  {
    group: "Safari",
    id: "safari-mac",
    label: "Safari — Mac",
    selectable: false,
    template:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Safari/605.1.15",
  },
];

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
const profileIdentities: Partial<Record<UserAgentProfileId, ProfileIdentity>> =
  {
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
  profileId: UserAgentProfileId
): ProfileIdentity | undefined => profileIdentities[profileId];

/** The viewport selecting a profile applies, when it declares one. */
export const profileViewport = (
  profileId: UserAgentProfileId
): Viewport | undefined => profileIdentities[profileId]?.viewport;

const resolveBrands = (
  brands: readonly BrandVersion[] | undefined,
  chromiumMajor: string
): readonly BrandVersion[] | undefined =>
  brands?.map((entry) => ({
    brand: entry.brand,
    version: entry.version.replaceAll("%s", chromiumMajor),
  }));

/**
 * Fill a profile's client-hint metadata in against the browser actually
 * running, so the brands a site reads name the same Chromium version its
 * user-agent string does.
 */
export const resolveUserAgentMetadata = (
  metadata: UserAgentMetadata,
  chromiumMajor: string
): UserAgentMetadata => {
  const brands = resolveBrands(metadata.brands, chromiumMajor);
  const fullVersionList = resolveBrands(
    metadata.fullVersionList,
    chromiumMajor
  );
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
  profileId: UserAgentProfileId,
  chromiumMajor: string
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
            chromiumMajor
          ),
        }),
  };
};

/**
 * The identities Create View offers for new work, in the order the picker
 * shows them. The full list stays available for decoding, so an existing Flow
 * naming a legacy profile still resolves (ADR 0013).
 */
export const selectableUserAgentProfiles: readonly UserAgentProfile[] =
  userAgentProfiles.filter(({ selectable }) => selectable);

const versionFromTemplate = (
  template: string,
  userAgent: string
): string | undefined => {
  const parts = template.split("%s");
  const first = parts[0] ?? "";
  if (!userAgent.startsWith(first)) {
    return undefined;
  }
  if (parts.length === 1) {
    return userAgent === template ? "" : undefined;
  }

  let offset = first.length;
  let version: string | undefined;
  for (const suffix of parts.slice(1)) {
    const suffixAt =
      suffix.length === 0
        ? userAgent.length
        : userAgent.indexOf(suffix, offset);
    if (suffixAt < offset) {
      return undefined;
    }
    const candidate = userAgent.slice(offset, suffixAt);
    if (
      candidate.length === 0 ||
      (version !== undefined && candidate !== version)
    ) {
      return undefined;
    }
    version = candidate;
    offset = suffixAt + suffix.length;
  }
  return offset === userAgent.length ? version : undefined;
};

/** Match an older profile string exactly, without inferring from fragments. */
export const matchUserAgentProfile = (
  userAgent: string
): MatchedUserAgentProfile | undefined => {
  for (const profile of userAgentProfiles) {
    if (profile.template === undefined) {
      continue;
    }
    const browserVersion = versionFromTemplate(profile.template, userAgent);
    if (browserVersion !== undefined) {
      return { browserVersion, profile };
    }
  }
  return undefined;
};

/** Explain the engine mismatch retained for an older Safari or Firefox Flow. */
export const browserIdentityCompatibilityWarning = (
  userAgent: string | undefined
): string | undefined => {
  if (userAgent === undefined) {
    return undefined;
  }
  const matched = matchUserAgentProfile(userAgent);
  if (matched === undefined || matched.profile.selectable) {
    return undefined;
  }
  return `This Flow uses ${matched.profile.label} as a legacy browser identity. Runs still use Chromium, so engine-specific behavior is not reproduced.`;
};

const majorVersion = (browserVersion: string): string =>
  browserVersion.split(".")[0] ?? browserVersion;

/**
 * The user-agent string a profile applies against the browser actually
 * running. Shared by Create View and the Runner so both normalize a profile
 * the same way.
 */
export const resolveUserAgent = (
  profileId: UserAgentProfileId,
  browserVersion: string
): string | undefined => {
  const profile = userAgentProfiles.find(({ id }) => id === profileId);
  return profile?.template?.replaceAll("%s", majorVersion(browserVersion));
};

/**
 * The complete identity a profile applies: user-agent string, client-hint
 * metadata, mobile metrics, and touch. `undefined` is the browser's own
 * identity, which the `default` profile means.
 */
export const resolveIdentity = (
  profileId: UserAgentProfileId,
  browserVersion: string
): BrowserIdentity | undefined => {
  const userAgent = resolveUserAgent(profileId, browserVersion);
  return userAgent === undefined
    ? undefined
    : browserIdentityFor(userAgent, profileId, majorVersion(browserVersion));
};
