import { UserAgentProfileId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";

import { makeChromiumAgentBrowser } from "../../src/services/chromium-agent-browser.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import type { CreateBrowserService } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeBrowserRuntimeFactory } from "../../src/services/platform-runtime.ts";
import { CONTRACT_URL } from "../helpers/agent-browser-contract.ts";

const makeRuntime = () =>
  Effect.gen(function* startRuntime() {
    const browser = yield* CreateBrowser;
    const viewport = { deviceScaleFactor: 1, height: 480, width: 640 };
    const runtime = yield* makeBrowserRuntimeFactory(
      browser,
      makeChromiumAgentBrowser
    ).start({
      name: "create-platform-contract",
      navigationPolicy: false,
      now: () => new Date(),
      run: false,
      scope: yield* Scope.Scope,
      viewport,
    });
    yield* browser.open(runtime.browserSessionId, CONTRACT_URL, {
      permissions: [],
      userAgentProfile: UserAgentProfileId.make("chrome-mac"),
      viewport,
    });
    return runtime;
  });

const provide = <A, E>(
  test: Effect.Effect<A, E, Scope.Scope | CreateBrowserService>
) =>
  test.pipe(
    Effect.provide(CreateBrowserLive),
    Effect.provide(NodeServices.layer)
  );

it.live(
  "browser runtime dispatches semantic input and refuses changed or closed observations",
  () =>
    provide(
      Effect.gen(function* semanticRuntime() {
        const runtime = yield* makeRuntime();
        const before = yield* runtime.observe();
        const message = before.nodes.find((node) => node.name === "Message");
        expect(message).toBeDefined();
        if (message === undefined) {
          return;
        }
        yield* runtime.dispatch(before.id, {
          target: message.target,
          text: "runtime text",
          type: "fill",
        });
        expect(
          (yield* Effect.flip(
            runtime.dispatch(before.id, {
              target: message.target,
              text: "stale",
              type: "fill",
            })
          )).code
        ).toBe("observation_stale");
        const tab = yield* runtime.browser.active();
        expect(
          (yield* tab.snapshot()).nodes.find((node) => node.name === "Message")
            ?.value
        ).toBe("runtime text");
        const next = yield* runtime.observe();
        yield* runtime.close();
        expect(
          (yield* Effect.flip(
            runtime.dispatch(next.id, { type: "coordinate", x: 20, y: 90 })
          )).code
        ).toBe("observation_stale");
        expect((yield* Effect.flip(tab.snapshot())).code).toBe(
          "agent_element_stale"
        );
      })
    )
);

it.live(
  "coordinate fallback uses the captured screen and rejects visual changes before input",
  () =>
    provide(
      Effect.gen(function* coordinateRuntime() {
        const runtime = yield* makeRuntime();
        const before = yield* runtime.observe();
        yield* runtime.dispatch(before.id, {
          type: "coordinate",
          x: 20,
          y: 90,
        });
        const tab = yield* runtime.browser.active();
        expect(
          (yield* tab.snapshot()).nodes.some((node) => node.name === "Saved")
        ).toBe(true);
        const observed = yield* runtime.observe();
        const browser = yield* CreateBrowser;
        const page = yield* browser.activePage(runtime.browserSessionId);
        yield* Effect.promise(() =>
          page.evaluate("document.body.style.background = 'red'")
        );
        expect(
          (yield* Effect.flip(
            runtime.dispatch(observed.id, { type: "coordinate", x: 20, y: 130 })
          )).code
        ).toBe("observation_stale");
        expect(
          (yield* tab.snapshot()).nodes.some((node) => node.name === "Message")
        ).toBe(true);
      })
    )
);
