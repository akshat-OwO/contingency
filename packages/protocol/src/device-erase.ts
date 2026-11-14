import { Schema } from "effect";

import { OperationId } from "./agent-identifiers.ts";

/**
 * Device Erase (ADR 0081). A device is named by its AVD on Android and its
 * simulator UDID on iOS.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceErasePlatform = Schema.Literals(["android", "ios"]);
export type DeviceErasePlatform = typeof DeviceErasePlatform.Type;

/**
 * An agent's request to erase a device. Only a Workspace click performs it;
 * the agent reads its status by repeating the request's operationId.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceEraseRequest = Schema.Struct({
  device: Schema.NonEmptyString,
  id: OperationId,
  /** Why the request failed or was dismissed, when it did. */
  message: Schema.optionalKey(Schema.String),
  platform: DeviceErasePlatform,
  requestedAt: Schema.String,
  status: Schema.Literals(["pending", "erased", "dismissed", "failed"]),
});
export type DeviceEraseRequest = typeof DeviceEraseRequest.Type;

/** What Workspace's device step needs to offer Erase Device. */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceEraseState = Schema.Struct({
  /** Devices this process started, which it may stop to erase. */
  owned: Schema.Struct({
    android: Schema.Array(Schema.String),
    ios: Schema.Array(Schema.String),
  }),
  requests: Schema.Array(DeviceEraseRequest),
});
export type DeviceEraseState = typeof DeviceEraseState.Type;

/** The MCP command an agent sends to ask the user for a Device Erase. */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceEraseRequestCommand = Schema.TaggedStruct(
  "device-erase-request",
  {
    /** The AVD name on Android, the simulator UDID on iOS. */
    device: Schema.NonEmptyString,
    operationId: OperationId,
  }
);
export type DeviceEraseRequestCommand = typeof DeviceEraseRequestCommand.Type;
