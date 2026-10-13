import { AndroidWorkspaceCommand } from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AndroidWorkspace } from "./android-workspace.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

// oxlint-disable-next-line unicorn/throw-new-error
class AndroidWorkspaceFailure extends Schema.Error<AndroidWorkspaceFailure>(
  "AndroidWorkspaceFailure"
)({ code: Schema.String, message: Schema.String }) {}

export const AndroidWorkspaceTools = withStrictParameters(
  Toolkit.make(
    Tool.make("agent_android_workspace", {
      dependencies: [AndroidWorkspace],
      description:
        "Opt-in experimental Android lifecycle. Start only with the user's explicitly selected prepared local API 36 emulator and public fixture declarations. Share /?android=<sessionId> as the Workspace link. Teaching is user-led. Workspace owns preparation, decisions, capture Start/Stop, verification, and Takeover. Observe returns semantic nodes without pixels; input uses that observationId and supported reversible actions. Stock screenshots and semantic snapshots are separate captures with experimental host checks. No private Variables, coordinates, arbitrary keys, cross-app or system-dialog permission, automatic replay, or web parity. Learning uses the existing Teaching Recording claim, Timeline, and Flow Skill save tools. Start a fresh dry-run for that saved Android skill; complete names the latest observation and outcome. Takeover and capture gaps prevent passing. Later runs require Android verification. Read retrieves durable summaries after reopening. Cancellation cannot undo dispatched input.",
      failure: AndroidWorkspaceFailure,
      parameters: Schema.Struct({ command: AndroidWorkspaceCommand }),
      success: Schema.Unknown,
    }),
    readOnly(
      Tool.make("agent_android_sessions_list", {
        dependencies: [AndroidWorkspace],
        description:
          "Read retained experimental Android sessions and Run Summaries in this Catalog Root. Does not select or provision a device.",
        failure: AndroidWorkspaceFailure,
        parameters: Tool.EmptyParams,
        success: Schema.Unknown,
      })
    )
  )
);

export const McpAndroidWorkspaceLayer = McpServer.toolkit(
  AndroidWorkspaceTools
).pipe(
  Layer.provide(
    AndroidWorkspaceTools.toLayer({
      agent_android_sessions_list: () =>
        Effect.gen(function* listAndroidSessions() {
          const service = yield* AndroidWorkspace;
          return yield* service.list();
        }).pipe(Effect.mapError((cause) => new AndroidWorkspaceFailure(cause))),
      agent_android_workspace: ({ command }) =>
        Effect.gen(function* driveAndroidWorkspace() {
          const service = yield* AndroidWorkspace;
          return yield* service.execute(command, "agent");
        }).pipe(Effect.mapError((cause) => new AndroidWorkspaceFailure(cause))),
    })
  )
);
