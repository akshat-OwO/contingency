import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect, Option, Scope } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { Page } from "playwright-core";

import type {
  AgentBrowserFactory,
  AgentBrowserTab,
  AgentNavigationPolicy,
} from "./agent-browser-contract.ts";
import {
  actionTarget,
  beginActionObservation,
  captureAgentScreenshot,
  makeAgentElementRegistry,
  observeAfterAction,
  performAgentAction,
  performPrivateVariableInput,
  settledSnapshot,
  snapshotAfterAction,
} from "./agent-browser.ts";
import { installAgentNavigationBoundary } from "./agent-navigation-boundary.ts";

/** Chromium pairs each active tab with this session's refs and owns their lifetime. */
export const makeChromiumAgentBrowser: AgentBrowserFactory = ({
  browser,
  sessionId,
  scope,
  now,
}) =>
  Effect.gen(function* makeChromiumBrowser() {
    const registry = makeAgentElementRegistry(now);
    yield* Scope.addFinalizer(scope, registry.clear());
    const atoms = AtomRegistry.make();
    const navigationPolicy = Atom.make<Option.Option<AgentNavigationPolicy>>(
      Option.none()
    ).pipe(Atom.keepAlive);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => atoms.dispose())
    );
    const tabs = new WeakMap<Page, AgentBrowserTab>();
    return {
      active: () =>
        browser.activePage(sessionId).pipe(
          Effect.map((page) => {
            const existing = tabs.get(page);
            if (existing !== undefined) {
              return existing;
            }
            const tab: AgentBrowserTab = {
              beginObservation: (action) =>
                actionTarget(registry, action).pipe(
                  Effect.flatMap((target) =>
                    beginActionObservation(page, target)
                  ),
                  Effect.map((observation) => ({
                    observe: () =>
                      observeAfterAction(page, registry, observation),
                  }))
                ),
              enterPrivate: (target, value, pointer) =>
                performPrivateVariableInput(page, target, value, pointer),
              inspect: (x, y) => registry.inspect(page, x, y),
              perform: (action, pointer) =>
                Effect.gen(function* performBrowserAction() {
                  const policy = Option.getOrUndefined(
                    atoms.get(navigationPolicy)
                  );
                  if (
                    action.type === "navigate" &&
                    policy !== undefined &&
                    !policy.allows(action.url)
                  ) {
                    yield* policy.refuse(action.url).pipe(Effect.ignore);
                    return yield* Effect.fail(
                      makeBrowserRpcError(
                        "agent_browser_failed",
                        "Navigation refused by Domain Scope."
                      )
                    );
                  }
                  yield* performAgentAction(page, registry, action, pointer);
                }),
              screenshot: (maskSensitive, privateValues, privateSelectors) =>
                captureAgentScreenshot(
                  page,
                  now,
                  maskSensitive,
                  privateValues,
                  privateSelectors
                ),
              settledSnapshot: (options) =>
                settledSnapshot(page, registry, options),
              snapshot: (options) => registry.snapshot(page, options),
              snapshotAfter: (urlBefore) =>
                snapshotAfterAction(page, registry, urlBefore),
              url: () => page.url(),
            };
            tabs.set(page, tab);
            return tab;
          })
        ),
      currentRef: registry.currentRef,
      describe: registry.describe,
      enforceNavigation: (policy) =>
        Effect.gen(function* enforceNavigation() {
          const target = yield* browser.activeTarget(sessionId);
          target.context.once("close", policy.dispose);
          yield* installAgentNavigationBoundary(
            target.context,
            target.page,
            policy
          );
          atoms.set(navigationPolicy, Option.some(policy));
        }),
      focusedRef: registry.focusedRef,
      hasFocus: registry.hasFocus,
      isSensitive: registry.isSensitive,
      pointRef: registry.pointRef,
      privateSelector: registry.privateSelector,
      sameElement: registry.sameElement,
      valueDigest: registry.valueDigest,
    };
  });
