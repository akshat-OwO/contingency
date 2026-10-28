import { Schema } from "effect";

import {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "./android-workspace.ts";
import {
  IosDeviceSelection,
  IosPreparation,
  IosRunEnvironment,
  AndroidStartingCondition,
} from "./platform.ts";

// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSelection = Schema.Struct({
  appPath: Schema.optionalKey(Schema.NonEmptyString),
  device: IosDeviceSelection,
  environment: IosRunEnvironment,
  outcomes: Schema.Array(AndroidStartingCondition).check(Schema.isMinLength(1)),
  setup: IosPreparation,
});
export type IosWorkspaceSelection = typeof IosWorkspaceSelection.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSummary = Schema.Struct({
  ...AndroidWorkspaceSummary.fields,
  selection: IosWorkspaceSelection,
});
export type IosWorkspaceSummary = typeof IosWorkspaceSummary.Type;
// oxlint-disable-next-line eslint/no-redeclare
export const IosWorkspaceSnapshot = Schema.Struct({
  ...AndroidWorkspaceSnapshot.fields,
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
