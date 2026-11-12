import {
  TargetAppBuildRefusal,
  targetAppBuildPaths,
  UploadedAndroidApp,
  UploadedIosApp,
} from "@contingency/protocol";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { TargetAppBuilds } from "../services/target-app-builds.ts";
import type {
  TargetAppBuildError,
  TargetAppBuildsService,
} from "../services/target-app-builds.ts";
import {
  isAllowedHost,
  isAllowedWebSocketOrigin,
} from "../services/web-url.ts";

const refusal = HttpServerResponse.schemaJson(TargetAppBuildRefusal);
const refuse = ({ code, message }: TargetAppBuildError) =>
  refusal({ code, message }, { status: 422 }).pipe(Effect.orDie);

const respondIos = (uploaded: UploadedIosApp) =>
  HttpServerResponse.schemaJson(UploadedIosApp)(uploaded).pipe(Effect.orDie);
const respondAndroid = (uploaded: UploadedAndroidApp) =>
  HttpServerResponse.schemaJson(UploadedAndroidApp)(uploaded).pipe(
    Effect.orDie
  );
/** The chosen file's name, sent URI-encoded since headers are ASCII. */
const fileName = (header: string | undefined) => {
  try {
    return decodeURIComponent(header ?? "");
  } catch {
    return "";
  }
};

/**
 * The Workspace uploads a Target App build here: a `.app` folder as framed
 * entries, or an `.apk` as its raw bytes. Only a same-origin POST from the
 * Workspace is accepted, so another site cannot write builds to this disk.
 */
export const makeTargetAppBuildRoutes = (allowedOrigins: ReadonlySet<string>) =>
  Layer.unwrap(
    Effect.gen(function* buildRoutes() {
      const builds = yield* Effect.serviceOption(TargetAppBuilds);
      const guarded = (
        receive: (
          service: TargetAppBuildsService,
          request: HttpServerRequest.HttpServerRequest
        ) => Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          TargetAppBuildError
        >
      ) =>
        Effect.gen(function* upload() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            !isAllowedHost(request.headers.host, allowedOrigins) ||
            !isAllowedWebSocketOrigin(request.headers.origin, allowedOrigins) ||
            request.headers["sec-fetch-site"] === "cross-site"
          ) {
            return HttpServerResponse.empty({ status: 403 });
          }
          if (Option.isNone(builds)) {
            return HttpServerResponse.empty({ status: 404 });
          }
          return yield* receive(builds.value, request).pipe(
            Effect.catch(refuse)
          );
        });
      return Layer.mergeAll(
        HttpRouter.add(
          "POST",
          targetAppBuildPaths.ios,
          guarded((service, request) =>
            service
              .receiveIos(NodeHttpServerRequest.toIncomingMessage(request))
              .pipe(Effect.flatMap(respondIos))
          )
        ),
        HttpRouter.add(
          "POST",
          targetAppBuildPaths.android,
          guarded((service, request) =>
            service
              .receiveAndroid(
                NodeHttpServerRequest.toIncomingMessage(request),
                fileName(request.headers["x-target-app-name"])
              )
              .pipe(Effect.flatMap(respondAndroid))
          )
        )
      );
    })
  );
