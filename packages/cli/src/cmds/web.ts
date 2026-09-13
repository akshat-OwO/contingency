import path from "node:path";

import { Config, Console, Effect, FileSystem, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  defaultCatalogRoot,
  makeAgentFlowCatalogLayer,
} from "../services/agent-flow-catalog.ts";
import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { makeHttpServerLayer } from "../services/http-server.ts";
import { makeTeachingRecordingStoreLayer } from "../services/teaching-recording-store.ts";
import { UiInterface } from "../services/ui-interface.ts";
import {
  resolveAllowedOrigins,
  resolveBrowserUrl,
} from "../services/web-url.ts";

export const webCommand = Command.make(
  "web",
  { noBrowser: Flag.boolean("no-browser").pipe(Flag.withDefault(false)) },
  Effect.fnUntraced(function* runWeb({ noBrowser }) {
    const isProduction = process.env.NODE_ENV === "production";
    const uiInterface = yield* UiInterface;

    const config = yield* Config.all({
      devUrl: Config.string("DEV_URL").pipe(
        Config.withDefault("http://localhost:5173")
      ),
      host: Config.string("HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.number("PORT").pipe(Config.withDefault(7777)),
      publicUrl: Config.string("PUBLIC_URL").pipe(Config.option),
    }).pipe(Config.nested("CONTINGENCY_WEB"));
    const browserUrl = yield* resolveBrowserUrl({ ...config, isProduction });

    return yield* Effect.scoped(
      Effect.gen(function* serveWebInterface() {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
        );
        let selectedCatalogRoot = defaultCatalogRoot();
        const catalog = Layer.succeedContext(
          yield* Layer.build(
            makeAgentFlowCatalogLayer({
              onSelect: (root) => {
                selectedCatalogRoot = root;
              },
              root: selectedCatalogRoot,
            })
          )
        );
        const runStore = Layer.succeedContext(
          yield* Layer.build(
            makeAgentRunStoreLayer({ root: () => selectedCatalogRoot })
          )
        );
        const teachingRecordingStore = Layer.succeedContext(
          yield* Layer.build(
            makeTeachingRecordingStoreLayer({
              root: () => selectedCatalogRoot,
            })
          )
        );
        const agentSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              allowedActivity: "teaching",
              baseUrl: browserUrl.origin,
              resourceDirectory: ownerMarker,
              traceDirectory: () => path.join(selectedCatalogRoot, "teaching"),
            }).pipe(Layer.provide(teachingRecordingStore))
          )
        );
        yield* Effect.addFinalizer(() =>
          fileSystem
            .remove(ownerMarker, { recursive: true })
            .pipe(Effect.ignore)
        );
        yield* Layer.build(
          makeHttpServerLayer({
            agentFlowCatalog: catalog,
            agentRunStore: runStore,
            agentSession,
            allowedOrigins: resolveAllowedOrigins(browserUrl),
            host: config.host,
            port: config.port,
            serveWebUi: isProduction,
          }).pipe(Layer.provide(agentSession))
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
).pipe(
  Command.withDescription(
    "Open the Contingency Workspace with local Teaching sessions and saved flows."
  )
);
