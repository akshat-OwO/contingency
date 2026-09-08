import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Scope } from "effect";
import { vi } from "vitest";

import { NavigationCoordinator } from "../../src/services/agent-navigation-boundary.ts";

it.effect(
  "refuses malformed paused requests and keeps processing later messages",
  () =>
    Effect.gen(function* malformedNavigationMessages() {
      const scope = yield* Scope.make();
      // Only the event surface is needed: sends are intercepted below.
      const root = { on: vi.fn(), send: vi.fn() };
      const coordinator = new NavigationCoordinator(root, scope);
      const send = vi.spyOn(coordinator, "send").mockReturnValue(Effect.void);
      yield* coordinator.handleMessage("session", "not JSON");
      yield* coordinator.handleMessage(
        "session",
        JSON.stringify({ method: "Unknown.event" })
      );
      yield* coordinator.handleMessage(
        "session",
        JSON.stringify({
          method: "Fetch.requestPaused",
          params: {
            frameId: "frame",
            request: { url: 42 },
            requestId: "malformed",
          },
        })
      );
      expect(send).toHaveBeenCalledWith("session", "Fetch.failRequest", {
        errorReason: "BlockedByClient",
        requestId: "malformed",
      });
      yield* coordinator.handleMessage(
        "session",
        JSON.stringify({
          method: "Fetch.requestPaused",
          params: {
            frameId: "frame",
            request: { url: "https://example.com" },
            requestId: "valid",
          },
        })
      );
      expect(send).toHaveBeenCalledWith("session", "Fetch.continueRequest", {
        requestId: "valid",
      });
      const done = Deferred.makeUnsafe<null, Error>();
      coordinator.commands.set(1, { done, sessionId: "session" });
      yield* coordinator.handleMessage("session", JSON.stringify({ id: 1 }));
      expect(yield* Deferred.await(done)).toBeNull();
    })
);

it.effect("refuses only top-level documents outside the Domain Scope", () =>
  Effect.gen(function* subframeDocumentsStayOutsideTheBoundary() {
    const scope = yield* Scope.make();
    const root = { on: vi.fn(), send: vi.fn() };
    const coordinator = new NavigationCoordinator(root, scope);
    const send = vi.spyOn(coordinator, "send").mockReturnValue(Effect.void);
    const refuse = vi.fn(() => Effect.void);
    coordinator.policies.set("context", {
      allows: (url) => url.startsWith("https://shop.example"),
      refuse,
    });
    coordinator.sessions.set("session", {
      contextId: "context",
      sessionId: "session",
      targetId: "page",
    });
    // A page target's main frame id is the target id itself.
    yield* coordinator.handleRequest("session", {
      frameId: "page",
      request: { url: "https://ads.example/banner" },
      requestId: "top-level",
    });
    expect(refuse).toHaveBeenCalledWith("https://ads.example/banner");
    expect(send).toHaveBeenCalledWith("session", "Fetch.failRequest", {
      errorReason: "BlockedByClient",
      requestId: "top-level",
    });
    refuse.mockClear();
    yield* coordinator.handleRequest("session", {
      frameId: "subframe",
      request: { url: "https://ads.example/banner" },
      requestId: "subframe",
    });
    expect(refuse).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("session", "Fetch.continueRequest", {
      requestId: "subframe",
    });
    yield* coordinator.handleRequest("session", {
      frameId: "page",
      request: { url: "https://shop.example/cart" },
      requestId: "in-scope",
    });
    expect(refuse).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("session", "Fetch.continueRequest", {
      requestId: "in-scope",
    });
  })
);
