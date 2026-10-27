import type { PlatformCapability } from "@contingency/protocol";
import { Schema } from "effect";

export const iosUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
export const IosDeviceSchema = Schema.Struct({
  deviceType: Schema.String.check(
    Schema.isPattern(/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-/u)
  ),
  kind: Schema.Literal("simulator"),
  name: Schema.String,
  runtime: Schema.String,
  runtimeVersion: Schema.String,
  udid: Schema.String.check(Schema.isPattern(iosUuid)),
});
export type IosDevice = typeof IosDeviceSchema.Type;
export const IosAppSchema = Schema.Struct({
  build: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
  label: Schema.String,
  path: Schema.String,
});
export type IosApp = typeof IosAppSchema.Type;
export const IosEnvironmentSchema = Schema.Struct({
  build: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
  deviceType: Schema.NonEmptyString,
  runtimeVersion: Schema.NonEmptyString,
});
export type IosEnvironment = typeof IosEnvironmentSchema.Type;
export interface IosPreparationInput {
  readonly device: IosDevice;
  readonly environment: IosEnvironment;
  /** Omit to copy the installed bundle from the selected simulator. */
  readonly appPath?: string;
  readonly requiredCapabilities: readonly PlatformCapability[];
}
const messages = {
  capability_missing:
    "Private Variables are refused on iOS until a private input transport is proven.",
  cleanup_failed:
    "Could not delete a recorded Session Simulator. Its ownership record is retained for Cleanup.",
  device_mismatch: "The selected simulator identity changed. Select it again.",
  device_unsupported:
    "Explicitly select an iPhone simulator. Physical iPhones and iPads are unsupported.",
  discovery_failed: "Could not read the iOS Simulator inventory.",
  environment_changed:
    "The authorized bundle identifier, build, or runtime changed.",
  host_unsupported: "iOS Simulator requires a local macOS host.",
  os_unsupported: "Select an iPhone simulator running iOS 26 through 27.",
  preparation_failed: "Could not prepare the Session Simulator.",
  runtime_missing: "Install the selected iOS Simulator runtime in Xcode.",
  xcode_missing: "Select a full Xcode installation with xcode-select.",
} as const;
export interface IosError {
  readonly _tag: "IosError";
  readonly code: keyof typeof messages;
  readonly message: string;
}
export const iosError = (code: IosError["code"]): IosError => ({
  _tag: "IosError",
  code,
  message: messages[code],
});
export const isSupportedIosVersion = (version: string) =>
  /^(?:26|27)(?:\.\d+)*$/u.test(version);
