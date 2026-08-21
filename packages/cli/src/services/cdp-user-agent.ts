import { makeBrowserRpcError } from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Deferred, Effect } from "effect";

import {
  asString,
  isRecord,
  makeCdpConnection,
  openWebSocket,
  selectPageTarget,
} from "./cdp-client";

const userAgentError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("agent_browser_failed", message);

export const platformFromUserAgent = (userAgent: string): string => {
  if (userAgent.includes("Android")) {
    return "Linux armv8l";
  }
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) {
    return "iPhone";
  }
  if (userAgent.includes("Windows")) {
    return "Win32";
  }
  if (userAgent.includes("Macintosh")) {
    return "MacIntel";
  }
  if (userAgent.includes("CrOS")) {
    return "Linux x86_64";
  }
  return "";
};

export interface UserAgentBrandVersion {
  readonly brand: string;
  readonly version: string;
}

export interface UserAgentMetadata {
  readonly architecture: string;
  readonly bitness: string;
  readonly brands: readonly UserAgentBrandVersion[];
  readonly fullVersionList: readonly UserAgentBrandVersion[];
  readonly mobile: boolean;
  readonly model: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly wow64: boolean;
}

const edgeVersionFromUserAgent = (userAgent: string): string | undefined =>
  /(?:EdgA|EdgiOS|Edg)\/(?<version>[\d.]+)/u.exec(userAgent)?.groups?.version;

const chromeVersionFromUserAgent = (userAgent: string): string => {
  const edgeVersion = edgeVersionFromUserAgent(userAgent);
  if (edgeVersion !== undefined) {
    return edgeVersion;
  }
  return (
    /(?:Chrome|CriOS|Firefox|FxiOS)\/(?<version>[\d.]+)/u.exec(userAgent)
      ?.groups?.version ?? "151.0.0.0"
  );
};

const majorVersion = (version: string): string =>
  version.split(".", 1)[0] ?? version;

const normalizePlatformVersion = (version: string): string => {
  const parts = version.split(".").filter((part) => part.length > 0);
  while (parts.length < 3) {
    parts.push("0");
  }
  return parts.slice(0, 3).join(".");
};

const brandList = (
  brand: string,
  fullVersion: string
): readonly UserAgentBrandVersion[] => {
  const major = majorVersion(fullVersion);
  return [
    { brand: "Not:A-Brand", version: "99" },
    { brand, version: major },
    { brand: "Chromium", version: major },
  ];
};

const fullBrandList = (
  brand: string,
  fullVersion: string
): readonly UserAgentBrandVersion[] => [
  { brand: "Not:A-Brand", version: "10.0.0.0" },
  { brand, version: fullVersion },
  { brand: "Chromium", version: fullVersion },
];

const androidModel = (userAgent: string): string =>
  /Android [^;]+; (?<model>[^)]+)\)/u.exec(userAgent)?.groups?.model?.trim() ??
  "";

const androidPlatformVersion = (userAgent: string): string =>
  normalizePlatformVersion(
    /Android (?<version>[\d.]+)/u.exec(userAgent)?.groups?.version ?? "16.0.0"
  );

const iosPlatformVersion = (userAgent: string): string => {
  const match =
    /(?:iPhone OS|CPU OS) (?<version>[\d_]+)/u.exec(userAgent)?.groups
      ?.version ?? "18_0";
  return normalizePlatformVersion(match.replaceAll("_", "."));
};

/** Builds CDP `userAgentMetadata` so Client Hints match the selected profile. */
export const userAgentMetadataFromUserAgent = (
  userAgent: string
): UserAgentMetadata => {
  const fullVersion = chromeVersionFromUserAgent(userAgent);
  const isFirefox = /Firefox|FxiOS/u.test(userAgent);
  const isEdge = /EdgA\/|EdgiOS\/|Edg\//u.test(userAgent);
  let brand = "Google Chrome";
  if (isFirefox) {
    brand = "Firefox";
  } else if (isEdge) {
    brand = "Microsoft Edge";
  }
  const brands = isFirefox
    ? [{ brand: "Firefox", version: majorVersion(fullVersion) }]
    : brandList(brand, fullVersion);
  const fullVersionList = isFirefox
    ? [{ brand: "Firefox", version: fullVersion }]
    : fullBrandList(brand, fullVersion);

  if (userAgent.includes("Android")) {
    return {
      architecture: "",
      bitness: "",
      brands,
      fullVersionList,
      mobile: /Mobile/u.test(userAgent),
      model: androidModel(userAgent),
      platform: "Android",
      platformVersion: androidPlatformVersion(userAgent),
      wow64: false,
    };
  }
  if (userAgent.includes("iPhone")) {
    return {
      architecture: "",
      bitness: "",
      brands,
      fullVersionList,
      mobile: true,
      model: "iPhone",
      platform: "iOS",
      platformVersion: iosPlatformVersion(userAgent),
      wow64: false,
    };
  }
  if (userAgent.includes("iPad")) {
    return {
      architecture: "",
      bitness: "",
      brands,
      fullVersionList,
      mobile: false,
      model: "iPad",
      platform: "iOS",
      platformVersion: iosPlatformVersion(userAgent),
      wow64: false,
    };
  }
  if (userAgent.includes("Windows")) {
    return {
      architecture: "x86",
      bitness: "64",
      brands,
      fullVersionList,
      mobile: false,
      model: "",
      platform: "Windows",
      platformVersion: "10.0.0",
      wow64: false,
    };
  }
  if (userAgent.includes("CrOS")) {
    return {
      architecture: "x86",
      bitness: "64",
      brands,
      fullVersionList,
      mobile: false,
      model: "",
      platform: "Chrome OS",
      platformVersion: "14541.0.0",
      wow64: false,
    };
  }
  if (userAgent.includes("Linux")) {
    return {
      architecture: "x86",
      bitness: "64",
      brands,
      fullVersionList,
      mobile: false,
      model: "",
      platform: "Linux",
      platformVersion: "6.5.0",
      wow64: false,
    };
  }
  return {
    architecture: "arm",
    bitness: "64",
    brands,
    fullVersionList,
    mobile: false,
    model: "",
    platform: "macOS",
    platformVersion: "14.0.0",
    wow64: false,
  };
};

export interface NavigateWithUserAgentOverrideOptions {
  readonly cdpUrl: string;
  readonly requestedTabId: string | undefined;
  readonly url: string;
  /** Empty string clears a previous Emulation override. */
  readonly userAgent: string;
}

/**
 * Applies `Emulation.setUserAgentOverride` on the live page target and navigates
 * via CDP. Avoids agent-browser `--user-agent`, which is launch-config and can
 * relaunch Chromium / clear an in-session override on `open`.
 */
export const navigateWithUserAgentOverride = (
  options: NavigateWithUserAgentOverrideOptions
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.scoped(
    Effect.gen(function* applyUserAgentAndNavigate() {
      const socket = yield* openWebSocket(options.cdpUrl);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          socket.close();
        })
      );

      const loadGate = Deferred.makeUnsafe<true>();
      const connection = makeCdpConnection(socket, (event) => {
        if (event.method === "Page.loadEventFired") {
          Deferred.doneUnsafe(loadGate, Effect.succeed(true));
        }
      });
      yield* Effect.addFinalizer(() => connection.close);

      const targetsResult = yield* connection.send("Target.getTargets");
      const targetInfos =
        isRecord(targetsResult) && Array.isArray(targetsResult.targetInfos)
          ? targetsResult.targetInfos
          : [];

      const selectedTargetId = yield* selectPageTarget(
        connection,
        targetInfos,
        options.requestedTabId
      );

      const attachResult = yield* connection.send("Target.attachToTarget", {
        flatten: true,
        targetId: selectedTargetId,
      });
      const sessionId = isRecord(attachResult)
        ? asString(attachResult.sessionId)
        : undefined;
      if (sessionId === undefined) {
        return yield* Effect.fail(
          userAgentError("The browser did not create a CDP session.")
        );
      }

      yield* connection.send("Page.enable", {}, sessionId);
      yield* connection.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: options.userAgent,
          ...(options.userAgent.length === 0
            ? {}
            : {
                platform: platformFromUserAgent(options.userAgent),
                userAgentMetadata: userAgentMetadataFromUserAgent(
                  options.userAgent
                ),
              }),
        },
        sessionId
      );
      yield* connection.send("Page.navigate", { url: options.url }, sessionId);
      yield* Deferred.await(loadGate).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.asVoid
      );
    })
  );
