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
  readonly network: ReadonlyMap<BrowserTabId, Map<string, NetworkRecord>>;
  readonly pageIds: ReadonlyMap<Page, BrowserTabId>;
  readonly requestIds: WeakMap<Request, string>;
  readonly screencast: Screencast | undefined;
  readonly sequence: number;
  readonly titles: ReadonlyMap<Page, string>;
  readonly userAgent: string | undefined;
  readonly viewport: Viewport;
}

export interface CreateSession {
  readonly context: BrowserContext;
  readonly defaultUserAgent: string;
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

export const applyUserAgent = (
  session: CreateSession,
  page: Page,
  userAgent: string | undefined
) =>
  tryBrowser("Could not set the user agent", async () => {
    const cdp = await session.context.newCDPSession(page);
    try {
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: userAgent ?? session.defaultUserAgent,
      });
    } finally {
      await cdp.detach();
    }
  });

export const applyViewport = (
  session: CreateSession,
  page: Page,
  viewport: Viewport
) =>
  tryBrowser("Could not set the viewport", async () => {
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    const cdp = await session.context.newCDPSession(page);
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: viewport.deviceScaleFactor,
        height: viewport.height,
        mobile: false,
        width: viewport.width,
      });
    } finally {
      await cdp.detach();
    }
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
