import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Scope } from "effect";
import type { CDPSession } from "playwright-core";
import { vi } from "vitest";

import { NavigationCoordinator } from "../../src/services/agent-navigation-boundary.ts";

it.effect(
  "refuses malformed paused requests and keeps processing later messages",
  () =>
    Effect.gen(function* malformedNavigationMessages() {
      const scope = yield* Scope.make();
      // Only the event surface is needed: sends are intercepted below.
      const root = { on: vi.fn() } as unknown as CDPSession;
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
          params: { request: { url: 42 }, requestId: "malformed" },
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
