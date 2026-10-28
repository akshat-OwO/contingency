import { AgentSessionId } from "@contingency/protocol";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { IosWorkspace } from "../services/ios-workspace.ts";
import {
  isAllowedHost,
  isAllowedWebSocketOrigin,
} from "../services/web-url.ts";

/** Closed route allowlist: only authenticated GET of the session's frames. */
export const makeIosStreamRoutes = (allowedOrigins: ReadonlySet<string>) =>
  Layer.unwrap(
    Effect.gen(function* streamRoutes() {
      const service = yield* Effect.serviceOption(IosWorkspace);
      return HttpRouter.add(
        "*",
        "/ios/stream/*",
        Effect.gen(function* proxyIosFrames() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            !isAllowedHost(request.headers.host, allowedOrigins) ||
            (request.headers.origin !== undefined &&
              !isAllowedWebSocketOrigin(
                request.headers.origin,
                allowedOrigins
              )) ||
            request.headers["sec-fetch-site"] === "cross-site"
          ) {
            return HttpServerResponse.empty({ status: 403 });
          }
          const match = /^\/ios\/stream\/(?<session>[^/?]+)$/u.exec(
            request.url
          );
          if (
            request.method !== "GET" ||
            request.headers.upgrade !== undefined ||
            !match ||
            Option.isNone(service) ||
            !Schema.is(AgentSessionId)(match.groups?.session)
          ) {
            return HttpServerResponse.empty({ status: 404 });
          }
          const stream = yield* service.value.stream(
            AgentSessionId.make(match.groups?.session ?? "")
          );
          const { authorization } = request.headers;
          if (
            !stream ||
            !stream.authorized(
              authorization?.startsWith("Bearer ")
                ? authorization.slice(7)
                : undefined
            )
          ) {
            return HttpServerResponse.empty({ status: 401 });
          }
          return HttpServerResponse.stream(stream.frames, {
            contentType: "application/x-ndjson",
            headers: {
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        })
      );
    })
  );
