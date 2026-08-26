import { randomUUID } from "node:crypto";

import {
  makeBrowserRpcError,
  SessionId as SessionIdSchema,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  BrowserStreamEvent,
  Geolocation,
  PermissionGrant,
  SessionId,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { Effect, Exit, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

import { ensureChromiumInstalled } from "./browser-install.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import { initializePage } from "./create-browser-page.ts";
import {
  acknowledgeFrame,
  restartScreencast,
  startScreencast,
  stopScreencast,
} from "./create-browser-screencast.ts";
import {
  applyPermissions,
  browserFailure,
  emitStatus,
  publishTabs,
  readSessionState,
  reapplyEmulation,
  reapplyViewport,
  requirePage,
  resolveUserAgent,
  tabs,
  toSessionEmulation,
  tryBrowser,
  validateBrowserUrl,
} from "./create-browser-session.ts";
import type {
  CreateSession,
  CreateSessionState,
} from "./create-browser-session.ts";
import { makeCreateBrowserStorage } from "./create-browser-storage.ts";

export {
  CreateBrowser,
  type CreateBrowserService,
} from "./create-browser-contract.ts";
export type {
  BrowserStorageDeleteInput,
  BrowserStorageSetInput,
} from "./create-browser-contract.ts";

/**
 * What one patch field means: absent leaves the value as it is, `null` clears
 * it, and anything else replaces it.
 */
const patchedValue = <T>(
  current: T | undefined,
  next: T | null | undefined
): T | undefined => {
  if (next === undefined) {
    return current;
  }
  return next === null ? undefined : next;
};

const patchedPermissions = (
  current: readonly PermissionGrant[],
  next: readonly PermissionGrant[] | null | undefined
): readonly PermissionGrant[] => {
  if (next === undefined) {
    return current;
  }
  return next === null ? [] : [...next];
};

const makeService = (
  getBrowser: Effect.Effect<Browser, BrowserRpcErrorType>
): CreateBrowserService => {
  const sessions = Ref.makeUnsafe<ReadonlyMap<SessionId, CreateSession>>(
    new Map()
  );
  const registryLock = Semaphore.makeUnsafe(1);

  const requireSession = (
    sessionId: SessionId
  ): Effect.Effect<CreateSession, BrowserRpcErrorType> => {
    const session = Ref.getUnsafe(sessions).get(sessionId);
    if (session !== undefined) {
      return Effect.succeed(session);
    }
    return Effect.fail(
      makeBrowserRpcError(
        "session_not_found",
        `Browser session ${sessionId} was not found.`
      )
    );
  };

  const createUnlocked = Effect.fn("CreateBrowser.create")(
    function* createSession(name: string, viewport: Viewport) {
      const browser = yield* getBrowser;
      const decoded = yield* Effect.try({
        catch: () =>
          makeBrowserRpcError(
            "invalid_session",
            `${name} is not a valid Create View session name.`
          ),
        try: () => SessionIdSchema.make(name),
      });
      if (Ref.getUnsafe(sessions).has(decoded)) {
        return yield* Effect.fail(
          makeBrowserRpcError(
            "invalid_session",
            `Browser session ${decoded} already exists.`
          )
        );
      }
      const context = yield* tryBrowser(
        "Could not create browser session",
        () =>
          browser.newContext({
            deviceScaleFactor: viewport.deviceScaleFactor,
            viewport: { height: viewport.height, width: viewport.width },
          })
      );
      const events = yield* PubSub.unbounded<BrowserStreamEvent>({
        replay: 32,
      });
      const page = yield* tryBrowser("Could not create browser page", () =>
        context.newPage()
      );
      const defaultUserAgent = yield* tryBrowser(
        "Could not read the browser user agent",
        () => page.evaluate(() => navigator.userAgent)
      );
      const state = yield* Ref.make<CreateSessionState>({
        activePage: page,
        colorScheme: undefined,
        geolocation: undefined,
        locale: undefined,
        network: new Map(),
        pageIds: new Map(),
        permissions: [],
        requestIds: new WeakMap(),
        screencast: undefined,
        sequence: 0,
        timezoneId: undefined,
        titles: new Map(),
        userAgent: undefined,
        viewport,
      });
      const session: CreateSession = {
        context,
        defaultUserAgent,
        emulationSessions: new WeakMap(),
        events,
        id: decoded,
        screencastLock: yield* Semaphore.make(1),
        state,
      };
      yield* Ref.update(sessions, (current) =>
        new Map(current).set(decoded, session)
      );
      context.on("page", (newPage) => {
        if (!readSessionState(session).pageIds.has(newPage)) {
          initializePage(session, newPage);
        }
      });
      initializePage(session, page);
      emitStatus(session, false);
      return decoded;
    }
  );

  const create = (name: string, viewport: Viewport) =>
    registryLock.withPermit(createUnlocked(name, viewport));

  const setViewport = Effect.fn("CreateBrowser.setViewport")(
    function* setSessionViewport(sessionId: SessionId, viewport: Viewport) {
      const session = yield* requireSession(sessionId);
      yield* Ref.update(session.state, (state) => ({ ...state, viewport }));
      yield* reapplyViewport(session);
      if (readSessionState(session).screencast !== undefined) {
        yield* restartScreencast(session);
      }
    }
  );

  const setUserAgent = Effect.fn("CreateBrowser.setUserAgent")(
    function* setSessionUserAgent(
      sessionId: SessionId,
      url: string,
      viewport: Viewport,
      profile: UserAgentProfileId
    ) {
      const session = yield* requireSession(sessionId);
      const browser = yield* getBrowser;
      const normalizedUrl = yield* validateBrowserUrl(url);
      const userAgent = resolveUserAgent(profile, browser.version());
      yield* Ref.update(session.state, (state) => ({
        ...state,
        userAgent,
        viewport,
      }));
      yield* reapplyEmulation(session);
      const state = yield* Ref.get(session.state);
      // A user agent only reaches a document at its navigation, so the active
      // Page is reopened; every other Emulation setting survives untouched.
      yield* tryBrowser("Could not reopen the page", () =>
        state.activePage.goto(normalizedUrl)
      );
      return { url: state.activePage.url() };
    }
  );

  const getEmulation = (sessionId: SessionId) =>
    requireSession(sessionId).pipe(
      Effect.map((session) => toSessionEmulation(readSessionState(session)))
    );

  /**
   * Patch one session's Emulation atomically. Absent leaves a part unchanged,
   * null clears it, and the whole Emulation is then applied together — so a
   * permission or location override is dropped without closing the session,
   * and no other setting moves.
   */
  const setEmulation = Effect.fn("CreateBrowser.setEmulation")(
    function* updateSessionEmulation(
      sessionId: SessionId,
      patch: {
        readonly colorScheme?: "light" | "dark" | null | undefined;
        readonly geolocation?: Geolocation | null | undefined;
        readonly locale?: string | null | undefined;
        readonly permissions?: readonly PermissionGrant[] | null | undefined;
        readonly timezoneId?: string | null | undefined;
      }
    ) {
      const session = yield* requireSession(sessionId);
      yield* Ref.update(session.state, (state) => ({
        ...state,
        colorScheme: patchedValue(state.colorScheme, patch.colorScheme),
        geolocation: patchedValue(state.geolocation, patch.geolocation),
        locale: patchedValue(state.locale, patch.locale),
        permissions: patchedPermissions(state.permissions, patch.permissions),
        timezoneId: patchedValue(state.timezoneId, patch.timezoneId),
      }));
      // Permissions live on the context, the rest on each Page. Both are
      // re-applied from the one new state, so the patch lands as a unit — but
      // a patch that never mentions permissions leaves the context's grants
      // alone rather than clearing and re-granting them.
      if (patch.permissions !== undefined) {
        yield* applyPermissions(session);
      }
      yield* reapplyEmulation(session);
      return toSessionEmulation(readSessionState(session));
    }
  );

  const closeSession = Effect.fn("CreateBrowser.close")(
    function* closeBrowserSession(sessionId: SessionId) {
      const session = yield* requireSession(sessionId);
      yield* Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
      yield* stopScreencast(session);
      yield* tryBrowser("Could not close browser session", () =>
        session.context.close()
      );
      yield* PubSub.shutdown(session.events);
    }
  );

  const open = Effect.fn("CreateBrowser.open")(function* openUrl(
    requestedSessionId: SessionId | undefined,
    url: string,
    viewport: Viewport,
    userAgentProfile: UserAgentProfileId
  ) {
    const browser = yield* getBrowser;
    const normalizedUrl = yield* validateBrowserUrl(url);
    const finishOpen = (sessionId: SessionId) =>
      Effect.gen(function* finishOpeningSession() {
        const session = yield* requireSession(sessionId);
        const userAgent = resolveUserAgent(userAgentProfile, browser.version());
        yield* Ref.update(session.state, (state) => ({
          ...state,
          userAgent,
          viewport,
        }));
        yield* reapplyEmulation(session);
        const state = yield* Ref.get(session.state);
        yield* tryBrowser("Could not open the URL", () =>
          state.activePage.goto(normalizedUrl)
        );
        return { sessionId, url: state.activePage.url() };
      });
    if (requestedSessionId !== undefined) {
      return yield* finishOpen(requestedSessionId);
    }
    return yield* Effect.acquireUseRelease(
      create(`create-${randomUUID()}`, viewport),
      finishOpen,
      (sessionId, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : closeSession(sessionId).pipe(Effect.ignore)
    );
  });

  const storage = makeCreateBrowserStorage(requireSession);

  return CreateBrowser.of({
    acknowledgeFrame: (sessionId, sequence, streamId) =>
      Effect.gen(function* findSessionForFrameAcknowledgement() {
        const session = yield* requireSession(sessionId);
        yield* acknowledgeFrame(session, sequence, streamId);
      }),
    clearStorage: storage.clear,
    close: closeSession,
    closeTab: (sessionId, tabId) =>
      Effect.gen(function* closeBrowserTab() {
        const session = yield* requireSession(sessionId);
        const page = yield* requirePage(session, tabId);
        yield* tryBrowser("Could not close browser tab", () => page.close());
      }),
    create,
    currentUrl: (sessionId) =>
      Effect.gen(function* readCurrentUrl() {
        const session = yield* requireSession(sessionId);
        return readSessionState(session).activePage.url();
      }),
    deleteStorage: storage.remove,
    getEmulation,
    getNetworkRequest: (sessionId, tabId, requestId) =>
      Effect.gen(function* readNetworkRequest() {
        const session = yield* requireSession(sessionId);
        yield* requirePage(session, tabId);
        const record = readSessionState(session)
          .network.get(tabId)
          ?.get(requestId);
        if (record === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_browser_failed",
              `Network request ${requestId} was not found.`
            )
          );
        }
        const { response } = record;
        const responseBody =
          response === undefined
            ? undefined
            : yield* tryBrowser("Could not read the response body", () =>
                response.text()
              ).pipe(Effect.option);
        return {
          ...record.request,
          ...(responseBody?._tag === "Some"
            ? { responseBody: responseBody.value }
            : {}),
        };
      }),
    getNetworkRequests: (sessionId, tabId) =>
      Effect.gen(function* readNetworkRequests() {
        const session = yield* requireSession(sessionId);
        yield* requirePage(session, tabId);
        return [
          ...(readSessionState(session).network.get(tabId)?.values() ?? []),
        ].map(({ request }) => request);
      }),
    getStorage: storage.get,
    getTabs: (sessionId) => requireSession(sessionId).pipe(Effect.map(tabs)),
    list: () => Effect.sync(() => [...Ref.getUnsafe(sessions).keys()]),
    navigate: (sessionId, action) =>
      Effect.gen(function* navigateSession() {
        const session = yield* requireSession(sessionId);
        const { activePage } = yield* Ref.get(session.state);
        yield* tryBrowser(`Could not ${action}`, async () => {
          if (action === "back") {
            await activePage.goBack();
          } else if (action === "forward") {
            await activePage.goForward();
          } else {
            await activePage.reload();
          }
        });
      }),
    newTab: (sessionId) =>
      Effect.gen(function* openNewTab() {
        const session = yield* requireSession(sessionId);
        const page = yield* tryBrowser("Could not create browser tab", () =>
          session.context.newPage()
        );
        yield* Ref.update(session.state, (state) => ({
          ...state,
          activePage: page,
        }));
        yield* restartScreencast(session);
        publishTabs(session);
      }),
    open,
    recorderTarget: (sessionId, requestedTabId) =>
      Effect.gen(function* resolveRecorderTarget() {
        const session = yield* requireSession(sessionId);
        if (requestedTabId !== undefined) {
          const page = yield* requirePage(session, requestedTabId);
          return {
            context: session.context,
            page,
            tabId: requestedTabId,
          };
        }
        const state = readSessionState(session);
        const tabId = state.pageIds.get(state.activePage);
        if (tabId === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "session_not_found",
              `Browser session ${sessionId} has no page to record.`
            )
          );
        }
        return {
          context: session.context,
          page: state.activePage,
          tabId,
        };
      }),
    sendInput: (sessionId, input) =>
      Effect.gen(function* dispatchBrowserInput() {
        const session = yield* requireSession(sessionId);
        const { activePage } = yield* Ref.get(session.state);
        const cdp = yield* tryBrowser("Could not connect browser input", () =>
          session.context.newCDPSession(activePage)
        );
        yield* tryBrowser("Could not dispatch browser input", async () => {
          try {
            const dispatched =
              input.type === "input_mouse"
                ? cdp.send("Input.dispatchMouseEvent", {
                    ...(input.button === undefined
                      ? {}
                      : { button: input.button }),
                    ...(input.clickCount === undefined
                      ? {}
                      : { clickCount: input.clickCount }),
                    ...(input.deltaX === undefined
                      ? {}
                      : { deltaX: input.deltaX }),
                    ...(input.deltaY === undefined
                      ? {}
                      : { deltaY: input.deltaY }),
                    ...(input.modifiers === undefined
                      ? {}
                      : { modifiers: input.modifiers }),
                    type: input.eventType,
                    x: input.x,
                    y: input.y,
                  })
                : cdp.send("Input.dispatchKeyEvent", {
                    ...(input.code === undefined ? {} : { code: input.code }),
                    ...(input.key === undefined ? {} : { key: input.key }),
                    ...(input.modifiers === undefined
                      ? {}
                      : { modifiers: input.modifiers }),
                    ...(input.text === undefined ? {} : { text: input.text }),
                    type: input.eventType,
                    ...(input.windowsVirtualKeyCode === undefined
                      ? {}
                      : {
                          windowsVirtualKeyCode: input.windowsVirtualKeyCode,
                        }),
                  });
            await dispatched;
          } finally {
            await cdp.detach();
          }
        });
      }),
    setEmulation,
    setStorage: storage.set,
    setUserAgent,
    setViewport,
    stream: (sessionId) =>
      Stream.unwrap(
        Effect.gen(function* openStream() {
          const session = yield* requireSession(sessionId);
          yield* startScreencast(session);
          return Stream.fromPubSub(session.events);
        })
      ),
    switchTab: (sessionId, tabId) =>
      Effect.gen(function* switchBrowserTab() {
        const session = yield* requireSession(sessionId);
        const page = yield* requirePage(session, tabId);
        const { activePage } = yield* Ref.get(session.state);
        if (page === activePage) {
          return;
        }
        yield* Ref.update(session.state, (state) => ({
          ...state,
          activePage: page,
        }));
        yield* tryBrowser("Could not switch browser tab", () =>
          page.bringToFront()
        );
        yield* restartScreencast(session);
        publishTabs(session);
      }),
  });
};

export const CreateBrowserLive = Layer.effect(
  CreateBrowser,
  Effect.gen(function* launchCreateBrowser() {
    let browser: Browser | undefined;
    const launchLock = yield* Semaphore.make(1);
    const getBrowser = Effect.suspend(() => {
      if (browser !== undefined) {
        return Effect.succeed(browser);
      }
      // First launch may pay the one-time browser download, so it sits inside
      // the same lock as the launch itself: two sessions must not race the
      // installer.
      return ensureChromiumInstalled.pipe(
        Effect.mapError((failure) =>
          browserFailure("Could not install Chromium", failure)
        ),
        Effect.andThen(
          Effect.tryPromise({
            catch: (cause) => browserFailure("Could not start Chromium", cause),
            try: () =>
              chromium.launch({
                handleSIGHUP: false,
                handleSIGINT: false,
                handleSIGTERM: false,
                headless: true,
              }),
          }).pipe(
            Effect.tap((launched) =>
              Effect.sync(() => {
                browser = launched;
              })
            )
          )
        )
      );
    }).pipe(launchLock.withPermits(1));
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const launched = browser;
        return launched === undefined
          ? Effect.void
          : Effect.promise(() => launched.close()).pipe(Effect.ignore);
      })
    );
    return makeService(getBrowser);
  })
);
