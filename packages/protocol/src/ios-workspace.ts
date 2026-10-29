import { Schema } from "effect";

import {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "./android-workspace.ts";
import {
  IosDeviceSelection,
  IosPhysicalDeviceSelection,
  IosPreparation,
  IosRunEnvironment,
  AndroidStartingCondition,
} from "./platform.ts";

// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSelection = Schema.Struct({
  appPath: Schema.optionalKey(Schema.NonEmptyString),
  device: Schema.Union([IosDeviceSelection, IosPhysicalDeviceSelection]),
  environment: IosRunEnvironment,
  outcomes: Schema.Array(AndroidStartingCondition).check(Schema.isMinLength(1)),
  setup: IosPreparation,
});
export type IosWorkspaceSelection = typeof IosWorkspaceSelection.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosObservationRefusal = Schema.Struct({
  code: Schema.Literal("foreign_app_foreground"),
  recovery: Schema.Literal("return-to-target-app"),
});
export type IosObservationRefusal = typeof IosObservationRefusal.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSummary = Schema.Struct({
  ...AndroidWorkspaceSummary.fields,
  refusal: Schema.optionalKey(Schema.NullOr(IosObservationRefusal)),
  selection: IosWorkspaceSelection,
});
export type IosWorkspaceSummary = typeof IosWorkspaceSummary.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSnapshot = Schema.Struct({
  ...AndroidWorkspaceSnapshot.fields,
  refusal: IosWorkspaceSummary.fields.refusal,
  selection: IosWorkspaceSelection,
});
export type IosWorkspaceSnapshot = typeof IosWorkspaceSnapshot.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosReturnToTargetAppCommand = Schema.TaggedStruct(
  "return-to-target-app",
  {
    operationId: AndroidWorkspaceCommand.members[0].fields.operationId,
    sessionId: AndroidWorkspaceSummary.fields.id,
  }
);
const [_androidStart, ...sharedCommands] = AndroidWorkspaceCommand.members;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceCommand = Schema.Union([
  Schema.Struct({
    ...AndroidWorkspaceCommand.members[0].fields,
    selection: IosWorkspaceSelection,
  }),
  ...sharedCommands,
  IosReturnToTargetAppCommand,
]);
export type IosWorkspaceCommand = typeof IosWorkspaceCommand.Type;
