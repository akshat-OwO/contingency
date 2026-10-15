import { AgentSessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";

import { makeAndroidStreamRoutes } from "../../src/routes/android-stream.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";

it.effect(
  "serves only authenticated selected-session frames and refuses hub control routes",
  () =>
    Effect.scoped(
      Effect.gen(function* routeAllowlist() {
        const origin = "http://127.0.0.1:7777";
        const service = Layer.mock(AndroidWorkspace, {
          stream: (id) =>
            Effect.succeed(
              id === AgentSessionId.make("agent-selected")
                ? {
                    access: {
                      path: "/android/stream/agent-selected",
                      token: "fixture-token",
                    },
                    authorized: (token) => token === "fixture-token",
                    frames: Stream.make(Buffer.from("display-only\n")),
                  }
                : null
            ),
        });
        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              makeAndroidStreamRoutes(new Set([origin])).pipe(
                Layer.provide(service)
              ),
              { disableLogger: true }
            )
          ),
          (owned) => Effect.promise(() => owned.dispose())
        );
        const request = (path: string, options?: RequestInit) =>
          Effect.promise(() =>
            web.handler(new Request(`${origin}${path}`, options))
          );
        const headers = {
          authorization: "Bearer fixture-token",
          host: "127.0.0.1:7777",
          origin,
        };
        expect(
          (yield* request("/android/stream/agent-selected", {
            headers: { host: headers.host, origin },
          })).status
        ).toBe(401);
        expect(
          (yield* request("/android/stream/agent-selected", {
            headers: { ...headers, authorization: "Bearer wrong" },
          })).status
        ).toBe(401);
        expect(
          (yield* request("/android/stream/agent-other", { headers })).status
        ).toBe(401);
        expect(
          (yield* request("/android/stream/agent-selected?device=other", {
            headers,
          })).status
        ).toBe(404);
        expect(
          (yield* request("/android/stream/agent-selected", {
            headers: { ...headers, origin: "https://evil.example" },
          })).status
        ).toBe(403);
        expect(
          (yield* request("/android/stream/agent-selected", {
            headers: { ...headers, host: "evil.example" },
          })).status
        ).toBe(403);
        for (const path of [
          "input",
          "install",
          "recording",
          "replay",
          "api/devices/select",
        ]) {
          expect(
            (yield* request(`/android/stream/${path}`, {
              headers,
              method: "POST",
            })).status
          ).toBe(404);
        }
        const response = yield* request("/android/stream/agent-selected", {
          headers,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.text())).toBe(
          "display-only\n"
        );
      })
    )
);
