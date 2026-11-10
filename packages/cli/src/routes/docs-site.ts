import path from "node:path";

import { Effect, FileSystem, Layer } from "effect";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";

import { DOCS_HOME_PAGE, DOCS_SITE_PATH } from "../services/doc-topics.ts";

/**
 * The built `/docs` site ships beside the bundle as `dist/docs-site`; a
 * source checkout serves the docs app's own build output.
 */
export const resolveDocsSiteRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "docs-site")
    : path.resolve(moduleDirectory, "../../../../apps/docs/dist");

const docsSiteRoot = resolveDocsSiteRoot(import.meta.dirname);

/** `/docs` itself has no page; it opens the guide every reader starts with. */
export const DOCS_HOME_URL = `${DOCS_SITE_PATH}/${DOCS_HOME_PAGE}`;

const UNBUILT =
  "The docs site is not built. Run `vp run --filter @contingency/docs build` from the repository.";

/**
 * Serves the static Blume build under `/docs` on every Contingency web
 * server, with the site's own 404 page for an unknown page.
 */
export const makeDocsSiteRoutes = (root: string = docsSiteRoot) =>
  Layer.effectDiscard(
    Effect.gen(function* mountDocsSite() {
      const router = yield* HttpRouter.HttpRouter;
      const fileSystem = yield* FileSystem.FileSystem;
      const serveStatic = yield* HttpStaticServer.make({ root });
      const notFound = fileSystem
        .readFileString(path.join(root, "404.html"))
        .pipe(
          Effect.map((page) =>
            HttpServerResponse.text(page, {
              contentType: "text/html; charset=utf-8",
              status: 404,
            })
          ),
          Effect.orElseSucceed(() =>
            HttpServerResponse.text(UNBUILT, { status: 404 })
          )
        );
      const page = serveStatic.pipe(
        Effect.catchIf(
          (error) =>
            HttpServerError.isHttpServerError(error) &&
            error.reason._tag === "RouteNotFound",
          () => notFound
        )
      );
      // A `/*` route also matches the bare prefix; the router hands it `/`.
      yield* router.prefixed(DOCS_SITE_PATH).add(
        "GET",
        "/*",
        HttpServerRequest.HttpServerRequest.use((request) =>
          (request.url.split("?")[0] ?? "") === "/"
            ? Effect.succeed(HttpServerResponse.redirect(DOCS_HOME_URL))
            : page
        )
      );
    })
  );
