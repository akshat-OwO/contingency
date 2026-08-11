import { Config, Console, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { AgentBrowser } from "../services/agent-browser";
import { makeHttpServerLayer } from "../services/http-server";
import { UiInterface } from "../services/ui-interface";
import { resolveAllowedOrigins, resolveBrowserUrl } from "../services/web-url";

export const webCommand = Command.make(
  "web",
  {
    noBrowser: Flag.boolean("no-browser").pipe(Flag.withDefault(false)),
  },
  Effect.fnUntraced(function* runWeb({ noBrowser }) {
    const isProduction = process.env.NODE_ENV === "production";
    const agentBrowser = yield* AgentBrowser;
    const uiInterface = yield* UiInterface;
    const config = yield* Config.all({
      devUrl: Config.string("DEV_URL").pipe(
        Config.withDefault("http://localhost:5173")
      ),
      host: Config.string("HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.number("PORT").pipe(Config.withDefault(7777)),
      publicUrl: Config.string("PUBLIC_URL").pipe(Config.option),
    }).pipe(Config.nested("CONTINGENCY_WEB"));
    const browserUrl = yield* resolveBrowserUrl({
      ...config,
      isProduction,
    });
    yield* agentBrowser.init();

    return yield* Effect.scoped(
      Effect.gen(function* serveWebInterface() {
        yield* Layer.build(
          makeHttpServerLayer({
            allowedOrigins: resolveAllowedOrigins(browserUrl),
            host: config.host,
            port: config.port,
            serveWebUi: isProduction,
          })
        );

        if (noBrowser) {
          yield* Console.log(`Contingency UI available at ${browserUrl}`);
        } else {
          yield* Console.log(`Opening Contingency UI at ${browserUrl}...`);
          yield* uiInterface.open(browserUrl.href);
        }

        return yield* Effect.never;
      })
    );
  })
).pipe(Command.withDescription("Open the Contingency web interface."));
