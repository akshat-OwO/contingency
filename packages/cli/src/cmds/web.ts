import path from "node:path";

import { Config, Console, Effect, FileSystem, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { defaultCatalogRoot } from "../services/flow-skill-catalog.ts";
import { makeHttpServerLayer } from "../services/http-server.ts";
import { RunVideoRendererLive } from "../services/run-video-renderer.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../services/teaching-recording-store.ts";
import { UiInterface } from "../services/ui-interface.ts";
import {
  resolveAllowedOrigins,
  resolveBrowserUrl,
} from "../services/web-url.ts";

export const webCommand = Command.make(
  "web",
  { noBrowser: Flag.Boolean("no-browser").pipe(Flag.withDefault(false)) },
  Effect.fnUntraced(function* runWeb({ noBrowser }) {
    const isProduction = process.env.NODE_ENV === "production";
    const uiInterface = yield* UiInterface;

    const config = yield* Config.all({
      devUrl: Config.String("DEV_URL").pipe(
        Config.withDefault("http://localhost:5173")
      ),
      host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.Number("PORT").pipe(Config.withDefault(7777)),
      publicUrl: Config.String("PUBLIC_URL").pipe(Config.option),
    }).pipe(Config.nested("CONTINGENCY_WEB"));
    const browserUrl = yield* resolveBrowserUrl({ ...config, isProduction });

    return yield* Effect.scoped(
      Effect.gen(function* serveWebInterface() {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
        );
        // The Workspace process serves one Catalog Root: it holds Teaching
        // Recordings and persisted Runs, and selecting a different root is an
        // MCP-process concern.
        const selectedCatalogRoot = defaultCatalogRoot();
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
        // A Teaching-only process ends no Runs, but it serves their videos
        // and condenses any footage a Run process left unfinished.
        const runVideoRenderer = Layer.succeedContext(
          yield* Layer.build(RunVideoRendererLive)
        );
        const agentSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              allowedActivity: "teaching",
              baseUrl: browserUrl.origin,
              resourceDirectory: ownerMarker,
              traceDirectory: () =>
                path.join(selectedCatalogRoot, TEACHING_RECORDINGS_DIRECTORY),
            }).pipe(
              Layer.provide(Layer.merge(runStore, teachingRecordingStore))
            )
          )
        );
        yield* Effect.addFinalizer(() =>
          fileSystem
            .remove(ownerMarker, { recursive: true })
            .pipe(Effect.ignore)
        );
        yield* Layer.build(
          makeHttpServerLayer({
            agentRunStore: runStore,
            agentSession,
            allowedOrigins: resolveAllowedOrigins(browserUrl),
            host: config.host,
            port: config.port,
            runVideoRenderer,
            serveWebUi: isProduction,
            teachingRecordingStore,
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
