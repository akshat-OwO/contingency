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
        "Local Android API 30-36, one bound device; require user authorization for the device and app. Share /?android=<sessionId>. Workspace owns prepare, consent, recording, Takeover and verification. Input uses observationId. Private input needs privateInput+pinned helper: variable-request, Workspace supply, input variable. agentSetup:true starts setup; setup-handoff expires its Variables. Learn via Recording claim/Timeline/Flow Skill save; fresh dry-run, verified later Run. Complete with latest observation. Gaps/Takeover cannot pass. No cross-app/system dialogs. Cancellation cannot undo input.",
      failure: AndroidWorkspaceFailure,
      parameters: Schema.Struct({
        command: Schema.Union(
          AndroidWorkspaceCommand.members.filter(
            (member) =>
              !["pick", "field-dismiss", "variable-supply"].includes(
                member.fields._tag.schema.literal
              )
          )
        ),
      }),
      success: Schema.Unknown,
    }),
    readOnly(
      Tool.make("agent_android_sessions_list", {
        dependencies: [AndroidWorkspace],
        description:
          "List retained Android sessions and Run Summaries. No device changes.",
        failure: AndroidWorkspaceFailure,
        parameters: Tool.EmptyParams,
        success: Schema.Unknown,
      })
    )
  )
);

export const AndroidWorkspaceToolHandlersLive = AndroidWorkspaceTools.toLayer({
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
});

export const McpAndroidWorkspaceLayer = McpServer.toolkit(
  AndroidWorkspaceTools
).pipe(Layer.provide(AndroidWorkspaceToolHandlersLive));
