import {
  AndroidWorkspaceCommand,
  IosReturnToTargetAppCommand,
} from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AndroidWorkspace } from "./android-workspace.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

// oxlint-disable-next-line unicorn/throw-new-error
class DeviceWorkspaceFailure extends Schema.Error<DeviceWorkspaceFailure>(
  "DeviceWorkspaceFailure"
)({ code: Schema.String, message: Schema.String }) {}

// MCP encodes data failures as JSON; Error subclasses expose only their message.
const IosSupportMatrixUnproven = Schema.Struct({
  code: Schema.Literal("ios_support_matrix_unproven"),
  message: Schema.String,
});
const failure = Schema.Union([
  DeviceWorkspaceFailure,
  IosSupportMatrixUnproven,
]);
const platform = Schema.Literals(["android", "ios"]);
const requireAndroid = (selected: typeof platform.Type) =>
  selected === "android"
    ? Effect.void
    : Effect.fail({
        code: "ios_support_matrix_unproven" as const,
        message: "iOS is unavailable until its Support Matrix is proven.",
      });

export const DeviceWorkspaceTools = withStrictParameters(
  Toolkit.make(
    Tool.make("agent_device_workspace", {
      dependencies: [AndroidWorkspace],
      description:
        "Android API30-36; iOS unavailable. Workspace /?android=<id>: authorize/prepare/record/Takeover/verify. Input: observationId. Variables: request/supply/input; unreadable=unconfirmed; handoff expires. Learn: claim/Timeline/save, fresh dry-run, verified Run. Complete: latest observation; gaps/Takeover fail. Whole OS. irreversible:true: decide once; retries need fresh Confirmation. Cancellation cannot undo input.",
      failure,
      parameters: Schema.Struct({
        command: Schema.Union(
          [
            ...AndroidWorkspaceCommand.members,
            IosReturnToTargetAppCommand,
          ].filter(
            (member) =>
              !["pick", "field-dismiss", "variable-supply"].includes(
                member.fields._tag.schema.literal
              )
          )
        ),
        platform,
      }),
      success: Schema.Unknown,
    }),
    readOnly(
      Tool.make("agent_device_sessions_list", {
        dependencies: [AndroidWorkspace],
        description:
          "List retained device sessions and Run Summaries. iOS unavailable.",
        failure,
        parameters: Schema.Struct({ platform }),
        success: Schema.Unknown,
      })
    )
  )
);

export const DeviceWorkspaceToolHandlersLive = DeviceWorkspaceTools.toLayer({
  agent_device_sessions_list: ({ platform: selected }) =>
    Effect.gen(function* listAndroidSessions() {
      yield* requireAndroid(selected);
      const service = yield* AndroidWorkspace;
      return yield* service
        .list()
        .pipe(Effect.mapError((cause) => new DeviceWorkspaceFailure(cause)));
    }),
  agent_device_workspace: ({ command, platform: selected }) =>
    Effect.gen(function* driveAndroidWorkspace() {
      yield* requireAndroid(selected);
      if (command._tag === "return-to-target-app") {
        return yield* Effect.fail(
          new DeviceWorkspaceFailure({
            code: "capability_missing",
            message: "Return to Target App is an iOS recovery.",
          })
        );
      }
      const service = yield* AndroidWorkspace;
      return yield* service
        .execute(command, "agent")
        .pipe(Effect.mapError((cause) => new DeviceWorkspaceFailure(cause)));
    }),
});

export const McpDeviceWorkspaceLayer = McpServer.toolkit(
  DeviceWorkspaceTools
).pipe(Layer.provide(DeviceWorkspaceToolHandlersLive));
