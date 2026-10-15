import { AgentElementRef, SessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";

import { adaptBrowserRuntime } from "../../src/services/platform-runtime.ts";
import {
  CONTRACT_URL,
  CONTRACT_NEXT_URL,
} from "../helpers/agent-browser-contract.ts";
import { makeInMemoryAgentBrowser } from "../helpers/in-memory-agent-browser.ts";

const makeRuntime = () =>
  Effect.gen(function* makeTestRuntime() {
    const original = yield* makeInMemoryAgentBrowser({ url: CONTRACT_URL });
    const tab = yield* original.active();
    const rendered = {
      ...tab,
      screenshot: () =>
        Effect.succeed({
          capturedAt: "2026-10-12",
          encoding: "base64" as const,
          format: "png" as const,
          image: "pixels",
          url: CONTRACT_URL,
        }),
    };
    const runtime = yield* adaptBrowserRuntime({
      browser: { ...original, active: () => Effect.succeed(rendered) },
      browserSessionId: SessionId.make("create-runtime-test"),
      close: Effect.void,
      scope: yield* Scope.Scope,
    });
    return { original, runtime };
  });

it.effect(
  "invalidates shared and retained browser observations before input",
  () =>
    Effect.gen(function* invalidObservation() {
      const { runtime } = yield* makeRuntime();
      const tab = yield* runtime.browser.active();
      const snapshot = yield* tab.snapshot();
      const save = snapshot.nodes.find((node) => node.name === "Save");
      expect(save).toBeDefined();
      if (save === undefined) {
        return;
      }
      const captured = yield* tab.beginObservation({
        ref: save.ref,
        type: "click",
      });
      const observed = yield* runtime.observe();
      yield* runtime.invalidate();
      expect(
        (yield* Effect.flip(
          runtime.dispatch(observed.id, { target: save.ref, type: "activate" })
        )).code
      ).toBe("observation_stale");
      expect((yield* Effect.flip(captured.observe())).code).toBe(
        "agent_element_stale"
      );
      expect(
        (yield* tab.snapshot()).nodes.some((node) => node.name === "Saved")
      ).toBe(false);
    })
);

it.effect(
  "closing refuses actions through retained tabs and observation tokens",
  () =>
    Effect.gen(function* closeObservation() {
      const { runtime } = yield* makeRuntime();
      const tab = yield* runtime.browser.active();
      const observed = yield* runtime.observe();
      yield* runtime.close();
      yield* runtime.close();
      expect(
        (yield* Effect.flip(
          runtime.dispatch(observed.id, { type: "coordinate", x: 20, y: 20 })
        )).code
      ).toBe("observation_stale");
      expect(
        (yield* Effect.flip(
          tab.perform({ type: "navigate", url: CONTRACT_NEXT_URL })
        )).code
      ).toBe("agent_element_stale");
      expect((yield* Effect.flip(tab.snapshot())).code).toBe(
        "agent_element_stale"
      );
    })
);

it.effect("preserves browser stale references after a document change", () =>
  Effect.gen(function* staleDocument() {
    const { runtime } = yield* makeRuntime();
    const tab = yield* runtime.browser.active();
    const observed = yield* runtime.observe();
    const save = observed.nodes.find((node) => node.name === "Save");
    expect(save).toBeDefined();
    if (save === undefined) {
      return;
    }
    yield* tab.perform({ type: "navigate", url: CONTRACT_NEXT_URL });
    expect(
      (yield* Effect.flip(
        runtime.dispatch(observed.id, { target: save.target, type: "activate" })
      )).code
    ).toBe("observation_stale");
    expect(
      (yield* Effect.flip(
        tab.perform({ ref: AgentElementRef.make(save.target), type: "click" })
      )).code
    ).toBe("agent_element_stale");
  })
);
