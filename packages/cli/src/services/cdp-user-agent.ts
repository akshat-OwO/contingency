import { makeBrowserRpcError } from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Deferred, Effect } from "effect";

const userAgentError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("agent_browser_failed", message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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

const chromeVersionFromUserAgent = (userAgent: string): string =>
  /(?:Chrome|CriOS|Edg|Firefox|FxiOS|Version)\/(?<version>[\d.]+)/u.exec(
    userAgent
  )?.groups?.version ?? "151.0.0.0";

const majorVersion = (version: string): string =>
  version.split(".", 1)[0] ?? version;

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
  /Android (?<version>[\d.]+)/u.exec(userAgent)?.groups?.version ?? "16.0.0";

const iosPlatformVersion = (userAgent: string): string => {
  const match =
    /(?:iPhone OS|CPU OS) (?<version>[\d_]+)/u.exec(userAgent)?.groups
      ?.version ?? "18_0";
  return match.replaceAll("_", ".");
};

/** Builds CDP `userAgentMetadata` so Client Hints match the selected profile. */
export const userAgentMetadataFromUserAgent = (
  userAgent: string
): UserAgentMetadata => {
  const fullVersion = chromeVersionFromUserAgent(userAgent);
  const isFirefox = /Firefox|FxiOS/u.test(userAgent);
  const isEdge = /Edg\//u.test(userAgent);
  const brand = isFirefox ? "Firefox" : (isEdge ? "Microsoft Edge" : "Google Chrome");
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

const openWebSocket = (
  url: string
): Effect.Effect<WebSocket, BrowserRpcErrorType> =>
  Effect.callback((resume) => {
    const socket = new WebSocket(url);
    const handleOpen = () => {
      // oxlint-disable-next-line eslint/no-use-before-define
      cleanup();
      resume(Effect.succeed(socket));
    };
    const handleError = () => {
      // oxlint-disable-next-line eslint/no-use-before-define
      cleanup();
      socket.close();
      resume(
        Effect.fail(
          userAgentError("Unable to connect to the browser CDP endpoint.")
        )
      );
    };
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
    };
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    return Effect.sync(() => {
      cleanup();
      socket.close();
    });
  });

interface CdpEvent {
  readonly method: string;
  readonly params?: unknown;
  readonly sessionId?: string;
}

interface CdpResponse {
  readonly error?: { readonly message?: string } | undefined;
  readonly id: number;
  readonly result?: unknown;
}

interface CdpConnection {
  readonly close: Effect.Effect<void>;
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string
  ) => Effect.Effect<unknown, BrowserRpcErrorType>;
}

const makeCdpConnection = (
  socket: WebSocket,
  onEvent: (event: CdpEvent) => void
): CdpConnection => {
  let nextId = 1;
  const pending = new Map<number, (response: CdpResponse) => void>();

  const handleMessage = (message: MessageEvent) => {
    if (typeof message.data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    if (typeof parsed.id === "number") {
      const parsedError = parsed.error;
      const parsedErrorMessage = isRecord(parsedError)
        ? asString(parsedError.message)
        : undefined;
      const response: CdpResponse = {
        ...(isRecord(parsedError)
          ? {
              error:
                parsedErrorMessage === undefined
                  ? {}
                  : { message: parsedErrorMessage },
            }
          : {}),
        id: parsed.id,
        ...(Object.hasOwn(parsed, "result") ? { result: parsed.result } : {}),
      };
      const complete = pending.get(response.id);
      pending.delete(response.id);
      complete?.(response);
      return;
    }
    if (typeof parsed.method === "string") {
      const sessionId = asString(parsed.sessionId);
      onEvent({
        method: parsed.method,
        ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
  };
  const failPending = () => {
    for (const [id, complete] of pending) {
      complete({ error: { message: "CDP connection closed." }, id });
    }
    pending.clear();
  };
  const handleClose = () => {
    failPending();
  };
  socket.addEventListener("message", handleMessage);
  socket.addEventListener("close", handleClose);

  const send: CdpConnection["send"] = (method, params, sessionId) =>
    Effect.callback((resume) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, (response) => {
        if (response.error !== undefined) {
          resume(
            Effect.fail(
              userAgentError(
                response.error.message ?? `CDP command ${method} failed.`
              )
            )
          );
          return;
        }
        resume(Effect.succeed(response.result));
      });
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params: params ?? {},
            ...(sessionId === undefined ? {} : { sessionId }),
          })
        );
      } catch (error) {
        pending.delete(id);
        resume(
          Effect.fail(
            userAgentError(
              error instanceof Error ? error.message : String(error)
            )
          )
        );
      }
      return Effect.sync(() => {
        pending.delete(id);
      });
    });

  return {
    close: Effect.sync(() => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      failPending();
      socket.close();
    }),
    send,
  };
};

const pageTargetIds = (targetInfos: readonly unknown[]): readonly string[] =>
  targetInfos.flatMap((target) =>
    isRecord(target) &&
    target.type === "page" &&
    typeof target.targetId === "string"
      ? [target.targetId]
      : []
  );

const selectNavigationTarget = (
  connection: CdpConnection,
  targetInfos: readonly unknown[],
  requestedTabId: string | undefined
): Effect.Effect<string, BrowserRpcErrorType> =>
  Effect.gen(function* resolveNavigationTarget() {
    const ids = pageTargetIds(targetInfos);
    if (requestedTabId !== undefined && ids.includes(requestedTabId)) {
      return requestedTabId;
    }

    const focusedTargetIds: string[] = [];
    for (const targetId of ids) {
      const attachResult = yield* connection.send("Target.attachToTarget", {
        flatten: true,
        targetId,
      });
      const probeSessionId = isRecord(attachResult)
        ? asString(attachResult.sessionId)
        : undefined;
      if (probeSessionId === undefined) {
        continue;
      }
      const focused = yield* connection
        .send(
          "Runtime.evaluate",
          {
            expression: "document.hasFocus()",
            returnByValue: true,
          },
          probeSessionId
        )
        .pipe(
          Effect.map((evaluation) => {
            const result = isRecord(evaluation) ? evaluation.result : undefined;
            return (
              isRecord(result) &&
              Object.hasOwn(result, "value") &&
              result.value === true
            );
          }),
          Effect.ensuring(
            connection
              .send("Target.detachFromTarget", { sessionId: probeSessionId })
              .pipe(Effect.ignore)
          )
        );
      if (focused) {
        focusedTargetIds.push(targetId);
      }
    }
    if (
      requestedTabId !== undefined &&
      focusedTargetIds.length === 1 &&
      focusedTargetIds[0] !== undefined
    ) {
      return focusedTargetIds[0];
    }

    const httpPage = targetInfos.find(
      (target) =>
        isRecord(target) &&
        target.type === "page" &&
        typeof target.targetId === "string" &&
        typeof target.url === "string" &&
        (target.url.startsWith("http://") || target.url.startsWith("https://"))
    );
    if (isRecord(httpPage) && typeof httpPage.targetId === "string") {
      return httpPage.targetId;
    }

    const [firstPage] = ids;
    if (firstPage !== undefined) {
      return firstPage;
    }

    return yield* Effect.fail(
      userAgentError("The active browser tab could not be resolved.")
    );
  });

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

      const selectedTargetId = yield* selectNavigationTarget(
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
