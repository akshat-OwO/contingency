import { makeBrowserRpcError, userAgentProfiles } from "@contingency/protocol";
import type {
  BrowserCookie,
  BrowserNetworkRequest,
  BrowserRpcErrorType,
  BrowserStorageSnapshot,
  BrowserStreamEvent,
  BrowserStreamId,
  BrowserTab,
  BrowserTabId,
  Geolocation,
  PermissionGrant,
  SessionEmulation,
  SessionId,
  StorageKind,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import type { Semaphore } from "effect";
import { Effect, PubSub, Ref, Result } from "effect";
import type {
  BrowserContext,
  CDPSession,
  Page,
  Request,
  Response,
} from "playwright-core";

export interface ScreencastFramePayload {
  readonly data: string;
  readonly metadata: {
    readonly deviceHeight: number;
    readonly deviceWidth: number;
    readonly offsetTop: number;
    readonly pageScaleFactor: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
    readonly timestamp?: number;
  };
  readonly sessionId: number;
}

export interface Screencast {
  readonly cdp: CDPSession;
  readonly pending: ReadonlyMap<number, number>;
  readonly streamId: BrowserStreamId;
}

export interface NetworkRecord {
  readonly request: BrowserNetworkRequest;
  readonly response?: Response;
}

export type FrameAcknowledgement =
  | { readonly _tag: "stream_changed" }
  | { readonly _tag: "frame_missing" }
  | {
      readonly _tag: "acknowledge";
      readonly cdp: CDPSession;
      readonly cdpSequence: number;
    };

export interface CreateSessionState {
  readonly activePage: Page;
  /** The colour scheme Pages are fed through `prefers-color-scheme`. */
  readonly colorScheme: "light" | "dark" | undefined;
  /**
   * The location override every Page reports through the geolocation API.
   * Undefined — the default — means the browser's real position.
   */
  readonly geolocation: Geolocation | undefined;
  readonly locale: string | undefined;
  readonly network: ReadonlyMap<BrowserTabId, Map<string, NetworkRecord>>;
  readonly pageIds: ReadonlyMap<Page, BrowserTabId>;
  /**
   * Website permission grants, context-wide in v1 with `origin` as the
   * optional key ([ADR 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
   */
  readonly permissions: readonly PermissionGrant[];
  readonly requestIds: WeakMap<Request, string>;
  readonly screencast: Screencast | undefined;
  readonly sequence: number;
  readonly timezoneId: string | undefined;
  readonly titles: ReadonlyMap<Page, string>;
  readonly userAgent: string | undefined;
  readonly viewport: Viewport;
}

export interface CreateSession {
  readonly context: BrowserContext;
  /** The browser's own locale, which clearing a locale override restores. */
  readonly defaultLocale: string;
  readonly defaultUserAgent: string;
  readonly emulationSessions: WeakMap<Page, Promise<CDPSession>>;
  readonly events: PubSub.PubSub<BrowserStreamEvent>;
  readonly id: SessionId;
  readonly screencastLock: Semaphore.Semaphore;
  readonly state: Ref.Ref<CreateSessionState>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const decodeScreencastFrame = (
  value: unknown
): ScreencastFramePayload | undefined => {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    return undefined;
  }
  const { data, metadata, sessionId } = value;
  const {
    deviceHeight,
    deviceWidth,
    offsetTop,
    pageScaleFactor,
    scrollOffsetX,
    scrollOffsetY,
    timestamp,
  } = metadata;
  if (
    typeof data !== "string" ||
    !finiteNumber(sessionId) ||
    !Number.isInteger(sessionId) ||
    !finiteNumber(deviceHeight) ||
    !finiteNumber(deviceWidth) ||
    !finiteNumber(offsetTop) ||
    !finiteNumber(pageScaleFactor) ||
    !finiteNumber(scrollOffsetX) ||
    !finiteNumber(scrollOffsetY) ||
    (timestamp !== undefined && !finiteNumber(timestamp))
  ) {
    return undefined;
  }
  return {
    data,
    metadata: {
      deviceHeight,
      deviceWidth,
      offsetTop,
      pageScaleFactor,
      scrollOffsetX,
      scrollOffsetY,
      ...(timestamp === undefined ? {} : { timestamp }),
    },
    sessionId,
  };
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const browserFailure = (operation: string, cause: unknown) =>
  makeBrowserRpcError(
    "agent_browser_failed",
    `${operation}: ${errorMessage(cause)}`
  );

export const tryBrowser = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => browserFailure(operation, cause),
    try: run,
  });

export const validateBrowserUrl = (url: string) =>
  Effect.try({
    catch: () =>
      makeBrowserRpcError("invalid_url", `${url} is not a valid URL.`),
    try: () => {
      const trimmed = url.trim();
      const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/u.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      return new URL(absolute).href;
    },
  });

export const resolveUserAgent = (
  profileId: UserAgentProfileId,
  browserVersion: string
): string | undefined => {
  const profile = userAgentProfiles.find(({ id }) => id === profileId);
  const majorVersion = browserVersion.split(".")[0] ?? browserVersion;
  return profile?.template?.replaceAll("%s", majorVersion);
};

export const normalizeCookie = (cookie: {
  readonly domain: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly name: string;
  readonly path: string;
  readonly sameSite: "Strict" | "Lax" | "None";
  readonly secure: boolean;
  readonly value: string;
}): BrowserCookie => ({
  domain: cookie.domain,
  expires: cookie.expires,
  httpOnly: cookie.httpOnly,
  name: cookie.name,
  path: cookie.path,
  sameSite: cookie.sameSite,
  secure: cookie.secure,
  session: cookie.expires < 0,
  size: cookie.name.length + cookie.value.length,
  value: cookie.value,
});

export const readSessionState = (session: CreateSession): CreateSessionState =>
  Ref.getUnsafe(session.state);

export const updateSessionState = (
  session: CreateSession,
  update: (state: CreateSessionState) => CreateSessionState
): void => {
  Effect.runSync(Ref.update(session.state, update));
};

export const tabs = (session: CreateSession): readonly BrowserTab[] => {
  const state = readSessionState(session);
  return [...state.pageIds].map(([page, tabId]) => ({
    active: page === state.activePage,
    label: null,
    tabId,
    title: state.titles.get(page) ?? "",
    type: "page",
    url: page.url(),
  }));
};

export const requirePage = (
  session: CreateSession,
  tabId: BrowserTabId
): Effect.Effect<Page, BrowserRpcErrorType> => {
  const found = [...readSessionState(session).pageIds].find(
    ([, id]) => id === tabId
  )?.[0];
  if (found !== undefined) {
    return Effect.succeed(found);
  }
  return Effect.fail(
    makeBrowserRpcError(
      "session_not_found",
      `Browser tab ${tabId} was not found.`
    )
  );
};

export const emitStatus = (
  session: CreateSession,
  screencasting: boolean
): void => {
  const { viewport } = readSessionState(session);
  PubSub.publishUnsafe(session.events, {
    connected: true,
    screencasting,
    type: "status",
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
  });
};

export const publishTabs = (session: CreateSession): void => {
  PubSub.publishUnsafe(session.events, {
    tabs: tabs(session),
    timestamp: Date.now(),
    type: "tabs",
  });
};

const requireEmulationSession = (session: CreateSession, page: Page) =>
  tryBrowser("Could not connect browser emulation", () => {
    const existing = session.emulationSessions.get(page);
    if (existing !== undefined) {
      return existing;
    }
    const created = (async () => {
      try {
        return await session.context.newCDPSession(page);
      } catch (error) {
        session.emulationSessions.delete(page);
        throw error;
      }
    })();
    session.emulationSessions.set(page, created);
    return created;
  });

export const applyUserAgent = (
  session: CreateSession,
  page: Page,
  userAgent: string | undefined
) =>
  Effect.gen(function* setPageUserAgent() {
    const cdp = yield* requireEmulationSession(session, page);
    yield* tryBrowser("Could not set the user agent", () =>
      cdp.send("Network.setUserAgentOverride", {
        userAgent: userAgent ?? session.defaultUserAgent,
      })
    );
  });

export const applyViewport = (
  session: CreateSession,
  page: Page,
  viewport: Viewport
) =>
  Effect.gen(function* setPageViewport() {
    yield* tryBrowser("Could not set the viewport", () =>
      page.setViewportSize({
        height: viewport.height,
        width: viewport.width,
      })
    );
    const cdp = yield* requireEmulationSession(session, page);
    yield* tryBrowser("Could not set the viewport", () =>
      cdp.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: viewport.deviceScaleFactor,
        height: viewport.height,
        mobile: false,
        width: viewport.width,
      })
    );
  });

/**
 * Apply the session's environment Emulation — location override, timezone,
 * locale, and colour scheme — to one Page through its CDP session, the same
 * channel the user agent and viewport overrides already use. Idempotent: a
 * cleared setting is actively reset rather than left at whatever it was.
 */
export const applyEnvironment = (
  session: CreateSession,
  page: Page
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.gen(function* applyPageEnvironment() {
    const { colorScheme, geolocation, locale, timezoneId } =
      readSessionState(session);
    const cdp = yield* requireEmulationSession(session, page);
    yield* geolocation === undefined
      ? tryBrowser("Could not clear the location override", () =>
          cdp.send("Emulation.clearGeolocationOverride")
        )
      : tryBrowser("Could not set the location override", () =>
          cdp.send("Emulation.setGeolocationOverride", {
            ...(geolocation.accuracy === undefined
              ? {}
              : { accuracy: geolocation.accuracy }),
            latitude: geolocation.latitude,
            longitude: geolocation.longitude,
          })
        );
    // An empty timezone id is how the protocol expresses "follow the host".
    yield* timezoneId === undefined
      ? tryBrowser("Could not clear the timezone override", () =>
          cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" })
        )
      : tryBrowser("Could not set the timezone override", () =>
          cdp.send("Emulation.setTimezoneOverride", { timezoneId })
        );
    // CDP has no locale clear, so "cleared" means restored to the browser's
    // own — captured before any override existed.
    yield* locale === undefined
      ? tryBrowser("Could not restore the locale", () =>
          cdp.send("Emulation.setLocaleOverride", {
            locale: session.defaultLocale,
          })
        )
      : tryBrowser("Could not set the locale override", () =>
          cdp.send("Emulation.setLocaleOverride", { locale })
        );
    yield* tryBrowser("Could not set the colour scheme", () =>
      cdp.send("Emulation.setEmulatedMedia", {
        features:
          colorScheme === undefined
            ? []
            : [{ name: "prefers-color-scheme", value: colorScheme }],
      })
    );
  });

/** Everything a Page needs to match its session's declared Emulation. */
export const applyEmulationToPage = (
  session: CreateSession,
  page: Page
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.gen(function* applyFullEmulation() {
    const state = readSessionState(session);
    yield* applyViewport(session, page, state.viewport);
    // An undefined user agent resets to the browser's own, so switching a
    // session back to `default` actually clears an override it carried.
    yield* applyUserAgent(session, page, state.userAgent);
    yield* applyEnvironment(session, page);
  });

/**
 * Re-apply a session's whole Emulation to every open Page. Every change goes
 * through here, so changing one part never silently drops another (ADR 0013).
 */
export const reapplyEmulation = (
  session: CreateSession
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.forEach(readSessionState(session).pageIds.keys(), (page) =>
    applyEmulationToPage(session, page)
  ).pipe(Effect.asVoid);

/**
 * Split permission grants into the context-wide names and the per-origin ones.
 * Context-wide grants are one call; an origin key narrows a grant without
 * replacing those. Shared by the Runner's context-open path and Create View's
 * live session, so both apply grants identically ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
export const groupedPermissionGrants = (
  grants: readonly PermissionGrant[]
): {
  readonly byOrigin: ReadonlyMap<string, string[]>;
  readonly contextWide: readonly string[];
} => {
  const contextWide = grants
    .filter((grant) => grant.origin === undefined)
    .map((grant) => grant.permission);
  const byOrigin = new Map<string, string[]>();
  for (const grant of grants) {
    if (grant.origin === undefined) {
      continue;
    }
    const names = byOrigin.get(grant.origin) ?? [];
    names.push(grant.permission);
    byOrigin.set(grant.origin, names);
  }
  return { byOrigin, contextWide };
};

/** Grant the session's declared permissions on the context, declaratively. */
export const applyPermissions = (
  session: CreateSession
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.gen(function* applyContextPermissions() {
    yield* tryBrowser("Could not clear website permissions", () =>
      session.context.clearPermissions()
    );
    const { permissions } = readSessionState(session);
    const { byOrigin, contextWide } = groupedPermissionGrants(permissions);
    if (contextWide.length > 0) {
      yield* tryBrowser("Could not grant website permissions", () =>
        session.context.grantPermissions(contextWide)
      );
    }
    yield* Effect.forEach(
      [...byOrigin],
      ([origin, names]) =>
        tryBrowser("Could not grant website permissions", () =>
          session.context.grantPermissions(names, { origin })
        ),
      { discard: true }
    );
  });

export const toSessionEmulation = (
  state: CreateSessionState
): SessionEmulation => ({
  ...(state.colorScheme === undefined
    ? {}
    : { colorScheme: state.colorScheme }),
  ...(state.geolocation === undefined
    ? {}
    : { geolocation: state.geolocation }),
  ...(state.locale === undefined ? {} : { locale: state.locale }),
  permissions: [...state.permissions],
  ...(state.timezoneId === undefined ? {} : { timezoneId: state.timezoneId }),
  ...(state.userAgent === undefined ? {} : { userAgent: state.userAgent }),
  viewport: state.viewport,
});

export const emptyStorageSnapshot = (
  tabId: BrowserTabId,
  kind: StorageKind
): BrowserStorageSnapshot =>
  kind === "cookies"
    ? { cookies: [], kind, tabId }
    : { entries: {}, kind, tabId };

export const activeStoragePage = (
  session: CreateSession,
  tabId: BrowserTabId
): Page | undefined => {
  const state = readSessionState(session);
  return state.pageIds.get(state.activePage) === tabId
    ? state.activePage
    : undefined;
};

export const reportCallbackFailure = <A>(
  session: CreateSession,
  effect: Effect.Effect<A, BrowserRpcErrorType>
): Effect.Effect<void> =>
  Effect.result(effect).pipe(
    Effect.map((outcome) => {
      if (Result.isSuccess(outcome)) {
        return null;
      }
      const error = outcome.failure;
      const state = readSessionState(session);
      const tabId = state.pageIds.get(state.activePage);
      if (tabId === undefined) {
        return null;
      }
      PubSub.publishUnsafe(session.events, {
        column: null,
        line: null,
        tabId,
        text: error.message,
        timestamp: Date.now(),
        type: "page_error",
      });
      return null;
    }),
    Effect.asVoid
  );
