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
  AndroidStartingConditions,
} from "./platform.ts";

// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSelection = Schema.Struct({
  appPath: Schema.optionalKey(Schema.NonEmptyString),
  device: Schema.Union([IosDeviceSelection, IosPhysicalDeviceSelection]),
  environment: IosRunEnvironment,
  outcomes: AndroidStartingConditions,
  setup: IosPreparation,
});
export type IosWorkspaceSelection = typeof IosWorkspaceSelection.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosObservationRefusal = Schema.Union([
  /**
   * The observer could not tell which app is in front, so it never guessed
   * (ADR 0083). Recovery goes Home and carries on from Springboard.
   */
  Schema.Struct({
    code: Schema.Literal("foreground_app_unknown"),
    recovery: Schema.Literal("go-home"),
  }),
  Schema.Struct({
    code: Schema.Literal("capture_incomplete"),
    recovery: Schema.Literal("recover"),
  }),
]);
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
const [_androidStart, ...sharedCommands] = AndroidWorkspaceCommand.members;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceCommand = Schema.Union([
  Schema.Struct({
    ...AndroidWorkspaceCommand.members[0].fields,
    selection: IosWorkspaceSelection,
  }),
  ...sharedCommands,
]);
export type IosWorkspaceCommand = typeof IosWorkspaceCommand.Type;
