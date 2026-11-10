import { Console, Context, Effect, Layer, Option, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { HttpRouter, HttpServer } from "effect/http";

import { makeDocsSiteRoutes } from "../routes/docs-site.ts";
import { DOC_SITE_PAGES, DOCS_SITE_PATH } from "../services/doc-topics.ts";
import { defaultCatalogRoot } from "../services/flow-catalog.ts";
import { makeNodeServerLayer } from "../services/http-server.ts";
import { loadSettings } from "../services/settings.ts";
import { UiInterface } from "../services/ui-interface.ts";
import { isListenAddressInUse } from "./mcp.ts";
import { webConfig } from "./web.ts";

/** The first line of the site's `llms.txt`, which names the site's title. */
const SITE_SIGNATURE = "# Contingency";

const hostForUrl = (host: string): string =>
  host.includes(":") ? `[${host}]` : host;

/**
 * Whether a Contingency docs site already answers at `origin`, as a running
 * `contingency web` does. Anything else on the port is not reused.
 */
export const servesContingencyDocs = (origin: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(`${origin}${DOCS_SITE_PATH}/llms.txt`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.text();
    return body.startsWith(SITE_SIGNATURE);
  }).pipe(Effect.orElseSucceed(() => false));

/** A docs-only server on `port`, or on an available port when it is taken. */
const serveDocs = (host: string, port: number) =>
  Effect.gen(function* bindDocsServer() {
    const bound = yield* Layer.build(makeNodeServerLayer({ host, port })).pipe(
      Effect.result
    );
    if (Result.isFailure(bound) && !isListenAddressInUse(bound.failure)) {
      return yield* Effect.fail(bound.failure);
    }
    const server = Result.isSuccess(bound)
      ? bound.success
      : yield* Layer.build(makeNodeServerLayer({ host, port: 0 }));
    yield* Layer.build(
      HttpRouter.serve(makeDocsSiteRoutes()).pipe(
        Layer.provide(Layer.succeedContext(server))
      )
    );
    const { address } = Context.get(server, HttpServer.HttpServer);
    if (address._tag === "UnixPathAddress") {
      return yield* Effect.die(
        new Error("The docs server must listen on TCP.")
      );
    }
    return `http://${hostForUrl(host)}:${address.port}`;
  });

export const docsCommand = Command.make(
  "docs",
  {
    noBrowser: Flag.Boolean("no-browser").pipe(
      Flag.withDescription("Print the docs URL instead of opening a browser."),
      Flag.withDefault(false)
    ),
    topic: Argument.Literals("topic", DOC_SITE_PAGES).pipe(
      Argument.withDescription(
        "The page to open, such as `teach` or `settings`. Defaults to Getting started."
      ),
      Argument.optional
    ),
  },
  Effect.fnUntraced(function* runDocs({ noBrowser, topic }) {
    const settings = yield* loadSettings({
      catalogRoot: defaultCatalogRoot(),
      env: process.env,
    });
    for (const warning of settings.warnings) {
      yield* Console.error(warning);
    }
    const config = yield* webConfig.parse(settings.provider);
    const page = Option.getOrElse(topic, () => "getting-started");
    const show = Effect.fnUntraced(function* show(origin: string) {
      const url = `${origin}${DOCS_SITE_PATH}/${page}`;
      if (noBrowser) {
        yield* Console.log(`Contingency docs available at ${url}`);
        return;
      }
      yield* Console.log(`Opening Contingency docs at ${url}...`);
      const uiInterface = yield* UiInterface;
      yield* uiInterface.open(url);
    });

    const running = `http://${hostForUrl(config.host)}:${config.port}`;
    if (yield* servesContingencyDocs(running)) {
      return yield* show(running);
    }
    return yield* Effect.scoped(
      Effect.gen(function* serveOwnDocs() {
        const origin = yield* serveDocs(config.host, config.port);
        yield* show(origin);
        yield* Console.log("Press Ctrl-C to stop the docs server.");
        return yield* Effect.never;
      })
    );
  })
).pipe(
  Command.withDescription(
    "Open the Contingency docs. Reuses a running Workspace on the configured port, or serves the docs until you press Ctrl-C."
  )
);
