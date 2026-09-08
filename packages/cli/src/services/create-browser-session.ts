import { makeBrowserRpcError } from "@contingency/protocol";
import type {
  BrowserCookie,
  BrowserIdentity,
  BrowserNetworkRequest,
  BrowserRpcErrorType,
  BrowserStorageSnapshot,
  BrowserStreamEvent,
  BrowserStreamId,
  BrowserTab,
  BrowserTabId,
  Geolocation,
  PermissionDecision,
  SessionEmulation,
  SessionId,
  StorageKind,
  Viewport,
} from "@contingency/protocol";
import type { Semaphore } from "effect";
import { Effect, Option, PubSub, Ref, Result, Schema } from "effect";
import type {
  BrowserContext,
  CDPSession,
  Page,
  Request,
  Response,
} from "playwright-core";

import {
  deviceMetricsOverride,
  touchEmulation,
  userAgentOverride,
} from "./browser-identity.ts";

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
   * The session's explicit website permission decisions — granted or denied,
   * context-wide or narrowed to an origin ([ADR
   * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
   */
  readonly permissions: readonly PermissionDecision[];
  readonly requestIds: WeakMap<Request, string>;
  readonly screencast: Screencast | undefined;
  readonly sequence: number;
  readonly timezoneId: string | undefined;
  readonly titles: ReadonlyMap<Page, string>;
  /**
   * The concrete browser the session presents — string, client hints, mobile
   * metrics, and touch as one value. Undefined is the browser's own identity.
   */
  readonly identity: BrowserIdentity | undefined;
  readonly viewport: Viewport;
}

export interface CreateSession {
  readonly context: BrowserContext;
  /** The browser's own locale, which clearing a locale override restores. */
  readonly defaultUserAgent: string;
  readonly emulationSessions: WeakMap<Page, Promise<CDPSession>>;
  readonly events: PubSub.PubSub<BrowserStreamEvent>;
  readonly id: SessionId;
  readonly screencastLock: Semaphore.Semaphore;
  readonly state: Ref.Ref<CreateSessionState>;
}

const ScreencastFrame = Schema.Struct({
  data: Schema.String,
  metadata: Schema.Struct({
    deviceHeight: Schema.Finite,
    deviceWidth: Schema.Finite,
    offsetTop: Schema.Finite,
    pageScaleFactor: Schema.Finite,
    scrollOffsetX: Schema.Finite,
    scrollOffsetY: Schema.Finite,
    timestamp: Schema.optional(Schema.Finite),
  }),
  sessionId: Schema.Int,
});

/** Chromium's declared shape at the screencast event boundary. */
export interface ScreencastFrameCandidate {
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

export const decodeScreencastFrame = (
  value: ScreencastFrameCandidate
): ScreencastFramePayload | undefined => {
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(ScreencastFrame)(value)
  );
  if (decoded === undefined) {
    return undefined;
  }
  const { timestamp, ...metadata } = decoded.metadata;
  if (timestamp === undefined) {
    return { ...decoded, metadata };
  }
  return { ...decoded, metadata: { ...metadata, timestamp } };
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

/**
 * Install one browser identity on a Page: the legacy string, the client-hint
 * metadata beside it, and touch capability. The device metrics that complete
 * the identity travel with the viewport, which `applyViewport` sends from the
 * same identity.
 */
export const applyIdentity = (
  session: CreateSession,
  page: Page,
  identity: BrowserIdentity | undefined
) =>
  Effect.gen(function* setPageIdentity() {
    const cdp = yield* requireEmulationSession(session, page);
    yield* tryBrowser("Could not set the user agent", () =>
      cdp.send(
        "Emulation.setUserAgentOverride",
        userAgentOverride(identity, session.defaultUserAgent)
      )
    );
    yield* tryBrowser("Could not set touch emulation", () =>
      cdp.send("Emulation.setTouchEmulationEnabled", touchEmulation(identity))
    );
  });

export const applyViewport = (
  session: CreateSession,
  page: Page,
  viewport: Viewport,
  identity: BrowserIdentity | undefined
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
      cdp.send(
        "Emulation.setDeviceMetricsOverride",
        deviceMetricsOverride(identity, viewport)
      )
    );
  });

/**
 * Timezone and locale overrides are claimed per renderer process, so a Page
 * that shares a process with one already holding the claim is answered with
 * "already in effect". The process is then emulating exactly what was asked
 * for, so that answer is not a failure: swallowing it keeps the rest of the
 * Page's environment — notably the colour scheme — from being skipped.
 */
const tolerateExistingClaim = <A>(
  effect: Effect.Effect<A, BrowserRpcErrorType>
): Effect.Effect<void, BrowserRpcErrorType> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => error.message.includes("already in effect"),
      () => Effect.void
    )
  );

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
            // An omitted accuracy emulates *position unavailable* rather than
            // a default error radius, so a location with no accuracy stated is
            // sent as `0` — the same default Playwright's own context takes.
            accuracy: geolocation.accuracy ?? 0,
            latitude: geolocation.latitude,
            longitude: geolocation.longitude,
          })
        );
    // An empty timezone id is how the protocol expresses "follow the host".
    yield* tolerateExistingClaim(
      tryBrowser(
        timezoneId === undefined
          ? "Could not clear the timezone override"
          : "Could not set the timezone override",
        () =>
          cdp.send("Emulation.setTimezoneOverride", {
            timezoneId: timezoneId ?? "",
          })
      )
    );
    // An empty locale is the protocol's own disable, restoring the host locale.
    yield* tolerateExistingClaim(
      tryBrowser(
        locale === undefined
          ? "Could not restore the locale"
          : "Could not set the locale override",
        () => cdp.send("Emulation.setLocaleOverride", { locale: locale ?? "" })
      )
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
    // The identity first: the device metrics it implies are part of it, so the
    // viewport and the user agent a site reads can never disagree about
    // whether this is a phone.
    yield* applyIdentity(session, page, state.identity);
    yield* applyViewport(session, page, state.viewport, state.identity);
    yield* applyEnvironment(session, page);
  });

/**
 * Re-apply a session's whole Emulation to every open Page. Every change that
 * can interact with another part goes through here, so changing one never
 * silently drops another (ADR 0013). The viewport is the one carve-out — it
 * touches nothing else, so a drag takes `reapplyViewport` instead.
 */
export const reapplyEmulation = (
  session: CreateSession
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.suspend(() =>
    Effect.forEach([...readSessionState(session).pageIds.keys()], (page) =>
      applyEmulationToPage(session, page)
    )
  ).pipe(Effect.asVoid);

/**
 * Re-apply only the session's viewport to every open Page. A resize is
 * interactive and carries no other change, so it does not pay for re-sending
 * the user agent and every environment override on each drag.
 */
export const reapplyViewport = (
  session: CreateSession
): Effect.Effect<void, BrowserRpcErrorType> =>
  // The state is read where the Effect runs, not where it is built, so the
  // Effect answers for the session as it is on every run.
  Effect.suspend(() => {
    const state = readSessionState(session);
    return Effect.forEach([...state.pageIds.keys()], (page) =>
      applyViewport(session, page, state.viewport, state.identity)
    );
  }).pipe(Effect.asVoid);

/**
 * The granted names of a decision set, as the calls a browser context needs:
 * the context-wide names, then the complete set each named origin must be
 * granted.
 *
 * An origin's list carries the context-wide grants as well as its own, because
 * Chromium's per-origin grant is a replacement rather than an addition — it
 * grants what it names for that origin and rejects every other permission
 * there. Sending only an origin's own names would therefore withdraw the
 * Flow's context-wide grants at exactly the site the author singled out.
 *
 * Denials need no call of their own: Chromium grants exactly what it is told
 * to and denies the rest outright, so an explicit denial and an absent
 * decision reach a site the same way — as a refusal, never as the native
 * prompt Create View cannot operate. What the denial buys is durability: the
 * Flow says the author meant it. Shared by the Runner's context-open path and
 * Create View's live session, so both reproduce a decision identically ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 *
 * A grant is never subtracted for one origin: an origin denial beside a
 * context-wide grant of the same permission is not a set a Flow may declare,
 * because no union of grants could express it.
 */
export interface GrantedPermissionScopes {
  readonly byOrigin: ReadonlyMap<string, string[]>;
  readonly contextWide: readonly string[];
}

export const grantedPermissionScopes = (
  decisions: readonly PermissionDecision[]
): GrantedPermissionScopes => {
  const granted = decisions.filter((decision) => decision.state === "granted");
  const contextWide = granted
    .filter((decision) => decision.origin === undefined)
    .map((decision) => decision.permission);
  const byOrigin = new Map<string, string[]>();
  for (const decision of granted) {
    if (decision.origin === undefined) {
      continue;
    }
    const names = byOrigin.get(decision.origin) ?? [...contextWide];
    names.push(decision.permission);
    byOrigin.set(decision.origin, names);
  }
  return { byOrigin, contextWide };
};

/**
 * Apply the session's declared permission decisions on the context. Clearing
 * first makes the result declarative: whatever a previous decision set granted
 * is gone before this one is applied.
 */
export const applyPermissions = (
  session: CreateSession
): Effect.Effect<void, BrowserRpcErrorType> =>
  Effect.gen(function* applyContextPermissions() {
    yield* tryBrowser("Could not clear website permissions", () =>
      session.context.clearPermissions()
    );
    const { permissions } = readSessionState(session);
    const { byOrigin, contextWide } = grantedPermissionScopes(permissions);
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
): SessionEmulation => {
  let emulation: SessionEmulation = {
    permissions: [...state.permissions],
    viewport: state.viewport,
  };
  if (state.colorScheme !== undefined) {
    emulation = { ...emulation, colorScheme: state.colorScheme };
  }
  if (state.geolocation !== undefined) {
    emulation = { ...emulation, geolocation: state.geolocation };
  }
  if (state.locale !== undefined) {
    emulation = { ...emulation, locale: state.locale };
  }
  if (state.timezoneId !== undefined) {
    emulation = { ...emulation, timezoneId: state.timezoneId };
  }
  // The identity alone. Writing its string beside it as `userAgent` would be
  // a second copy of one answer, and a later edit could leave the two
  // disagreeing about what the Flow emulates.
  if (state.identity !== undefined) {
    emulation = { ...emulation, browser: state.identity };
  }
  return emulation;
};

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
