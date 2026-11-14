import {
  AndroidWorkspaceCommand,
  DeviceEraseRequestCommand,
  IosReturnToTargetAppCommand,
  IosWorkspaceCommand,
  IosWorkspaceSelection,
} from "@contingency/protocol";
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { AndroidWorkspace } from "./android-workspace.ts";
import { iosUuid } from "./ios-contract.ts";
import { IosWorkspace } from "./ios-workspace.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";
import { OwnedDevices } from "./owned-devices.ts";

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
        "Android API30-36; iOS26-27 simulators. Workspace: /?android=<id> or /?ios=<id>. User prepares/records/verifies. Input needs observationId; unreadable fills=unconfirmed. Learn: claim/Timeline/save, dry-run, verify. Gaps/Takeover fail. iOS Settings needs Return to Target App. irreversible:true needs fresh Confirmation. device-erase-request (device=AVD or UDID) only asks; the user erases in Workspace; repeat its operationId for status.",
      failure: DeviceWorkspaceFailure,
      parameters: Schema.Struct({
        command: Schema.Union(
          [
            start,
            ...sharedCommands,
            IosReturnToTargetAppCommand,
            DeviceEraseRequestCommand,
          ].filter(
            (member) =>
              ![
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
      if (Schema.is(DeviceEraseRequestCommand)(command)) {
        // An agent may only ask. Erasing takes the user's click in
        // Workspace's device step (ADR 0081).
        const valid =
          selected === "ios"
            ? iosUuid.test(command.device)
            : /^[A-Za-z0-9._-]+$/u.test(command.device);
        if (!valid) {
          return yield* Effect.fail(
            deviceFailure({
              code: "invalid_selection",
              message:
                selected === "ios"
                  ? "Name the simulator by its UDID."
                  : "Name the emulator by its AVD.",
            })
          );
        }
        const devices = yield* available(Effect.serviceOption(OwnedDevices));
        const request = yield* devices.requestErase({
          device: command.device,
          operationId: command.operationId,
          platform: selected,
        });
        return {
          ...request,
          next:
            request.status === "pending"
              ? "Ask the user to open a new session in Workspace and choose Erase device on this device. Nothing is erased until they do."
              : undefined,
        };
      }
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
