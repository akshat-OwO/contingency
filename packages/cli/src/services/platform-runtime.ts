import { randomUUID } from "node:crypto";

import { makeBrowserRpcError } from "@contingency/protocol";
import type {
  AgentElementRef,
  AgentScreenshot,
  BrowserRpcErrorType,
  PlatformCapability,
  PlatformIdentity,
  SessionId,
  Viewport,
} from "@contingency/protocol";
import { Context, Effect, Exit, Option, Scope, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type {
  AgentBrowser,
  AgentBrowserFactory,
  AgentBrowserTab,
} from "./agent-browser-contract.ts";
import type {
  AndroidPlatformRuntime,
  AndroidRuntimeFactoryService,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import {
  browserCapabilities,
  validatePlatformRequirements,
} from "./platform-requirements.ts";
import type { SavedPlatformRequirements } from "./platform-requirements.ts";

/** Shared observations contain neither tabs nor URLs nor browser selectors. */
export interface PlatformObservation {
  readonly id: string;
  readonly platform: PlatformIdentity;
  readonly nodes: readonly {
    readonly target: string;
    readonly role: string;
    readonly name: string;
  }[];
  readonly screenshot: Omit<AgentScreenshot, "url">;
}

export type PlatformAction =
  | { readonly type: "activate"; readonly target: string }
  | { readonly type: "fill"; readonly target: string; readonly text: string }
  | { readonly type: "press"; readonly target: string; readonly key: string }
  | { readonly type: "coordinate"; readonly x: number; readonly y: number };

export interface PlatformRuntimeError {
  readonly _tag: "PlatformRuntimeError";
  readonly operation?:
    | "host-io"
    | "open"
    | "capture"
    | "screenshot"
    | "activate"
    | "fill"
    | "back"
    | "private-text"
    | "session-check";
  readonly backendReason?:
    | "ref_generation_mismatch"
    | "stale_ref"
    | "device_not_found"
    | "request_canceled"
    | "android_text_input_unverified";
  readonly code:
    | "observation_stale"
    | "runtime_failed"
    | "capability_missing"
    | "capture_incomplete"
    | "device_selection_required"
    | "device_mismatch"
    | "device_disconnected"
    | "installation_denied"
    | "helper_incompatible"
    | "helper_owned"
    | "ownership_unknown"
    | "target_unsupported"
    | "target_changed"
    | "private_input_uncertain"
    | "runtime_paused"
    | "runtime_closed"
    | "execution_canceled"
    | "cleanup_failed"
    | "preparation_failed"
    | "preparation_required"
    | "permission_stale"
    | "starting_condition_failed"
    | "environment_changed";
  readonly message: string;
}

const runtimeError = (cause: BrowserRpcErrorType): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code:
    cause.code === "agent_element_stale"
      ? "observation_stale"
      : "runtime_failed",
  message: cause.message,
});

export interface PlatformRuntimeService {
  readonly platform: PlatformIdentity;
  readonly capabilities: readonly PlatformCapability[];
  readonly observe: () => Effect.Effect<
    PlatformObservation,
    PlatformRuntimeError
  >;
  readonly dispatch: (
    observationId: string,
    action: PlatformAction
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly invalidate: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export const PlatformRuntime = Context.Service<PlatformRuntimeService>(
  "@contingency/PlatformRuntime"
);

/** Typed browser extension, private to the implementation and session service. */
export interface BrowserPlatformRuntime extends PlatformRuntimeService {
  readonly platform: "web";
  readonly browser: AgentBrowser;
  readonly browserSessionId: SessionId;
}

export interface BrowserRuntimeFactoryService {
  readonly platform: "web";
  readonly capabilities: readonly PlatformCapability[];
  readonly start: (input: {
    readonly name: string;
    readonly viewport: Viewport;
    readonly navigationPolicy: boolean;
    readonly run: boolean;
    readonly scope: Scope.Scope;
    readonly now: () => Date;
  }) => Effect.Effect<BrowserPlatformRuntime, BrowserRpcErrorType>;
}

export type BrowserRuntimeStartInput = Parameters<
  BrowserRuntimeFactoryService["start"]
>[0] & { readonly platform: "web" };
export interface PlatformRuntimeFactoryService {
  readonly web: BrowserRuntimeFactoryService;
  readonly android: AndroidRuntimeFactoryService;
  readonly start: (
    input: BrowserRuntimeStartInput | AndroidRuntimeStartInput
  ) => Effect.Effect<
    BrowserPlatformRuntime | AndroidPlatformRuntime,
    BrowserRpcErrorType | PlatformRuntimeError
  >;
}

export const makePlatformRuntimeFactory = (
  web: BrowserRuntimeFactoryService,
  android: AndroidRuntimeFactoryService
): PlatformRuntimeFactoryService => ({
  android,
  start: (input) =>
    input.platform === "web" ? web.start(input) : android.start(input),
  web,
});

export const PlatformRuntimeFactory =
  Context.Service<PlatformRuntimeFactoryService>(
    "@contingency/PlatformRuntimeFactory"
  );

const stale = () =>
  makeBrowserRpcError(
    "agent_element_stale",
    "The runtime observation is no longer valid. Take a new observation before acting."
  );
const signature = (snapshot: {
  readonly url: string;
  readonly nodes: readonly unknown[];
}) => JSON.stringify([snapshot.url, snapshot.nodes]);

/** Guard retained tabs and action observations as well as the shared dispatch path. */
export const adaptBrowserRuntime = (input: {
  readonly browser: AgentBrowser;
  readonly browserSessionId: SessionId;
  readonly close: Effect.Effect<void>;
  readonly scope: Scope.Scope;
}): Effect.Effect<BrowserPlatformRuntime> =>
  Effect.gen(function* adaptBrowser() {
    const atoms = AtomRegistry.make();
    const state = Atom.make({ closed: false, epoch: 0 }).pipe(Atom.keepAlive);
    atoms.get(state);
    // A disposed registry has no lifecycle node. Retained handles must fail
    // with a typed stale error instead of reading the disposed registry.
    const isClosed = () =>
      !atoms.getNodes().has(state) || atoms.get(state).closed;
    const observation = Atom.make<
      Option.Option<{
        readonly id: string;
        readonly epoch: number;
        readonly tab: AgentBrowserTab;
        readonly refs: ReadonlyMap<string, AgentElementRef>;
        readonly signature: string;
        readonly image: string;
      }>
    >(Option.none()).pipe(Atom.keepAlive);
    const lock = Semaphore.makeUnsafe(1);
    const invalidate = Effect.sync(() => {
      if (isClosed()) {
        return;
      }
      atoms.update(state, (current) => ({
        ...current,
        epoch: current.epoch + 1,
      }));
      atoms.set(observation, Option.none());
    });
    const live = <A, E>(
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E | BrowserRpcErrorType> =>
      Effect.suspend<A, E | BrowserRpcErrorType, never>(() =>
        isClosed() ? Effect.fail(stale()) : effect
      );
    const mutate = <A, E>(effect: Effect.Effect<A, E>) =>
      lock.withPermits(1)(
        live(
          Effect.sync(() => atoms.set(observation, Option.none())).pipe(
            Effect.andThen(effect)
          )
        )
      );
    const tabs = new WeakMap<AgentBrowserTab, AgentBrowserTab>();
    const browser: AgentBrowser = {
      ...input.browser,
      active: () =>
        live(input.browser.active()).pipe(
          Effect.map((tab) => {
            const existing = tabs.get(tab);
            if (existing !== undefined) {
              return existing;
            }
            const guarded: AgentBrowserTab = {
              ...tab,
              activateCoordinates: (...args) =>
                mutate(tab.activateCoordinates(...args)),
              beginObservation: (action) =>
                live(
                  Effect.gen(function* beginObservation() {
                    const { epoch } = atoms.get(state);
                    const captured = yield* live(tab.beginObservation(action));
                    return {
                      observe: () =>
                        live(
                          Effect.suspend(() => {
                            const current = atoms.get(state).epoch;
                            return current === epoch
                              ? captured.observe()
                              : Effect.fail(stale());
                          })
                        ),
                    };
                  })
                ),
              enterPrivate: (...args) => mutate(tab.enterPrivate(...args)),
              inspect: (x, y) => live(tab.inspect(x, y)),
              perform: (...args) => mutate(tab.perform(...args)),
              screenshot: (...args) => live(tab.screenshot(...args)),
              settledSnapshot: (options) => live(tab.settledSnapshot(options)),
              snapshot: (options) => live(tab.snapshot(options)),
              snapshotAfter: (url) => live(tab.snapshotAfter(url)),
            };
            tabs.set(tab, guarded);
            return guarded;
          })
        ),
    };
    const close = lock.withPermits(1)(
      Effect.gen(function* closeRuntime() {
        if (isClosed()) {
          return;
        }
        yield* invalidate;
        atoms.update(state, (current) => ({ ...current, closed: true }));
        yield* input.close.pipe(
          Effect.ensuring(Effect.sync(() => atoms.dispose()))
        );
      })
    );
    yield* Scope.addFinalizer(input.scope, close);
    return {
      browser,
      browserSessionId: input.browserSessionId,
      capabilities: browserCapabilities,
      close: () => close,
      dispatch: (id, action) =>
        lock
          .withPermits(1)(
            live(
              Effect.gen(function* dispatchRuntime() {
                const captured = Option.getOrUndefined(atoms.get(observation));
                if (
                  captured === undefined ||
                  captured.id !== id ||
                  captured.epoch !== atoms.get(state).epoch ||
                  (yield* input.browser.active()) !== captured.tab
                ) {
                  return yield* Effect.fail(stale());
                }
                if (
                  signature(yield* captured.tab.snapshot()) !==
                  captured.signature
                ) {
                  yield* invalidate;
                  return yield* Effect.fail(stale());
                }
                if (action.type === "coordinate") {
                  if (
                    !Number.isFinite(action.x) ||
                    !Number.isFinite(action.y) ||
                    action.x < 0 ||
                    action.y < 0 ||
                    (yield* captured.tab.screenshot(true, [], [])).image !==
                      captured.image
                  ) {
                    return yield* Effect.fail(stale());
                  }
                  yield* invalidate;
                  yield* captured.tab.activateCoordinates(action.x, action.y);
                  return;
                }
                const ref = captured.refs.get(action.target);
                if (ref === undefined) {
                  return yield* Effect.fail(stale());
                }
                yield* input.browser.currentRef(ref);
                yield* invalidate;
                yield* captured.tab.perform(
                  action.type === "activate"
                    ? { ref, type: "click" }
                    : { ...action, ref }
                );
              })
            )
          )
          .pipe(Effect.mapError(runtimeError)),
      invalidate: () => lock.withPermits(1)(invalidate),
      observe: () =>
        lock
          .withPermits(1)(
            live(
              Effect.gen(function* observeRuntime() {
                const tab = yield* input.browser.active();
                const snapshot = yield* tab.snapshot();
                const screenshot = yield* tab.screenshot(true, [], []);
                const id = randomUUID();
                const refs = new Map(
                  snapshot.nodes.map((node) => [node.ref, node.ref])
                );
                atoms.set(
                  observation,
                  Option.some({
                    epoch: atoms.get(state).epoch,
                    id,
                    image: screenshot.image,
                    refs,
                    signature: signature(snapshot),
                    tab,
                  })
                );
                const { url: _url, ...visual } = screenshot;
                return {
                  id,
                  nodes: snapshot.nodes.map((node) => ({
                    name: node.name,
                    role: node.role,
                    target: node.ref,
                  })),
                  platform: "web" as const,
                  screenshot: visual,
                };
              })
            )
          )
          .pipe(Effect.mapError(runtimeError)),
      platform: "web",
    };
  });

export const makeBrowserRuntimeFactory = (
  browser: CreateBrowserService,
  factory: AgentBrowserFactory
): BrowserRuntimeFactoryService => ({
  capabilities: browserCapabilities,
  platform: "web",
  start: (input) =>
    Effect.gen(function* startBrowserRuntime() {
      const resources = yield* Scope.make("sequential");
      yield* Scope.addFinalizer(input.scope, Scope.close(resources, Exit.void));
      const sessionId = yield* Scope.provide(resources)(
        Effect.acquireRelease(
          browser.create(
            input.name,
            input.viewport,
            input.navigationPolicy,
            input.run
          ),
          (id) => browser.close(id).pipe(Effect.ignore)
        )
      );
      const agentBrowser = yield* factory({
        browser,
        now: input.now,
        scope: resources,
        sessionId,
      });
      return yield* adaptBrowserRuntime({
        browser: agentBrowser,
        browserSessionId: sessionId,
        close: Scope.close(resources, Exit.void),
        scope: input.scope,
      });
    }),
});

export const validateRuntimeStartup = (
  factory: Pick<PlatformRuntimeService, "platform" | "capabilities">,
  saved: SavedPlatformRequirements
) =>
  validatePlatformRequirements(saved, factory.platform, factory.capabilities);
