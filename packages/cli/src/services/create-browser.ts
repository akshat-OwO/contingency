import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  AGENT_POINTER_ENTRY_OFFSET,
  agentPointerTravelMs,
  makeBrowserRpcError,
  resolveIdentity,
  SessionId as SessionIdSchema,
} from "@contingency/protocol";
import type {
  BrowserAgentPointer,
  BrowserInput,
  BrowserRpcErrorType,
  BrowserStreamEvent,
  DraftEmulation,
  Geolocation,
  PermissionDecision,
  SessionId,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  PubSub,
  Ref,
  Semaphore,
  Stream,
} from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { chromium } from "playwright-core";
import type {
  Browser,
  BrowserContextOptions,
  CDPSession,
  LaunchOptions,
  Page,
} from "playwright-core";

import { headedUserAgent } from "./browser-identity.ts";
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
  tabs,
  toSessionEmulation,
  tryBrowser,
  validateBrowserUrl,
} from "./create-browser-session.ts";
import type {
  BrowserFrame,
  BrowserTabsSnapshot,
  CreateSession,
  CreateSessionState,
} from "./create-browser-session.ts";
import { makeCreateBrowserStorage } from "./create-browser-storage.ts";
import { readDebuggingEndpoint } from "./debugging-endpoint.ts";
import { environmentContextOptions } from "./emulation-options.ts";

export {
  CreateBrowser,
  type CreateBrowserService,
} from "./create-browser-contract.ts";
export type {
  BrowserStorageDeleteInput,
  BrowserStorageSetInput,
} from "./create-browser-contract.ts";

/**
 * How long a click waits after its cursor lands, so the press is seen to land
 * before the Page answers it.
 */
const CLICK_LEAD_MS = 40;

/** An Emulation's environment: everything but the identity it presents. */
type SessionEnvironment = Omit<DraftEmulation, "userAgentProfile" | "viewport">;

interface MouseEventParameters {
  readonly button?: "back" | "forward" | "left" | "middle" | "none" | "right";
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: number;
  readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  readonly x: number;
  readonly y: number;
}

interface TouchEventParameters {
  readonly touchPoints: {
    readonly id: number;
    readonly x: number;
    readonly y: number;
  }[];
  readonly type: "touchStart" | "touchMove" | "touchEnd";
}

const touchEventType = (
  input: Extract<BrowserInput, { readonly type: "input_mouse" }>,
  hasTouch: boolean,
  touchActive: boolean
): TouchEventParameters["type"] | undefined => {
  if (!hasTouch || input.button === "right") {
    return;
  }
  if (input.eventType === "mousePressed") {
    return "touchStart";
  }
  if (input.eventType === "mouseReleased" && touchActive) {
    return "touchEnd";
  }
  if (input.eventType === "mouseMoved" && touchActive) {
    return "touchMove";
  }
};

interface KeyEventParameters {
  readonly code?: string;
  readonly key?: string;
  readonly modifiers?: number;
  readonly text?: string;
  readonly type: "char" | "keyDown" | "keyUp" | "rawKeyDown";
  readonly windowsVirtualKeyCode?: number;
}

const mouseEventParameters = (
  input: Extract<BrowserInput, { readonly type: "input_mouse" }>
): MouseEventParameters => {
  let parameters: MouseEventParameters = {
    type: input.eventType,
    x: input.x,
    y: input.y,
  };
  if (input.button !== undefined) {
    parameters = { ...parameters, button: input.button };
  }
  if (input.clickCount !== undefined) {
    parameters = { ...parameters, clickCount: input.clickCount };
  }
  if (input.deltaX !== undefined) {
    parameters = { ...parameters, deltaX: input.deltaX };
  }
  if (input.deltaY !== undefined) {
    parameters = { ...parameters, deltaY: input.deltaY };
  }
  if (input.modifiers !== undefined) {
    parameters = { ...parameters, modifiers: input.modifiers };
  }
  return parameters;
};

const keyEventParameters = (
  input: Extract<BrowserInput, { readonly type: "input_keyboard" }>
): KeyEventParameters => {
  let parameters: KeyEventParameters = {
    type: input.eventType,
  };
  if (input.code !== undefined) {
    parameters = { ...parameters, code: input.code };
  }
  if (input.key !== undefined) {
    parameters = { ...parameters, key: input.key };
  }
  if (input.modifiers !== undefined) {
    parameters = { ...parameters, modifiers: input.modifiers };
  }
  if (input.text !== undefined) {
    parameters = { ...parameters, text: input.text };
  }
  if (input.windowsVirtualKeyCode !== undefined) {
    parameters = {
      ...parameters,
      windowsVirtualKeyCode: input.windowsVirtualKeyCode,
    };
  }
  return parameters;
};

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
  current: readonly PermissionDecision[],
  next: readonly PermissionDecision[] | null | undefined
): readonly PermissionDecision[] => {
  if (next === undefined) {
    return current;
  }
  return next === null ? [] : [...next];
};

const releaseInputSession = (session: CreateSession) =>
  Effect.gen(function* releaseBrowserInput() {
    const active = yield* Ref.get(session.inputSession);
    if (active === null) {
      return;
    }
    yield* Ref.set(session.inputSession, null);
    yield* tryBrowser("Could not detach browser input", () =>
      active.cdp.detach()
    ).pipe(Effect.ignore);
  });

const inputSessionFor = (session: CreateSession, page: Page) =>
  Effect.gen(function* connectBrowserInput() {
    const current = yield* Ref.get(session.inputSession);
    if (current?.page === page) {
      return current.cdp;
    }
    yield* releaseInputSession(session);
    const cdp: CDPSession = yield* tryBrowser(
      "Could not connect browser input",
      () => session.context.newCDPSession(page)
    );
    cdp.on("close", () => {
      if (Ref.getUnsafe(session.inputSession)?.cdp === cdp) {
        Effect.runSync(Ref.set(session.inputSession, null));
      }
    });
    yield* Ref.set(session.inputSession, { cdp, page, touchActive: false });
    return cdp;
  });

/** The one shared Chromium, and the user agent every context presents. */
interface LaunchedBrowser {
  readonly browser: Browser;
  readonly performanceEndpoint?: string | undefined;
  readonly userAgent: string;
}

const makeService = (
  getBrowser: (
    performanceScans?: boolean
  ) => Effect.Effect<LaunchedBrowser, BrowserRpcErrorType>
): CreateBrowserService => {
  const sessions = Ref.makeUnsafe<ReadonlyMap<SessionId, CreateSession>>(
    new Map()
  );
  const registryLock = Semaphore.makeUnsafe(1);
  /** Where each session's agent cursor last landed, to time the next stroke. */
  const agentPointers = new WeakMap<
    CreateSession,
    { readonly x: number; readonly y: number }
  >();

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

  /**
   * A session may be born already emulating an environment, which its context
   * owns from birth rather than having it patched onto the first Page — see
   * `environmentContextOptions`. Permission decisions are not among those
   * settings: they are applied before the navigation by `applyPermissions`,
   * which also honours per-origin decisions.
   */
  const createUnlocked = Effect.fn("CreateBrowser.create")(
    function* createSession(
      name: string,
      viewport: Viewport,
      environment?: SessionEnvironment,
      blockServiceWorkers = false,
      performanceScans = false
    ) {
      const { browser, performanceEndpoint, userAgent } =
        yield* getBrowser(performanceScans);
      const decoded = yield* Effect.try({
        catch: () =>
          makeBrowserRpcError(
            "invalid_session",
            `${name} is not a valid browser session name.`
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
      const contextOptions: BrowserContextOptions = {
        deviceScaleFactor: viewport.deviceScaleFactor,
        // The same translation a Run applies, so a session authored here and a
        // headless Run present one environment (ADR 0013).
        ...environmentContextOptions(environment),
        serviceWorkers: blockServiceWorkers ? "block" : "allow",
        userAgent,
        viewport: { height: viewport.height, width: viewport.width },
      };
      const context = yield* tryBrowser(
        "Could not create browser session",
        () => browser.newContext(contextOptions)
      );
      const events = yield* PubSub.unbounded<BrowserStreamEvent>({
        replay: 32,
      });
      const frames = yield* PubSub.sliding<BrowserFrame>({
        capacity: 1,
        replay: 1,
      });
      const pointers = yield* PubSub.sliding<BrowserAgentPointer>({
        capacity: 8,
        replay: 1,
      });
      const tabSnapshots = yield* PubSub.unbounded<BrowserTabsSnapshot>({
        replay: 1,
      });
      const page = yield* tryBrowser("Could not create browser page", () =>
        context.newPage()
      );
      const state = yield* Ref.make<CreateSessionState>({
        activePage: page,
        colorScheme: environment?.colorScheme,
        geolocation: environment?.geolocation,
        identity: undefined,
        lastStreamId: undefined,
        locale: environment?.locale,
        network: new Map(),
        pageIds: new Map(),
        permissions: environment?.permissions ?? [],
        requestIds: new WeakMap(),
        screencast: undefined,
        sequence: 0,
        streamSubscribers: 0,
        timezoneId: environment?.timezoneId,
        titles: new Map(),
        viewport,
      });
      const session: CreateSession = {
        context,
        emulationSessions: new WeakMap(),
        events,
        frames,
        id: decoded,
        inputLock: yield* Semaphore.make(1),
        inputSession: yield* Ref.make<{
          readonly cdp: CDPSession;
          readonly page: Page;
          readonly touchActive: boolean;
        } | null>(null),
        performanceEndpoint,
        pointers,
        screencastLock: yield* Semaphore.make(1),
        state,
        tabs: tabSnapshots,
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

  const create = (
    name: string,
    viewport: Viewport,
    environment?: SessionEnvironment,
    blockServiceWorkers = false,
    performanceScans = false
  ) =>
    registryLock.withPermit(
      createUnlocked(
        name,
        viewport,
        environment,
        blockServiceWorkers,
        performanceScans
      )
    );

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
      const browser = session.context.browser();
      if (browser === null) {
        return yield* Effect.fail(
          makeBrowserRpcError(
            "session_not_found",
            "The session browser closed."
          )
        );
      }
      const normalizedUrl = yield* validateBrowserUrl(url);
      const identity = resolveIdentity(profile, browser.version());
      yield* Ref.update(session.state, (state) => ({
        ...state,
        identity,
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
        readonly permissions?: readonly PermissionDecision[] | null | undefined;
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
      // a patch that never mentions permissions leaves the context's decisions
      // alone rather than clearing and re-applying them.
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
      yield* session.inputLock.withPermit(
        Effect.gen(function* closeAfterInput() {
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.delete(sessionId);
            return next;
          });
          yield* releaseInputSession(session);
          yield* stopScreencast(session);
          yield* tryBrowser("Could not close browser session", () =>
            session.context.close()
          );
        })
      );
      yield* PubSub.shutdown(session.events);
      yield* PubSub.shutdown(session.frames);
      yield* PubSub.shutdown(session.pointers);
      yield* PubSub.shutdown(session.tabs);
    }
  );

  /**
   * Open a URL under one Emulation snapshot. The whole snapshot lands on the
   * session state, is granted and applied, and only then does the navigation
   * start — so the first request cannot carry a previous identity, viewport,
   * or environment (ADR 0013).
   */
  const open = Effect.fn("CreateBrowser.open")(function* openUrl(
    requestedSessionId: SessionId | undefined,
    url: string,
    emulation: DraftEmulation
  ) {
    const normalizedUrl = yield* validateBrowserUrl(url);
    const finishOpen = (sessionId: SessionId) =>
      Effect.gen(function* finishOpeningSession() {
        const session = yield* requireSession(sessionId);
        const browser = session.context.browser();
        if (browser === null) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "session_not_found",
              "The session browser closed."
            )
          );
        }
        const identity = resolveIdentity(
          emulation.userAgentProfile,
          browser.version()
        );
        yield* Ref.update(session.state, (state) => ({
          ...state,
          colorScheme: emulation.colorScheme,
          geolocation: emulation.geolocation,
          identity,
          locale: emulation.locale,
          permissions: [...emulation.permissions],
          timezoneId: emulation.timezoneId,
          viewport: emulation.viewport,
        }));
        // Permissions live on the context and the rest on each Page, so both
        // are applied before the navigation rather than one of them after it.
        yield* applyPermissions(session);
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
      create(`create-${randomUUID()}`, emulation.viewport, emulation),
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
    activePage: (sessionId) =>
      Effect.gen(function* readActivePage() {
        const session = yield* requireSession(sessionId);
        return readSessionState(session).activePage;
      }),
    activeTarget: (sessionId, requestedTabId) =>
      Effect.gen(function* resolveActiveTarget() {
        const session = yield* requireSession(sessionId);
        if (requestedTabId !== undefined) {
          const page = yield* requirePage(session, requestedTabId);
          return {
            context: session.context,
            page,
            performanceEndpoint: session.performanceEndpoint,
            tabId: requestedTabId,
          };
        }
        const state = readSessionState(session);
        const tabId = state.pageIds.get(state.activePage);
        if (tabId === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "session_not_found",
              `Browser session ${sessionId} has no active page.`
            )
          );
        }
        return {
          context: session.context,
          page: state.activePage,
          performanceEndpoint: session.performanceEndpoint,
          tabId,
        };
      }),
    clearStorage: storage.clear,
    close: closeSession,
    closeTab: (sessionId, tabId) =>
      Effect.gen(function* closeBrowserTab() {
        const session = yield* requireSession(sessionId);
        const page = yield* requirePage(session, tabId);
        yield* session.inputLock.withPermit(
          Effect.gen(function* closeTabAfterInput() {
            if ((yield* Ref.get(session.inputSession))?.page === page) {
              yield* releaseInputSession(session);
            }
            yield* tryBrowser("Could not close browser tab", () =>
              page.close()
            );
          })
        );
      }),
    compositor: (size) =>
      Effect.gen(function* openCompositor() {
        const { browser } = yield* getBrowser();
        const context = yield* Effect.acquireRelease(
          tryBrowser("Could not open the video compositor", () =>
            browser.newContext({
              serviceWorkers: "block",
              viewport: { height: size.height, width: size.width },
            })
          ),
          (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore)
        );
        return yield* tryBrowser("Could not open the video compositor", () =>
          context.newPage()
        );
      }),
    create: (name, viewport, blockServiceWorkers, performanceScans) =>
      create(name, viewport, undefined, blockServiceWorkers, performanceScans),
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
        if (responseBody?._tag === "Some") {
          return { ...record.request, responseBody: responseBody.value };
        }
        return record.request;
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
        yield* session.inputLock.withPermit(
          Effect.gen(function* openTabAfterInput() {
            const page = yield* tryBrowser("Could not create browser tab", () =>
              session.context.newPage()
            );
            yield* releaseInputSession(session);
            yield* Ref.update(session.state, (state) => ({
              ...state,
              activePage: page,
            }));
          })
        );
        yield* restartScreencast(session);
        publishTabs(session);
      }),
    open,
    pointAgent: (sessionId, pointer) =>
      Effect.gen(function* moveAgentPointer() {
        const session = yield* requireSession(sessionId);
        const from = agentPointers.get(session) ?? {
          x: pointer.x + AGENT_POINTER_ENTRY_OFFSET.x,
          y: pointer.y + AGENT_POINTER_ENTRY_OFFSET.y,
        };
        agentPointers.set(session, { x: pointer.x, y: pointer.y });
        const durationMs = agentPointerTravelMs(
          Math.hypot(pointer.x - from.x, pointer.y - from.y)
        );
        // `publish` applies the sliding strategy; `publishUnsafe` would drop
        // the newest point once a stalled subscriber fills the ring.
        yield* PubSub.publish(session.pointers, {
          ...pointer,
          durationMs,
          timestamp: Date.now(),
          type: "agent_pointer" as const,
        });
        // The action waits for the cursor, so a watcher sees the agent reach
        // a control before the Page reacts to it rather than after.
        yield* Effect.sleep(
          durationMs + (pointer.action === "click" ? CLICK_LEAD_MS : 0)
        );
      }),
    sendInput: (sessionId, input) =>
      Effect.gen(function* dispatchBrowserInput() {
        const session = yield* requireSession(sessionId);
        yield* session.inputLock.withPermit(
          Effect.gen(function* dispatchOrderedInput() {
            const { activePage, identity } = yield* Ref.get(session.state);
            const cdp = yield* inputSessionFor(session, activePage);
            if (input.type === "input_keyboard") {
              yield* tryBrowser("Could not dispatch browser input", () =>
                cdp.send("Input.dispatchKeyEvent", keyEventParameters(input))
              );
              return;
            }
            const touchActive =
              (yield* Ref.get(session.inputSession))?.touchActive === true;
            const touchType = touchEventType(
              input,
              identity?.hasTouch === true,
              touchActive
            );
            if (touchType !== undefined) {
              const parameters: TouchEventParameters = {
                touchPoints:
                  touchType === "touchEnd"
                    ? []
                    : [{ id: 0, x: input.x, y: input.y }],
                type: touchType,
              };
              yield* tryBrowser("Could not dispatch browser input", () =>
                cdp.send("Input.dispatchTouchEvent", parameters)
              );
              yield* Ref.set(session.inputSession, {
                cdp,
                page: activePage,
                touchActive: touchType !== "touchEnd",
              });
              return;
            }
            yield* tryBrowser("Could not dispatch browser input", () =>
              cdp.send("Input.dispatchMouseEvent", mouseEventParameters(input))
            );
          })
        );
      }),
    setEmulation,
    setStorage: storage.set,
    setUserAgent,
    setViewport,
    stream: (sessionId) =>
      Stream.unwrap(
        Effect.gen(function* openStream() {
          const subscribedAt = Date.now();
          const session = yield* requireSession(sessionId);
          yield* startScreencast(session);
          return Stream.merge(
            Stream.mergeAll(
              [
                Stream.fromPubSub(session.events),
                Stream.fromPubSub(session.pointers),
                Stream.fromPubSub(session.tabs),
              ],
              { concurrency: "unbounded" }
            ),
            Stream.fromPubSub(session.frames)
          ).pipe(
            Stream.filter(
              (event) =>
                event.type !== "frame" ||
                readSessionState(session).screencast?.streamId ===
                  event.streamId
            ),
            Stream.map((event) =>
              event.type === "frame"
                ? {
                    ...event,
                    replayed:
                      event.receivedAt !== undefined &&
                      event.receivedAt < subscribedAt,
                  }
                : event
            )
          );
        })
      ),
    switchTab: (sessionId, tabId) =>
      Effect.gen(function* switchBrowserTab() {
        const session = yield* requireSession(sessionId);
        const page = yield* requirePage(session, tabId);
        const changed = yield* session.inputLock.withPermit(
          Effect.gen(function* switchAfterInput() {
            const { activePage } = yield* Ref.get(session.state);
            if (page === activePage) {
              return false;
            }
            yield* releaseInputSession(session);
            yield* tryBrowser("Could not switch browser tab", () =>
              page.bringToFront()
            );
            yield* Ref.update(session.state, (state) => ({
              ...state,
              activePage: page,
            }));
            return true;
          })
        );
        if (!changed) {
          return;
        }
        yield* restartScreencast(session);
        publishTabs(session);
      }),
  });
};

/**
 * How Contingency starts Chromium, for every Teaching session, Dry Run, and
 * Run alike. Bot protection such as Cloudflare's rejected the headless shell
 * build, `navigator.webdriver`, and the `HeadlessChrome` user agent, and #266
 * found any one of them enough to be refused. These options remove the first
 * two: the full build in its new headless mode, with Blink's automation marker
 * off. `launchChromium` removes the third. No window opens either way.
 */
const LAUNCH_OPTIONS: LaunchOptions = {
  args: ["--disable-blink-features=AutomationControlled"],
  channel: "chromium",
  handleSIGHUP: false,
  handleSIGINT: false,
  handleSIGTERM: false,
  headless: true,
};

/**
 * Launch Chromium and read the user agent it would send, once, before any
 * session exists. Headless Chromium still names itself `HeadlessChrome`, so
 * every context presents the headed form instead — set on the context rather
 * than per Page, so workers and a popup's first request carry it too.
 */
const launchChromium = async (
  performanceDirectory?: string
): Promise<LaunchedBrowser> => {
  // Runs keep scan capability when skills are added later. Teaching and video
  // composition use a separate process without a debugging port.
  const persistent =
    performanceDirectory === undefined
      ? undefined
      : await chromium.launchPersistentContext(performanceDirectory, {
          ...LAUNCH_OPTIONS,
          args: [
            ...(LAUNCH_OPTIONS.args ?? []),
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
          ],
        });
  const browser =
    persistent === undefined
      ? await chromium.launch(LAUNCH_OPTIONS)
      : persistent.browser();
  if (browser === null) {
    await persistent?.close();
    throw new Error("The scan browser did not publish its owner.");
  }
  try {
    const performanceEndpoint =
      performanceDirectory === undefined
        ? undefined
        : await Effect.runPromise(
            readDebuggingEndpoint(
              path.join(performanceDirectory, "DevToolsActivePort")
            )
          );
    const cdp = await browser.newBrowserCDPSession();
    const version = await cdp.send("Browser.getVersion");
    await cdp.detach();
    return {
      browser,
      performanceEndpoint,
      userAgent: headedUserAgent(version.userAgent),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
};

export const CreateBrowserLive = Layer.effect(
  CreateBrowser,
  Effect.gen(function* launchCreateBrowser() {
    const fs = yield* FileSystem.FileSystem;
    const performanceDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-scan-browser-",
    });
    const registry = AtomRegistry.make();
    const launched = Atom.make<ReadonlyMap<boolean, LaunchedBrowser>>(
      new Map()
    ).pipe(Atom.keepAlive);
    const launchLock = yield* Semaphore.make(1);
    const getBrowser = (performanceScans = false) =>
      Effect.suspend(() => {
        const existing = registry.get(launched).get(performanceScans);
        if (existing !== undefined) {
          return Effect.succeed(existing);
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
              catch: (cause) =>
                browserFailure("Could not start Chromium", cause),
              try: () =>
                launchChromium(
                  performanceScans ? performanceDirectory : undefined
                ),
            }).pipe(
              Effect.tap((browser) =>
                Effect.sync(() => {
                  registry.update(launched, (current) =>
                    new Map(current).set(performanceScans, browser)
                  );
                })
              )
            )
          )
        );
      }).pipe(launchLock.withPermits(1));
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        Effect.forEach(
          registry.get(launched).values(),
          (current) =>
            Effect.promise(() => current.browser.close()).pipe(Effect.ignore),
          { discard: true }
        ).pipe(Effect.ensuring(Effect.sync(() => registry.dispose())))
      )
    );
    return makeService(getBrowser);
  })
).pipe(Layer.provide(NodeFileSystem.layer));
