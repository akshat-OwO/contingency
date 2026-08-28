import path from "node:path";

import type { Flow } from "@contingency/protocol";
import { Config, Console, Effect, FileSystem, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { makeHttpServerLayer } from "../services/http-server.ts";
import { decodeFlowDocument, RunnerError } from "../services/runner.ts";
import { defaultRunsDirectory } from "../services/state-directory.ts";
import { UiInterface } from "../services/ui-interface.ts";
import {
  resolveAllowedOrigins,
  resolveBrowserUrl,
} from "../services/web-url.ts";

export const webCommand = Command.make(
  "web",
  {
    /**
     * The one Flow Audit View audits. Optional, because Create View authors a
     * Flow rather than running one; without it Audit View says there is
     * nothing to run. There is no Flow picker: one Flow, passed as an
     * argument ([ADR 0023](../../../../docs/adr/0023-audit-view-starts-runs.md)).
     */
    flowPath: Argument.file("flow", { mustExist: true }).pipe(
      Argument.optional
    ),
    noBrowser: Flag.boolean("no-browser").pipe(Flag.withDefault(false)),
    output: Flag.string("output").pipe(
      Flag.withDescription(
        "Directory to write Runs into. Defaults to the Contingency state directory."
      ),
      Flag.optional
    ),
  },
  Effect.fnUntraced(function* runWeb({ flowPath, noBrowser, output }) {
    const isProduction = process.env.NODE_ENV === "production";
    const uiInterface = yield* UiInterface;
    const fileSystem = yield* FileSystem.FileSystem;

    // Decoded before the server binds, so a malformed Flow fails here with a
    // message rather than in a browser tab that has nothing to audit.
    let flow: Flow | null = null;
    if (Option.isSome(flowPath)) {
      const resolvedPath = path.resolve(flowPath.value);
      const contents = yield* fileSystem.readFileString(resolvedPath).pipe(
        Effect.mapError(
          (cause) =>
            new RunnerError({
              message: `Could not read ${resolvedPath}: ${cause.message}`,
            })
        )
      );
      flow = yield* decodeFlowDocument(contents, resolvedPath);
    }
    const outputDirectory = Option.isSome(output)
      ? path.resolve(output.value)
      : defaultRunsDirectory();
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
        yield* Layer.build(
          makeHttpServerLayer({
            allowedOrigins: resolveAllowedOrigins(browserUrl),
            host: config.host,
            port: config.port,
            run: { flow, outputDirectory },
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
).pipe(
  Command.withDescription(
    "Open the Contingency web interface. Pass a Flow to audit it."
  )
);
