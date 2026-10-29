import {
  AndroidWorkspaceCommand,
  IosReturnToTargetAppCommand,
  IosWorkspaceCommand,
  IosWorkspaceSelection,
} from "@contingency/protocol";
import { Effect, Layer, Option, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AndroidWorkspace } from "./android-workspace.ts";
import { IosWorkspace } from "./ios-workspace.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";

const DeviceWorkspaceFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
const deviceFailure = (cause: typeof DeviceWorkspaceFailure.Type) => ({
  code: cause.code,
  message: cause.message,
});

const available = <A>(service: Effect.Effect<Option.Option<A>>) =>
  service.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            deviceFailure({
              code: "agent_session_unavailable",
              message: "Device Workspace is unavailable in this process.",
            })
          ),
        onSome: Effect.succeed,
      })
    )
  );
const platform = Schema.Literals(["android", "ios"]);
const [androidStart, ...sharedCommands] = AndroidWorkspaceCommand.members;
const start = Schema.Struct({
  ...androidStart.fields,
  selection: Schema.Union([
    androidStart.fields.selection,
    IosWorkspaceSelection,
  ]),
});

export const DeviceWorkspaceTools = withStrictParameters(
  Toolkit.make(
    Tool.make("agent_device_workspace", {
      dependencies: [],
      description:
        "Android API30-36; iOS26-27 simulators. Workspace: /?android=<id> or /?ios=<id>. User prepares/records/verifies. Input needs observationId; unreadable fills=unconfirmed. Learn: claim/Timeline/save, dry-run, verify. Gaps/Takeover fail. iOS Settings needs Return to Target App. irreversible:true needs fresh Confirmation.",
      failure: DeviceWorkspaceFailure,
      parameters: Schema.Struct({
        command: Schema.Union(
          [start, ...sharedCommands, IosReturnToTargetAppCommand].filter(
            (member) =>
              ![
                "pick",
                "field-dismiss",
                "variable-supply",
                "prepare",
                "flow-decision",
              ].includes(member.fields._tag.schema.literal)
          )
        ),
        platform,
      }),
      success: Schema.Unknown,
    }),
    readOnly(
      Tool.make("agent_device_sessions_list", {
        dependencies: [],
        description: "List retained Android or iOS sessions and Run Summaries.",
        failure: DeviceWorkspaceFailure,
        parameters: Schema.Struct({ platform }),
        success: Schema.Unknown,
      })
    )
  )
);

export const DeviceWorkspaceToolHandlersLive = DeviceWorkspaceTools.toLayer({
  agent_device_sessions_list: ({ platform: selected }) =>
    Effect.gen(function* listDeviceSessions() {
      if (selected === "ios") {
        const service = yield* available(Effect.serviceOption(IosWorkspace));
        return yield* service
          .list()
          .pipe(Effect.mapError((cause) => deviceFailure(cause)));
      }
      const service = yield* available(Effect.serviceOption(AndroidWorkspace));
      return yield* service
        .list()
        .pipe(Effect.mapError((cause) => deviceFailure(cause)));
    }),
  agent_device_workspace: ({ command, platform: selected }) =>
    Effect.gen(function* driveDeviceWorkspace() {
      // Decode against the selected platform as well as the compact shared catalog.
      // A valid selection for the other platform must never reach its service.
      if (selected === "ios") {
        const decoded = yield* Schema.decodeUnknownEffect(IosWorkspaceCommand)(
          command
        ).pipe(
          Effect.mapError(() =>
            deviceFailure({
              code: "invalid_selection",
              message: "Invalid iOS Workspace command.",
            })
          )
        );
        const service = yield* available(Effect.serviceOption(IosWorkspace));
        return yield* service
          .execute(decoded, "agent")
          .pipe(Effect.mapError((cause) => deviceFailure(cause)));
      }
      const decoded = yield* Schema.decodeUnknownEffect(
        AndroidWorkspaceCommand
      )(command).pipe(
        Effect.mapError(() =>
          deviceFailure({
            code: "capability_missing",
            message: "Invalid Android Workspace command.",
          })
        )
      );
      const service = yield* available(Effect.serviceOption(AndroidWorkspace));
      return yield* service
        .execute(decoded, "agent")
        .pipe(Effect.mapError((cause) => deviceFailure(cause)));
    }),
});

export const McpDeviceWorkspaceLayer = McpServer.toolkit(
  DeviceWorkspaceTools
).pipe(Layer.provide(DeviceWorkspaceToolHandlersLive));
