import { homedir } from "node:os";
import path from "node:path";

import { Config, Console, Effect, FileSystem, Layer } from "effect";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { makeAgentRunStoreLayer } from "../services/agent-run-store.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../services/agent-session-resources.ts";
import { makeAgentSessionLayer } from "../services/agent-session.ts";
import { makeAndroidWorkspaceLayer } from "../services/android-workspace.ts";
import {
  defaultGlobalCatalogRoot,
  makeCatalogBrowserLayer,
} from "../services/catalog-browser.ts";
import { DeviceVideoRendererLive } from "../services/device-video-renderer.ts";
import { DOCS_SITE_PATH } from "../services/doc-topics.ts";
import {
  defaultCatalogRoot,
  makeFlowCatalogLayer,
} from "../services/flow-catalog.ts";
import { makeHttpServerLayer } from "../services/http-server.ts";
import { makeIosWorkspaceLayer } from "../services/ios-workspace.ts";
import { RunVideoRendererLive } from "../services/run-video-renderer.ts";
import { loadSettings } from "../services/settings.ts";
import {
  renderStartupScreen,
  supportsStartupScreen,
  tildify,
} from "../services/startup-screen.ts";
import { TargetAppBuildsLive } from "../services/target-app-builds.ts";
import {
  makeTeachingRecordingStoreLayer,
  TEACHING_RECORDINGS_DIRECTORY,
} from "../services/teaching-recording-store.ts";
import { UiInterface } from "../services/ui-interface.ts";
import {
  resolveAllowedOrigins,
  resolveBrowserUrl,
} from "../services/web-url.ts";

/** The Settings `contingency web` reads. */
export const webConfig = Config.all({
  devUrl: Config.String("DEV_URL").pipe(
    Config.withDefault("http://localhost:5173")
  ),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Number("PORT").pipe(Config.withDefault(7777)),
  publicUrl: Config.String("PUBLIC_URL").pipe(Config.option),
}).pipe(Config.nested("CONTINGENCY_WEB"));

export const webCommand = Command.make(
  "web",
  { noBrowser: Flag.Boolean("no-browser").pipe(Flag.withDefault(false)) },
  Effect.fnUntraced(function* runWeb({ noBrowser }) {
    const isProduction = process.env.NODE_ENV === "production";
    const uiInterface = yield* UiInterface;

    // The Workspace process serves one Catalog Root: it holds Teaching
    // Recordings and persisted Runs, and selecting a different root is an
    // MCP-process concern. Its Settings follow that root (ADR 0063).
    const selectedCatalogRoot = defaultCatalogRoot();
    const settings = yield* loadSettings({
      catalogRoot: selectedCatalogRoot,
      env: process.env,
    });
    for (const warning of settings.warnings) {
      yield* Console.error(warning);
    }
    const config = yield* webConfig.parse(settings.provider);
    const browserUrl = yield* resolveBrowserUrl({ ...config, isProduction });

    return yield* Effect.scoped(
      Effect.gen(function* serveWebInterface() {
        const fileSystem = yield* FileSystem.FileSystem;
        const ownerMarker = yield* prepareAgentResourceDirectory(
          defaultAgentResourceDirectory()
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
        // The Flows Drawer reads this root and the user's global one.
        const catalogBrowser = Layer.succeedContext(
          yield* Layer.build(
            makeCatalogBrowserLayer({
              globalRoot: defaultGlobalCatalogRoot(),
              localRoot: () => selectedCatalogRoot,
            }).pipe(
              Layer.provide(makeFlowCatalogLayer({ root: selectedCatalogRoot }))
            )
          )
        );
        // A Teaching-only process ends no Runs, but it serves their videos
        // and condenses any footage a Run process left unfinished.
        const runVideoRenderer = Layer.succeedContext(
          yield* Layer.build(RunVideoRendererLive)
        );
        const browserSession = Layer.succeedContext(
          yield* Layer.build(
            makeAgentSessionLayer({
              allowedActivity: "teaching",
              baseUrl: browserUrl.origin,
              catalogRoot: () => selectedCatalogRoot,
              resourceDirectory: ownerMarker,
              traceDirectory: () =>
                path.join(selectedCatalogRoot, TEACHING_RECORDINGS_DIRECTORY),
            }).pipe(
              Layer.provide(Layer.merge(runStore, teachingRecordingStore))
            )
          )
        );
        // Uploaded Target App builds, shared by the upload routes and both
        // device workspaces. Closing the process removes any left.
        const targetAppBuilds = Layer.succeedContext(
          yield* Layer.build(TargetAppBuildsLive)
        );
        // Renders device sessions' footage into their videos, and serves
        // their status; one per process, shared by both device workspaces.
        const deviceVideoRenderer = Layer.succeedContext(
          yield* Layer.build(DeviceVideoRendererLive)
        );
        const androidWorkspace = Layer.succeedContext(
          yield* Layer.build(
            makeAndroidWorkspaceLayer({ root: () => selectedCatalogRoot }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  teachingRecordingStore,
                  makeFlowCatalogLayer({ root: selectedCatalogRoot }),
                  targetAppBuilds,
                  deviceVideoRenderer
                )
              )
            )
          )
        );
        const iosWorkspace = Layer.succeedContext(
          yield* Layer.build(
            makeIosWorkspaceLayer({
              root: () => selectedCatalogRoot,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  teachingRecordingStore,
                  makeFlowCatalogLayer({ root: selectedCatalogRoot }),
                  targetAppBuilds,
                  deviceVideoRenderer
                )
              )
            )
          )
        );
        const agentSession = Layer.mergeAll(
          browserSession,
          androidWorkspace,
          iosWorkspace,
          targetAppBuilds,
          deviceVideoRenderer
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
            catalogBrowser,
            host: config.host,
            port: config.port,
            runVideoRenderer,
            serveWebUi: isProduction,
            teachingRecordingStore,
          }).pipe(Layer.provide(agentSession))
        );
        yield* Console.log(
          renderStartupScreen({
            rich: supportsStartupScreen({
              columns: process.stdout.columns,
              env: process.env,
              isTTY: process.stdout.isTTY,
            }),
            screen: {
              hint: "Ctrl+C to close",
              plain: [
                noBrowser
                  ? `Contingency UI available at ${browserUrl}`
                  : `Opening Contingency UI at ${browserUrl}...`,
              ],
              rows: [
                { label: "Workspace", link: true, value: browserUrl.href },
                {
                  label: "Catalog Root",
                  value: tildify(selectedCatalogRoot, homedir()),
                },
                {
                  label: "Docs",
                  link: true,
                  value: new URL(DOCS_SITE_PATH, browserUrl).href,
                },
              ],
              status: noBrowser
                ? "Workspace ready"
                : "Opening the Workspace in your browser",
            },
            version: packageJson.version,
          })
        );
        if (!noBrowser) {
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
